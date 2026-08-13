// src/flows/_internal/refresh-mapping.ts
// Cross-domain internal: refresh the CurseForge slug-to-project-ID mapping cache.
// Wraps the existing real logic from cron-tasks/curseforge-mapping.ts.
// No Flow definition — called by the mapping_refresh Flow and eventually by cron.
//
// Current callers:
// - mapping_refresh (src/flows/cache/mapping_refresh.ts)

import type { FlowContext } from "@/types.js";
import { FlowError } from "./types.js";
import { findCurseForgeAddonsByIds } from "@/client/curseforge-client.js";
import { readCurseforgeMapping, writeCurseforgeMapping } from "@/client/cache.js";

export interface MappingRefreshResult {
  added: number;
  updated: number;
  invalid: number;
}

export interface MappingFile {
  mapping: Record<string, number>;
  lastScannedId?: number;
  updatedAt?: string;
}

/** Injectable dependencies for refreshMapping — defaults use real implementations. */
export interface MappingRefreshDeps {
  readMappingFile: () => Promise<MappingFile | null>;
  writeMappingFile: (file: MappingFile) => Promise<void>;
  /** Query CurseForge addons by batch of IDs. */
  queryAddons: (ids: number[]) => Promise<Array<{ slug: string | null; id: number }>>;
}

/** Default implementation using real filesystem and CurseForge API. */
function defaultDeps(): MappingRefreshDeps {
  return {
    readMappingFile: async () => {
      return await readCurseforgeMapping() as MappingFile | null;
    },
    writeMappingFile: async (file: MappingFile) => {
      await writeCurseforgeMapping(file);
    },
    queryAddons: async (ids: number[]) => {
      return await findCurseForgeAddonsByIds(ids);
    },
  };
}

/**
 * Refresh the CurseForge slug→project-ID mapping by scanning forward
 * from the last scanned project ID.
 * @param deps - Optional injected dependencies (for testability).
 */
export async function refreshMapping(
  ctx: FlowContext,
  deps?: Partial<MappingRefreshDeps>,
): Promise<MappingRefreshResult> {
  const { readMappingFile, writeMappingFile, queryAddons } = {
    ...defaultDeps(),
    ...deps,
  };

  const BATCH_SIZE = 50;
  const MAX_IDS_PER_RUN = 20000;

  // 1. Load existing mapping
  let mapping: Record<string, number> = {};
  let lastScannedId = 0;
  const existing = await readMappingFile();
  if (existing) {
    mapping = existing.mapping ?? {};
    lastScannedId = existing.lastScannedId ?? 0;
  }

  // 2. Scan forward from lastScannedId + 1
  let scannedCount = 0;
  let foundCount = 0;
  let newCount = 0;
  let currentId = lastScannedId + 1;

  while (scannedCount < MAX_IDS_PER_RUN) {
    const batchIds: number[] = [];
    for (let i = 0; i < BATCH_SIZE && scannedCount < MAX_IDS_PER_RUN; i++) {
      batchIds.push(currentId);
      currentId++;
      scannedCount++;
    }

    try {
      const addons = await queryAddons(batchIds);
      for (const addon of addons) {
        const slug = addon.slug;
        if (slug) {
          const existingId = mapping[slug];
          mapping[slug] = addon.id;
          if (existingId === undefined) {
            newCount++;
          }
          foundCount++;
        }
      }
    } catch (err: unknown) {
      ctx.logger.warn(
        { batch: batchIds, err: String(err) },
        "refreshMapping: batch query failed, stopping scan",
      );
      // All IDs in this batch failed — likely past the current max CurseForge mod ID.
      // Stop scanning to avoid hammering the API with 404s. The next cron run will retry
      // from the same position and pick up any newly added mods.
      break;
    }
  }

  // 3. Save
  const updatedAt = new Date().toISOString();
  const newLastScannedId = currentId - 1;
  const mappingFile: MappingFile = {
    mapping,
    lastScannedId: newLastScannedId,
    updatedAt,
  };
  await writeMappingFile(mappingFile);

  ctx.logger.info(
    {
      scanned: scannedCount,
      found: foundCount,
      newFound: newCount,
      total: Object.keys(mapping).length,
      lastId: newLastScannedId,
    },
    "refreshMapping: completed",
  );

  return { added: newCount, updated: foundCount - newCount, invalid: 0 };
}
