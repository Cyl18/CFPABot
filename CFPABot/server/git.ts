import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { env } from "./env.ts";
import { gh } from "./github/client.ts";
import { paths } from "./paths.ts";
import { withLock } from "./store.ts";

const BOT_EMAIL = "101878103+cfpa-bot[bot]@users.noreply.github.com";
const GIT_TIMEOUT_MS = 180_000;

export interface Workspace {
  dir: string;
  run(args: string[]): Promise<string>;
  resolve(rel: string): string;
  commit(message: string, coAuthor?: { login: string; id: number }): Promise<string | null>;
  push(): Promise<void>;
}

export async function runGitBytes(cwd: string, args: string[], token: string | null, stdin: Uint8Array | null): Promise<ArrayBuffer> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const detail = token ? err.split(token).join("***") : err;
      throw new Error(`git ${args[0] ?? ""} 失败 (退出码 ${code}): ${detail.trim()}`);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function runGit(cwd: string, args: string[], token: string | null): Promise<string> {
  return new TextDecoder().decode(await runGitBytes(cwd, args, token, null));
}

function makeWorkspace(dir: string, token: string | null): Workspace {
  const run = (args: string[]): Promise<string> => runGit(dir, args, token);
  return {
    dir,
    run,
    resolve(rel) {
      const full = resolve(dir, rel);
      const inner = relative(dir, full);
      if (inner === "" || inner.startsWith("..") || isAbsolute(inner)) throw new Error(`非法工作区路径: ${rel}`);
      return full;
    },
    async commit(message, coAuthor) {
      await run(["add", "-A"]);
      if (!(await run(["diff", "--cached", "--name-only"])).trim()) return null;
      const args = [
        "-c",
        `user.name=${env.BOT_LOGIN}`,
        "-c",
        `user.email=${BOT_EMAIL}`,
        "commit",
        "-m",
        message,
      ];
      if (coAuthor) args.push("-m", `Co-authored-by: ${coAuthor.login} <${coAuthor.id}+${coAuthor.login}@users.noreply.github.com>`);
      await run(args);
      return (await run(["rev-parse", "HEAD"])).trim();
    },
    async push() {
      await run(["push", "origin", "HEAD"]);
    },
  };
}

export async function withWorkspace<T>(
  input: { owner: string; name: string; branch: string; depth?: number },
  fn: (ws: Workspace) => Promise<T>,
): Promise<T> {
  const depth = input.depth ?? 3;
  const token = await gh.gitToken();
  const dir = join(paths.work, randomBytes(8).toString("hex"));
  return withLock(`git-workspace:${input.owner}/${input.name}/${input.branch}`, async () => {
    await mkdir(paths.work, { recursive: true });
    const cloneArgs = ["clone", "--branch", input.branch, "--single-branch"];
    if (depth > 0) cloneArgs.push("--depth", String(depth));
    const reference = await stat(paths.mirror).catch(() => null);
    if (reference?.isDirectory()) cloneArgs.push("--reference-if-able", paths.mirror);
    const auth = token ? `x-access-token:${token}@` : "";
    cloneArgs.push(`https://${auth}github.com/${input.owner}/${input.name}.git`, dir);
    try {
      await runGit(paths.work, cloneArgs, token);
      await runGit(dir, ["config", "user.name", env.BOT_LOGIN], token);
      await runGit(dir, ["config", "user.email", BOT_EMAIL], token);
      return await fn(makeWorkspace(dir, token));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
