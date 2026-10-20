import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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

async function ensureRepoUnlocked(): Promise<string> {
  if (existsSync(join(paths.repo, ".git"))) return paths.repo;
  await mirror.sync();
  await rm(paths.repo, { recursive: true, force: true });
  await mkdir(paths.work, { recursive: true });
  await runGit(paths.mirror, ["worktree", "add", "--detach", paths.repo, repo.defaultBranch], null);
  log.info("仓库工作树已创建", { dir: paths.repo });
  return paths.repo;
}

export async function repoRoot(): Promise<string> {
  if (existsSync(join(paths.repo, ".git"))) return paths.repo;
  return withLock("repo-worktree", ensureRepoUnlocked);
}

export async function refreshRepo(): Promise<void> {
  await withLock("repo-worktree", async () => {
    const root = await ensureRepoUnlocked();
    await runGit(paths.mirror, ["fetch", "--depth", "1", "origin", repo.defaultBranch], null);
    await runGit(paths.mirror, ["update-ref", `refs/heads/${repo.defaultBranch}`, "FETCH_HEAD"], null);
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

/** 把 PR 的 head 文件物化到共享目录；同一 PR 多次调用只在 head 变化时重建。 */
export async function ensurePrDir(prNumber: number, headSha: string): Promise<string> {
  if ((await readMarker(prNumber)) === headSha) return prRoot(prNumber);
  return withLock(`pr-worktree:${prNumber}`, async () => {
    if ((await readMarker(prNumber)) === headSha) return prRoot(prNumber);
    const dir = prRoot(prNumber);
    const tmp = `${dir}.tmp`;
    const { files } = await prdata.files(prNumber);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    let written = 0;
    for (const file of files) {
      if (file.status === "removed" || !isRepoPath(file.path)) continue;
      const text = await gh.getFile(file.path, headSha);
      if (text === null) continue;
      const target = join(tmp, file.path);
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
