import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { prRoot } from "../workspace.ts";
import { localDir } from "./local-store.ts";

/** workspace 根上的会话事实：bash 用它拼 export，eval 直接读文件（kernel 不带 CFPA_*）。 */
export const SESSION_ENV_FILE = "cfpa.json";

export function shellPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

export function sessionPaths(
  workspace: string,
  prNumber: number | undefined,
): { root: string; repo: string; work: string; session: string; prNumber?: number; pr?: string } {
  return {
    root: shellPath(paths.root),
    repo: shellPath(paths.repo),
    work: shellPath(paths.work),
    session: shellPath(workspace),
    ...(prNumber === undefined ? {} : { prNumber, pr: shellPath(prRoot(prNumber)) }),
  };
}

export function writeSessionEnv(id: string, prNumber: number | undefined): void {
  const workspace = localDir(id);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, SESSION_ENV_FILE), `${JSON.stringify(sessionPaths(workspace, prNumber), null, 2)}\n`);
}
