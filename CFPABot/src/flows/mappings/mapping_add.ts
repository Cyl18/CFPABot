// src/flows/mappings/mapping_add.ts
// Flow: mapping_add — add a slug-to-project-ID mapping for CurseForge.
// Risk: repository_write | Effects: storage_write
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §8.3
//
// Does NOT use a git workspace — validates the remote project then
// atomically persists the mapping to local storage.
// No generic file_write exposed — all persistence is contained within
// this Flow's atomic read-validate-write cycle.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { findCurseForgeAddon } from "@/client/curseforge-client.js";
import { readCurseforgeMapping, writeCurseforgeMapping } from "@/client/cache.js";


interface MappingFile {
  mapping: Record<string, number>;
  lastScannedId?: number;
  updatedAt?: string;
}

// ─── Input Schema ──────────────────────────────────────────────────────

export const mapping_add_input = Type.Object({
  slug: Type.String({ description: "CurseForge project slug" }),
  projectId: Type.Number({ description: "CurseForge numeric project ID" }),
  provider: Type.Literal("curseforge", {
    description: "Provider — currently only CurseForge is supported for mapping",
  }),
});

export type MappingAddInput = Static<typeof mapping_add_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const mapping_add_output = Type.Object({
  slug: Type.String({ description: "The slug that was mapped" }),
  projectId: Type.Number({ description: "The project ID that was mapped" }),
  revision: Type.Number({
    description: "Total number of entries in the mapping after adding this one",
  }),
});

export type MappingAddOutput = Static<typeof mapping_add_output>;

// ─── Internal: load & save mapping atomically ───────────────────────────
//
// Uses cache.ts helpers which wrap durable-json (writeJsonLocked) for atomic
// writes with Windows EPERM/EBUSY retry and process-level locking.

async function loadMapping(): Promise<MappingFile> {
  const existing = await readCurseforgeMapping();
  return existing ?? { mapping: {} };
}

async function saveMapping(mappingFile: MappingFile): Promise<void> {
  await writeCurseforgeMapping(mappingFile);
}

// ─── Flow Definition ───────────────────────────────────────────────────

export const mapping_add: Flow<
  typeof mapping_add_input,
  typeof mapping_add_output
> = {
  name: "mapping_add",
  description:
    "Add a CurseForge slug-to-project-ID mapping entry. " +
    "Validates the project exists remotely via the CurseForge API before persisting. " +
    "Reports conflicts when the slug is already mapped to a different project ID. " +
    "Atomic write: temp file + rename to prevent partial writes. " +
    "Does not modify GitHub — only updates local storage. " +
    "Does not force-refresh info comments; downstream actions are the caller's responsibility.",
  input: mapping_add_input,
  output: mapping_add_output,
  meta: {
    tags: ["mappings", "mutation", "curseforge", "storage_write"],
    risk: "repository_write",
    effects: ["storage_write"],
    timeoutMs: 60_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:mapping_add:${input.slug}`,
    agent_callable: false,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof mapping_add_input>,
  ): Promise<Static<typeof mapping_add_output>> {
    const { slug, projectId, provider } = input;

    // ── Step 1: Validate the project exists remotely ────────────────────
    let remoteProjectId: number;
    try {
      if (provider === "curseforge") {
        const addon = await findCurseForgeAddon(slug, { timeoutMs: 30_000 });
        remoteProjectId = addon.id;
      } else {
        throw new FlowError({
          code: "INVALID_INPUT",
          message: `Unsupported provider: ${provider}`,
          publicMessage: `Provider "${provider}" is not supported. Only CurseForge is currently supported for mapping.`,
          retryable: false,
        });
      }
    } catch (err: unknown) {
      if (err instanceof FlowError) throw err;
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `Failed to validate slug: ${(err as Error).message}`,
        publicMessage: `Could not validate slug "${slug}" on ${provider}. The API may be unavailable or the project may not exist.`,
        retryable: true,
      });
    }

    // Verify that the remote ID matches the provided projectId
    if (remoteProjectId !== projectId) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Remote project ID ${remoteProjectId} does not match provided ${projectId} for slug ${slug}`,
        publicMessage: `The project "${slug}" has ID ${remoteProjectId} on ${provider}, but you provided ${projectId}. Check the project ID and try again.`,
        retryable: false,
      });
    }

    // ── Step 2: Atomically load, validate conflict, persist ────────────
    const mappingFile = await loadMapping();
    const existing = mappingFile.mapping[slug];

    if (existing !== undefined && existing !== projectId) {
      throw new FlowError({
        code: "CONFLICT",
        message: `Slug "${slug}" already mapped to project ID ${existing}, cannot overwrite with ${projectId}`,
        publicMessage: `Slug "${slug}" is already mapped to project ID ${existing}. To update, remove the existing mapping first.`,
        retryable: false,
      });
    }

    // Idempotent: if already mapped to the same ID, return current revision
    if (existing === projectId) {
      const revision = Object.keys(mappingFile.mapping).length;
      return { slug, projectId, revision };
    }

    // Add the new mapping
    mappingFile.mapping[slug] = projectId;
    mappingFile.updatedAt = new Date().toISOString();

    await saveMapping(mappingFile);

    const revision = Object.keys(mappingFile.mapping).length;

    ctx.logger.info(
      { slug, projectId, provider: "curseforge", revision },
      "Mapping added",
    );

    return { slug, projectId, revision };
  },
};
