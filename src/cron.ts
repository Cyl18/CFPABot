// src/cron.ts
// Unified cron / scheduled task system.
// Runs periodic background tasks via setInterval with staggered immediate-first-run.
import type { Logger } from "./logger.js";
export interface CronTask {
  /** Human-readable task name for logging. */
  name: string;
  /** Interval between runs in milliseconds. */
  intervalMs: number;
  /** Async function to execute on each interval (and once on startup). */
  run: () => Promise<void>;
  /** Optional: if true, skip this run entirely (no "开始" log). */
  shouldSkip?: () => Promise<boolean>;
}

/**
 * Format a millisecond duration as a human-readable Chinese string.
 * Picks the largest unit where the value rounds to ≥ 1.
 * Rounds to at most 1 decimal place; omits decimal for integers.
 */
function formatInterval(ms: number): string {
  const seconds = ms / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  let value: number;
  let unit: string;

  if (Math.round(days) >= 1) {
    value = days;
    unit = "天";
  } else if (Math.round(hours) >= 1) {
    value = hours;
    unit = "小时";
  } else if (Math.round(minutes) >= 1) {
    value = minutes;
    unit = "分钟";
  } else {
    value = seconds;
    unit = "秒";
  }

  const rounded = Math.round(value * 10) / 10;
  if (rounded % 1 === 0) {
    return `${Math.round(rounded)} ${unit}`;
  }
  return `${rounded.toFixed(1)} ${unit}`;
}

/**
 * Start all cron tasks with staggered immediate first runs.
 *
 * Each task runs once immediately (staggered by its index × 5 s), then repeats
 * on its configured interval. Errors are isolated per-task — a failing task
 * does not affect others.
 *
 * @param tasks  Array of cron task definitions.
 * @returns A stop function that clears all intervals and pending startup timeouts.
 */
export function startCronTasks(tasks: CronTask[], logger: Logger): () => void {
  const intervals: Timer[] = [];
  const startupTimeouts: Timer[] = [];
  const running = new Map<CronTask, boolean>();

  function log(message: string): void {
    logger.info({ source: "cron" }, message);
  }

  function logError(message: string, err: unknown): void {
    logger.error({ source: "cron", err }, message);
  }
  async function runSafely(task: CronTask): Promise<void> {
    // Skip if previous run still in progress (prevents overlapping executions)
    if (running.get(task)) {
      log(`${task.name}: 跳过 (上一次仍在运行)`);
      return;
    }
    // 先置位再 await:shouldSkip 是异步的,若其慢于 tick 间隔,两个 tick
    // 都会通过 running 检查而并发执行同一任务(pr-cache-refresh 双刷新)。
    running.set(task, true);

    // Gate check — skip silently if not needed
    if (task.shouldSkip) {
      try {
        if (await task.shouldSkip()) {
          log(`${task.name}: 跳过 (间隔 ${formatInterval(task.intervalMs)})`);
          running.set(task, false);
          return;
        }
      } catch (err) {
        // If the check itself fails, just run the task
        logError(`${task.name}: shouldSkip 检查失败`, err);
      }
    }
    log(`${task.name}: 启动 (间隔 ${formatInterval(task.intervalMs)})`);

    const start = Date.now();
    log(`${task.name}: 开始`);
    try {
      await task.run();
      const elapsed = Date.now() - start;
      log(`${task.name}: 完成 (${elapsed}ms)`);
    } catch (err) {
      const elapsed = Date.now() - start;
      logError(`${task.name}: 失败 (${elapsed}ms)`, err);
    } finally {
      running.set(task, false);
    }
  }

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const staggerMs = i * 5_000;

    const timeout = setTimeout(() => {
      // Immediate first run
      runSafely(task);
      // Periodic repeats
      const timer = setInterval(() => runSafely(task), task.intervalMs);
      intervals.push(timer);
    }, staggerMs);

    startupTimeouts.push(timeout);
  }

  return () => {
    for (const t of startupTimeouts) clearTimeout(t);
    for (const t of intervals) clearInterval(t);
    startupTimeouts.length = 0;
    intervals.length = 0;
    log("所有定时任务已停止");
  };
}
