import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());

export const paths = {
  root,
  config: join(root, "config"),
  public: join(root, "public"),
  runtime: join(root, "runtime"),
  cache: join(root, "runtime", "cache"),
  state: join(root, "runtime", "state"),
  sessions: join(root, "runtime", "sessions"),
  mirror: join(root, "runtime", "mirror"),
  work: join(root, "runtime", "work"),
  jars: join(root, "runtime", "cache", "jars"),
  piAgent: join(root, "runtime", "pi-agent"),
} as const;

if (process.env.PI_CODING_AGENT_DIR === undefined) process.env.PI_CODING_AGENT_DIR = paths.piAgent;

export function ensureDirs(): void {
  for (const dir of [paths.cache, paths.state, paths.sessions, paths.work, paths.jars, paths.piAgent]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function checkReportPath(prNumber: number, headSha: string): string {
  return join(paths.state, "reports", `${prNumber}-${headSha.slice(0, 7)}.txt`);
}
