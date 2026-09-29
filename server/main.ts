import { env } from "./env.ts";
import { logger } from "./log.ts";
import { ensureDirs } from "./paths.ts";
import { prdata } from "./prdata.ts";
import { mirror } from "./mirror.ts";
import { agent } from "./agent/index.ts";
import { drain } from "./bot/index.ts";
import { startCron } from "./cron.ts";
import { app } from "./http/app.ts";

const log = logger("main");

ensureDirs();
await prdata.init();
await agent.init();

void mirror.sync().catch((err: unknown) => log.warn("初始镜像同步失败", { err }));

const stopCron = startCron();
const server = Bun.serve({ port: env.PORT, idleTimeout: 0, fetch: (request) => app.fetch(request) });
log.info("服务已启动", { url: server.url.href, mode: env.NODE_ENV, repo: env.GITHUB_REPO });

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("正在停止服务", { signal });
  stopCron();
  server.stop();
  await Promise.allSettled([drain(), agent.shutdown()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
