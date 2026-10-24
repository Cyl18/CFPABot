import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { repo } from "./env.ts";
import { runGit } from "./git.ts";
import { gh } from "./github/client.ts";
import { logger } from "./log.ts";
import { mirror } from "./mirror.ts";
import { paths } from "./paths.ts";
import { prdata } from "./prdata.ts";
import { withLock } from "./store.ts";

const log = logger("workspace");

/** 仓库相对路径的硬校验：不允许绝对路径、`..`、反斜杠。 */
export function isRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return !path.split("/").includes("..");
}

/** 把相对路径解析到 root 下，越界即抛错。 */
export function resolveInside(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`路径越界：${path}`);
  return target;
}

const WORKTREE_ADMIN = join(paths.mirror, ".git", "worktrees", basename(paths.repo));
const STALE_LOCK_MS = 10 * 60_000;

/** 健康 = 管理目录写完了 index，且没有 worktree add 中断留下的 locked 标记。 */
async function ensureRepoUnlocked(): Promise<string> {
  if (existsSync(join(WORKTREE_ADMIN, "index")) && !existsSync(join(WORKTREE_ADMIN, "locked"))) return paths.repo;
  await mirror.sync();
  await rm(WORKTREE_ADMIN, { recursive: true, force: true });
  await rm(paths.repo, { recursive: true, force: true });
  await mkdir(paths.work, { recursive: true });
  await runGit(paths.mirror, ["worktree", "prune"], null);
  await runGit(paths.mirror, ["worktree", "add", "--detach", paths.repo, repo.defaultBranch], null);
  log.info("仓库工作树已创建", { dir: paths.repo });
  return paths.repo;
}

/** 单次 git 操作上限 180s，超过这个窗口的 index.lock 只可能是被杀掉的进程留下的。 */
async function clearStaleIndexLock(): Promise<void> {
  const lock = join(WORKTREE_ADMIN, "index.lock");
  const info = await stat(lock).catch(() => null);
  if (info === null || Date.now() - info.mtimeMs < STALE_LOCK_MS) return;
  await rm(lock, { force: true });
  log.warn("已清理残留的 git index.lock", { path: lock });
}

export async function repoRoot(): Promise<string> {
  return withLock("mirror", ensureRepoUnlocked);
}

export async function refreshRepo(): Promise<void> {
  await withLock("mirror", async () => {
    const root = await ensureRepoUnlocked();
    await runGit(paths.mirror, ["fetch", "--depth", "1", "origin", repo.defaultBranch], null);
    await runGit(paths.mirror, ["update-ref", `refs/heads/${repo.defaultBranch}`, "FETCH_HEAD"], null);
    await clearStaleIndexLock();
    await runGit(root, ["reset", "--hard", "--quiet", repo.defaultBranch], null);
  });
}

export function prRoot(prNumber: number): string {
  return join(paths.prs, String(prNumber));
}

async function readMarker(prNumber: number): Promise<string | null> {
  return readFile(join(paths.prs, `${prNumber}.head`), "utf8")
    .then((text) => text.trim())
    .catch(() => null);
}

/** PR 改动的文件一次 fetch 拿对象再批量读；mirror 不可用或个别文件缺失时才回退 REST。 */
async function prTexts(prNumber: number, headSha: string, wanted: readonly string[]): Promise<Map<string, string>> {
  const token = await gh.gitToken().catch(() => null);
  const auth = token ? `x-access-token:${token}@` : "";
  try {
    await withLock("mirror", () =>
      runGit(
        paths.mirror,
        [
          "fetch",
          "--depth",
          "1",
          "--no-tags",
          "--no-write-fetch-head",
          // 不带这个会继承 mirror 的 blob:none，一个文件内容都不下来。
          "--filter=blob:limit=10m",
          `https://${auth}github.com/${repo.owner}/${repo.name}.git`,
          `refs/pull/${prNumber}/head`,
        ],
        token,
      ),
    );
    const texts = await mirror.readMany(headSha, wanted);
    const missing = wanted.filter((path) => !texts.has(path));
    if (missing.length > 0) {
      for (const [path, text] of await gh.getFiles(missing, headSha)) texts.set(path, text);
    }
    return texts;
  } catch (err) {
    log.warn("从 mirror 取 PR 文件失败，改走 REST", { prNumber, err });
    return gh.getFiles(wanted, headSha);
  }
}

/** 把 PR 的 head 文件物化到共享目录；同一 PR 多次调用只在 head 变化时重建。 */
export async function ensurePrDir(prNumber: number, headSha: string): Promise<string> {
  if ((await readMarker(prNumber)) === headSha) return prRoot(prNumber);
  return withLock(`pr-worktree:${prNumber}`, async () => {
    if ((await readMarker(prNumber)) === headSha) return prRoot(prNumber);
    const dir = prRoot(prNumber);
    const tmp = `${dir}.tmp`;
    const { files } = await prdata.files(prNumber);
    const wanted = files.filter((file) => file.status !== "removed" && isRepoPath(file.path)).map((file) => file.path);
    const texts = await prTexts(prNumber, headSha, wanted);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    let written = 0;
    for (const path of wanted) {
      const text = texts.get(path);
      if (text === undefined) continue;
      const target = join(tmp, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
      written += 1;
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    await mkdir(paths.prs, { recursive: true });
    await writeFile(join(paths.prs, `${prNumber}.head`), headSha, "utf8");
    await chmod(dir, 0o555).catch(() => undefined);
    log.info("PR 文件已物化", { prNumber, headSha: headSha.slice(0, 7), files: written });
    return dir;
  });
}
