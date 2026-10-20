import { chmodSync, mkdirSync } from "node:fs";
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
  repo: join(root, "runtime", "work", "repo"),
  prs: join(root, "runtime", "work", "pr"),
  jars: join(root, "runtime", "cache", "jars"),
  piAgent: join(root, "runtime", "pi-agent"),
} as const;

if (process.env.PI_CODING_AGENT_DIR === undefined) process.env.PI_CODING_AGENT_DIR = paths.piAgent;

export function ensureDirs(): void {
  for (const dir of [paths.cache, paths.state, paths.sessions, paths.work, paths.jars, paths.piAgent]) {
    mkdirSync(dir, { recursive: true });
  }
  if (process.platform !== "win32") {
    // bash 以 nobody 跑：配置只留 root，sessions 可穿越不可列目录。
    chmodSync(paths.config, 0o700);
    chmodSync(paths.sessions, 0o711);
    for (const file of ["secret.key", "llm.json", "app.pem"]) {
      try {
        chmodSync(join(paths.config, file), 0o600);
      } catch {
        // 文件可能尚未生成
      }
    }
  }
}

export function checkReportPath(prNumber: number, headSha: string): string {
  return join(paths.state, "reports", `${prNumber}-${headSha.slice(0, 7)}.txt`);
}
