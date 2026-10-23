import { join } from "node:path";
import { z } from "zod";
import { env } from "../env.ts";
import { paths } from "../paths.ts";
import { readJson, writeJson, withLock } from "../store.ts";
import { logger } from "../log.ts";
import type { MappingEntry } from "@cfpa/contracts/api";
import { getModsByIds, type CfMod } from "./curseforge.ts";

const log = logger("mods");
const FILE = join(paths.state, "mappings.json");
const BATCH_SIZE = 50;
const DEFAULT_MAX_IDS = 20_000;
const GAME_ID = 432;
const CF_MOD_PREFIX = "https://www.curseforge.com/minecraft/mc-mods/";

const fileSchema = z.object({
  mappings: z.record(z.string(), z.object({ id: z.number(), source: z.enum(["manual", "resolved"]) })).default({}),
  lastScannedId: z.number().default(0),
  updatedAt: z.string().nullable().default(null),
});

type MappingFile = z.infer<typeof fileSchema>;

async function load(): Promise<MappingFile> {
  return (await readJson(FILE, fileSchema)) ?? { mappings: {}, lastScannedId: 0, updatedAt: null };
}

async function save(file: MappingFile, touch: boolean): Promise<void> {
  await writeJson(FILE, { ...file, updatedAt: touch ? new Date().toISOString() : file.updatedAt });
}

function maxMappedId(file: MappingFile): number {
  let max = 0;
  for (const entry of Object.values(file.mappings)) {
    if (entry.id > max) max = entry.id;
  }
  return max;
}

export const mappings = {
  async get(slug: string): Promise<number | undefined> {
    const file = await load();
    return file.mappings[slug]?.id;
  },

  async set(slug: string, id: number): Promise<void> {
    await withLock("mappings", async () => {
      const file = await load();
      file.mappings[slug] = { id, source: "manual" };
      await save(file, true);
    });
  },

  async list(): Promise<MappingEntry[]> {
    const file = await load();
    return Object.entries(file.mappings)
      .map(([slug, entry]) => ({ slug, curseforgeId: entry.id, source: entry.source }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  },

  async stamp(): Promise<string | null> {
    return (await load()).updatedAt;
  },

  async scan(maxIds = DEFAULT_MAX_IDS): Promise<number> {
    if (!env.CURSEFORGE_API_KEY) return 0;
    return withLock("mappings", async () => {
      const file = await load();
      let cursor = Math.max(file.lastScannedId, maxMappedId(file));
      const end = cursor + maxIds;
      let added = 0;
      while (cursor < end) {
        const ids: number[] = [];
        for (let offset = 1; offset <= BATCH_SIZE && cursor + offset <= end; offset++) ids.push(cursor + offset);
        if (ids.length === 0) break;
        let found: CfMod[];
        try {
          found = await getModsByIds(ids);
        } catch (err) {
          log.warn("CurseForge ID 扫描中断", { cursor, err });
          break;
        }
        let dirty = false;
        for (const mod of found) {
          if (mod.gameId !== GAME_ID) continue;
          const website = mod.links?.websiteUrl ?? "";
          if (!website.startsWith(CF_MOD_PREFIX)) continue;
          const slug = mod.slug || website.slice(CF_MOD_PREFIX.length);
          const existing = file.mappings[slug];
          if (existing?.source === "manual") continue;
          if (existing?.id === mod.id) continue;
          if (!existing) added++;
          dirty = true;
          file.mappings[slug] = { id: mod.id, source: "resolved" };
        }
        cursor += ids.length;
        file.lastScannedId = cursor;
        await save(file, dirty);
      }
      return added;
    });
  },
};
