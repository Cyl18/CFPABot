// src/flows/info-comment/_internal/collect-mods.ts
// Collector: extract mod links from PR changed files.
// Returns SectionResult<ModLinksData> — handles per-provider failures independently.
// Uses actual CurseForge and Modrinth clients for metadata lookup.

import type { FlowContext } from "@/types.js";
import type { SectionResult, ModLinksData, ModLinkEntry, PublicError } from "../../_shared/types.js";
import { extractModSet } from "../../_shared/project-path/index.js";
import { hashInputs } from "../state.js";
import { loadPrDiff } from "../../_internal/index.js";
import * as curseforge from "@/client/curseforge-client.js";
import * as modrinth from "@/client/modrinth-client.js";

const MOD_TRUNCATE_THRESHOLD = 20;

/**
 * Collect mod links data from PR changed files.
 *
 * 1. Load PR diff to get changed file paths.
 * 2. Parse mod identities from paths using extractModSet().
 * 3. Deduplicate by slug.
 * 4. If > 20 mods, skip remote queries and show summary.
 * 5. For <= 20, try CurseForge first, then Modrinth fallback.
 * 6. Per-mod/provider errors become per-mod errors, not section failure.
 */
export async function collectMods(
  ctx: FlowContext,
  prNumber: number,
  headSha: string,
): Promise<SectionResult<ModLinksData>> {
  // Load PR diff for changed file paths
  let diff;
  try {
    diff = await loadPrDiff(ctx, { prNumber, expectedHeadSha: headSha, maxFiles: 2000 });
  } catch (err: unknown) {
    return {
      status: "error",
      error: {
        code: "DIFF_LOAD_FAILED",
        publicMessage: `无法获取 PR #${prNumber} 的文件变更列表`,
        retryable: true,
      },
      inputHash: hashInputs(String(prNumber), headSha),
    };
  }

  const allPaths = diff.files.map((f) => f.filename);
  const { identities } = extractModSet(allPaths);

  if (identities.length === 0) {
    return {
      status: "empty",
      inputHash: hashInputs(String(prNumber), headSha, ...allPaths.sort()),
    };
  }

  const mods: ModLinkEntry[] = [];
  const errors: PublicError[] = [];
  let truncated = false;

  // Deduplicate by slug
  const seenSlugs = new Set<string>();
  const uniqueIdentities = identities.filter((id) => {
    if (seenSlugs.has(id.slug)) return false;
    seenSlugs.add(id.slug);
    return true;
  });

  // If too many mods, skip remote queries entirely
  if (uniqueIdentities.length > MOD_TRUNCATE_THRESHOLD) {
    truncated = true;
    for (const id of uniqueIdentities) {
      mods.push(basicEntry(id.slug, id.gameVersion, id.modDomain));
    }
  } else {
    // Query metadata per unique slug
    for (const id of uniqueIdentities) {
      try {
        const entry = await queryModMetadata(ctx, id.slug, id.gameVersion, id.modDomain);
        mods.push(entry);
      } catch (err: unknown) {
        errors.push({
          code: "MOD_QUERY_FAILED",
          publicMessage: `无法查询 Mod "${id.slug}" 的详细信息`,
          retryable: true,
        });
        mods.push(basicEntry(id.slug, id.gameVersion, id.modDomain));
      }
    }
  }

  return {
    status: "ready",
    data: { mods, truncated, errors },
    inputHash: hashInputs(String(prNumber), headSha, ...allPaths.sort()),
  };
}

/**
 * Query mod metadata — try CurseForge first, fall back to Modrinth.
 * Both clients are singleton-based and read API keys from env.
 */
async function queryModMetadata(
  ctx: FlowContext,
  slug: string,
  gameVersion: string,
  modDomain: string,
): Promise<ModLinkEntry> {
  // Try CurseForge
  try {
    const cfMod = await curseforge.findCurseForgeAddon(slug, { timeoutMs: 10_000 });
    const latestFile = cfMod.latestFiles?.[0];
    const sourceLink = cfMod.links?.find((l) => l.label === "Source");
    return {
      provider: "curseforge",
      slug,
      projectId: String(cfMod.id),
      name: cfMod.name,
      iconUrl: cfMod.thumbnailUrl ?? undefined,
      projectUrl: cfMod.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${slug}`,
      sourceUrl: sourceLink?.url,
      gameVersions: latestFile?.gameVersions ?? [gameVersion],
      domains: [modDomain],
      dependencies: (latestFile?.dependencies ?? []).map((d) => ({
        name: String(d.modId),
        relation: mapRelation(d.relationType),
      })),
    };
  } catch {
    // CF failed — try Modrinth
  }

  // Fallback to Modrinth
  try {
    const mrMod = await modrinth.getModrinthMod(slug, { timeoutMs: 10_000 });
    return {
      provider: "modrinth",
      slug,
      projectId: mrMod.id,
      name: mrMod.title,
      iconUrl: mrMod.iconUrl ?? undefined,
      projectUrl: `https://modrinth.com/mod/${slug}`,
      sourceUrl: mrMod.sourceUrl ?? undefined,
      gameVersions: mrMod.gameVersions?.length ? mrMod.gameVersions : [gameVersion],
      domains: [modDomain],
      dependencies: [],
    };
  } catch {
    // Both failed — return basic entry
    throw new Error(`Both CurseForge and Modrinth query failed for ${slug}`);
  }
}

function basicEntry(slug: string, gameVersion: string, modDomain: string): ModLinkEntry {
  return {
    provider: "curseforge",
    slug,
    name: slug,
    projectUrl: `https://www.curseforge.com/minecraft/mc-mods/${slug}`,
    gameVersions: [gameVersion],
    domains: [modDomain],
    dependencies: [],
  };
}

function mapRelation(
  type: curseforge.DependencyRelation | undefined,
): "required" | "optional" | "embedded" {
  switch (type) {
    case "requiredDependency":
      return "required";
    case "optionalDependency":
      return "optional";
    case "embeddedLibrary":
      return "embedded";
    default:
      return "optional";
  }
}
