import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "./log.ts";
import { paths } from "./paths.ts";

const log = logger("instance");
const lockFile = join(paths.state, "instance.lock");
const BEAT_MS = 15_000;
const STALE_MS = 45_000;

const lockSchema = z.object({ token: z.string(), pid: z.number(), host: z.string(), at: z.number() });

type InstanceLock = z.infer<typeof lockSchema>;

let beat: ReturnType<typeof setInterval> | undefined;
let token: string | undefined;

function payload(): string {
  return JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() });
}

async function readLock(): Promise<InstanceLock | null> {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(await readFile(lockFile, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(lock: InstanceLock): boolean {
  if (Date.now() - lock.at > STALE_MS) return true;
  // 同主机上进程已消失就立刻接管，否则 --watch 热重启要白等一个 STALE_MS。
  return lock.host === hostname() && !isAlive(lock.pid);
}

export async function acquireInstanceLock(options: { waitMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (options.waitMs ?? 30_000);
  await mkdir(paths.state, { recursive: true });
  for (;;) {
    const current = await readLock();
    if (current && !isStale(current)) {
      if (Date.now() > deadline) {
        throw new Error(`数据目录已被另一个实例占用：pid ${current.pid} @ ${current.host}，拒绝启动`);
      }
      await Bun.sleep(500);
      continue;
    }
    token = crypto.randomUUID();
    try {
      // 接管不是原子的：两个实例同时判定过期时，后写的会覆盖先写的。
      await writeFile(lockFile, payload(), { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await rm(lockFile, { force: true });
    }
  }
  beat = setInterval(() => {
    void writeFile(lockFile, payload(), "utf8").catch(() => {});
  }, BEAT_MS);
  log.info("已取得数据目录独占", { pid: process.pid });
}

export async function releaseInstanceLock(): Promise<void> {
  clearInterval(beat);
  beat = undefined;
  const current = await readLock();
  if (current?.token === token) await rm(lockFile, { force: true });
  token = undefined;
}
