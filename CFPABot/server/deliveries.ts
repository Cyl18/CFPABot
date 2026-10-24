import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./paths.ts";

const dir = join(paths.state, "webhook");
const TTL_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function isDeliveryId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** 用 O_EXCL 建标记录：并发和跨进程都只有一个能成功。 */
export async function claimDelivery(id: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, `${id}.json`), JSON.stringify({ at: Date.now() }), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export async function releaseDelivery(id: string): Promise<void> {
  await rm(join(dir, `${id}.json`), { force: true });
}

export async function pruneDeliveries(): Promise<number> {
  const names = await readdir(dir).catch(() => []);
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const name of names) {
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (info === null || info.mtimeMs >= cutoff) continue;
    await rm(full, { force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
