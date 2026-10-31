import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { syncGlossary } from "./domain/glossary.ts";
import { pruneDeliveries } from "./deliveries.ts";
import { env } from "./env.ts";
import { logger } from "./log.ts";
import { paths } from "./paths.ts";
import { prdata } from "./prdata.ts";
import { mirror } from "./mirror.ts";
import { mods } from "./mods/index.ts";
import { refreshRepo } from "./workspace.ts";

const log = logger("cron");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const JAR_MAX_AGE_MS = 14 * DAY;

interface CronTask {
  name: string;
  intervalMs: number;
  /** false 表示启动后不立刻跑，等第一个周期（启动阶段已单独处理）。 */
  immediate?: boolean;
  run: () => Promise<unknown>;
}

function pruneJars(): number {
  const cutoff = Date.now() - JAR_MAX_AGE_MS;
  let removed = 0;
  for (const name of readdirSync(paths.jars)) {
    const full = join(paths.jars, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch (err) {
      log.warn("清理 jar 缓存失败", { path: full, err });
    }
  }
  if (removed > 0) log.info("已清理过期 jar 缓存", { removed });
  return removed;
}

export function startCron(): () => void {
  const tasks: CronTask[] = [
    { name: "glossary-sync", intervalMs: DAY, run: () => syncGlossary() },
    { name: "pr-cache-refresh", intervalMs: HOUR, immediate: false, run: () => prdata.refreshAll() },
    { name: "mirror-sync", intervalMs: 6 * HOUR, run: () => mirror.sync() },
    { name: "repo-worktree-refresh", intervalMs: HOUR, run: () => refreshRepo() },
    { name: "jar-cache-prune", intervalMs: DAY, run: () => Promise.resolve(pruneJars()) },
    { name: "webhook-marker-prune", intervalMs: DAY, run: () => pruneDeliveries() },
  ];
  if (env.CURSEFORGE_API_KEY) {
    tasks.push({
      name: "mappings-scan",
      intervalMs: DAY,
      run: async () => {
        for (const slug of await mods.mappings.scan()) mods.invalidate(slug);
      },
    });
  }

  const stops: Array<() => void> = [];
  const running = new Set<string>();

  tasks.forEach((task, index) => {
    const tick = async (): Promise<void> => {
      if (running.has(task.name)) return;
      running.add(task.name);
      try {
        await task.run();
      } catch (err) {
        log.error("定时任务执行失败", { task: task.name, err });
      } finally {
        running.delete(task.name);
      }
    };
    const initial = setTimeout(
      () => {
        void tick();
        const handle = setInterval(() => void tick(), task.intervalMs);
        stops.push(() => clearInterval(handle));
      },
      task.immediate === false ? task.intervalMs : index * 5000,
    );
    stops.push(() => clearTimeout(initial));
  });

  return () => {
    for (const stop of stops) stop();
  };
}
