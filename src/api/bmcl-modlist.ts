// src/api/bmcl-modlist.ts
// BMCL / BakaXL ModList API — serves structured mod list for third-party launchers.
// Data sourced from runtime/cache/modlist.json (produced by modlist-refresh cron).
import { Hono } from "hono";

import { readModlistCache, readCurseforgeMapping } from "@/client/cache.js";
import type { ModlistCacheFile, CfMappingFile } from "@/client/cache.js";

// ---- Types (matching BMCL/BakaXL spec) ----

interface VersionEntry {
  version: string;
  loader: string;
  repoLink: string;
}

interface ModListEntry {
  modSlug: string;
  modName: string;
  modDomain: string;
  curseForgeLink: string;
  versions: VersionEntry[];
}

interface BMCLModListResponse {
  modlist: ModListEntry[];
  lastUpdate: string;
}

// ---- In-memory cache ----

let cachedResponse: BMCLModListResponse | null = null;
let cacheFetchedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute (modlist refreshes on push webhook + every 24h cron)

// ---- Helpers ----

function buildCurseForgeLink(slug: string, cfId: number): string {
  // Prefer slug-based URL (stable, redirects resolve to correct page)
  return `https://www.curseforge.com/minecraft/mc-mods/${slug}`;
}

async function loadModlistData(): Promise<BMCLModListResponse> {
  // 1. Read modlist.json (refreshed on push webhook + every 24h cron)
  const raw = await readModlistCache();

  if (!raw) {
    return { modlist: [], lastUpdate: new Date().toISOString() };
  }

  // 2. Read curseforge-mapping.json for slug → CF ID
  const cfMapping: Record<string, number> = {};
  const mapping = await readCurseforgeMapping();
  if (mapping) {
    Object.assign(cfMapping, mapping.mapping);
  }

  // 3. Transform to BMCL/BakaXL spec format
  const modlist: ModListEntry[] = raw.data.map((entry) => {
    const cfId = cfMapping[entry.slug] ?? entry.cfId ?? 0;
    return {
      modSlug: entry.slug,
      modName: entry.name || entry.slug,
      modDomain: entry.slug,
      curseForgeLink: buildCurseForgeLink(entry.slug, cfId),
      versions: entry.versions.map((v) => ({
        version: v,
        loader: "Forge",
        repoLink: `projects/assets/${entry.slug}/${v}`,
      })),
    };
  });

  return {
    modlist,
    lastUpdate: raw.updatedAt,
  };
}

// ---- Router ----

export const bmclModlistRouter = new Hono();

// GET /api/bakaxl/modlist — full mod list JSON
bmclModlistRouter.get("/bakaxl/modlist", async (c) => {
  if (cachedResponse && Date.now() - cacheFetchedAt < CACHE_TTL_MS) {
    return c.json(cachedResponse);
  }

  cachedResponse = await loadModlistData();
  cacheFetchedAt = Date.now();
  return c.json(cachedResponse);
});

// GET /api/bmcl/modlist — permanent redirect to BakaXL endpoint
bmclModlistRouter.get("/bmcl/modlist", (c) => {
  return c.redirect("/api/bakaxl/modlist", 301);
});
