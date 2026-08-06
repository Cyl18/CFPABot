// src/flows/compare/compare_cross_version.ts
// Flow: compare_cross_version — cross-version (main branch) consistency matrix
// for a fixed (slug, namespace): discovers all game versions in the repo clone,
// loads en_us + zh_cn maps per version (missing file => empty), aligns by key union,
// and flags EN/ZH inconsistency across versions plus the "EN same but ZH differs"
// strong signal. Optional ?pr=N filters to the union of keys touched by that PR.
//
// Sources: local clone read (via probeModLangFiles / readRepoFile) primary;
//          GitHub raw fetch (via fetchRawContent) fallback when clone missing.
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { fetchRawContent } from "@/client/github/index.js";
import {
  probeModLangFiles,
  readRepoFile,
  type LangFileInfo,
} from "@/client/local-repo.js";
import { parseProjectPath } from "@/flows/_shared/project-path/index.js";
import { parseTranslationContent } from "@/flows/_shared/language/index.js";
import {
  diffCrossVersionMaps,
  type CrossVersionRow,
  type CrossVersionSummary,
} from "@/flows/_shared/language/index.js";

// ─── Input Schema ────────────────────────────────────────────────────

export const compare_cross_version_input = Type.Object({
  slug: Type.String({ description: "Mod slug (e.g. twilightforest)" }),
  namespace: Type.String({ description: "Mod domain / namespace (e.g. twilightforest)" }),
  prNumber: Type.Optional(
    Type.Number({ description: "Optional PR number — narrow rows to keys touched by this PR" }),
  ),
}, { additionalProperties: false });

export type CompareCrossVersionInput = Static<typeof compare_cross_version_input>;

// ─── Output DTO ──────────────────────────────────────────────────────

const CrossVersionCellSchema = Type.Object({
  en: Type.String(),
  zh: Type.String(),
  enPresent: Type.Boolean(),
  zhPresent: Type.Boolean(),
}, { additionalProperties: false });

const CrossVersionRowSchema = Type.Object({
  key: Type.String(),
  versions: Type.Record(Type.String(), CrossVersionCellSchema),
  enConsistent: Type.Boolean(),
  zhConsistent: Type.Boolean(),
  enSameZhDiffers: Type.Boolean(),
  presentCount: Type.Number(),
  totalVersions: Type.Number(),
}, { additionalProperties: false });

const VersionSummarySchema = Type.Object({
  total: Type.Number(),
  enPresent: Type.Number(),
  zhPresent: Type.Number(),
}, { additionalProperties: false });

export const compare_cross_version_output = Type.Object({
  slug: Type.String(),
  namespace: Type.String(),
  versions: Type.Array(Type.String()),
  rows: Type.Array(CrossVersionRowSchema),
  summary: Type.Object({
    totalKeys: Type.Number(),
    enConsistentKeys: Type.Number(),
    zhConsistentKeys: Type.Number(),
    enSameZhDiffersKeys: Type.Number(),
    perVersion: Type.Record(Type.String(), VersionSummarySchema),
  }),
  prFiltered: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type CompareCrossVersionOutput = Static<typeof compare_cross_version_output>;

// ─── Helpers ─────────────────────────────────────────────────────────

interface VersionMaps {
  version: string;
  en: Record<string, string>;
  zh: Record<string, string>;
}

/** Index probe results by version → {en, zh}. Only matches the target slug+namespace. */
function indexProbeByVersion(
  probe: LangFileInfo[],
  slug: string,
  namespace: string,
): Map<string, { en?: LangFileInfo; zh?: LangFileInfo }> {
  const byVersion = new Map<string, { en?: LangFileInfo; zh?: LangFileInfo }>();
  for (const info of probe) {
    const parsed = parseProjectPath(info.path);
    if (!parsed) continue;
    if (parsed.slug !== slug || parsed.modDomain !== namespace) continue;
    const entry = byVersion.get(parsed.gameVersion) ?? {};
    entry[info.type] = info;
    byVersion.set(parsed.gameVersion, entry);
  }
  return byVersion;
}

/** Load one language map with local clone priority, GitHub raw fallback. */
async function loadMap(
  info: LangFileInfo | undefined,
  owner: string,
  repoName: string,
): Promise<{ map: Record<string, string>; missing: boolean }> {
  if (!info) return { map: {}, missing: true };

  // Primary: local clone read.
  const local = await readRepoFile(info.path);
  if (local !== null) {
    return { map: parseTranslationContent(local), missing: false };
  }

  // Fallback: GitHub raw (this also covers the case where the clone path is
  // missing but the URL is probe-built to main).
  try {
    const text = await fetchRawContent(info.url);
    if (text === null) return { map: {}, missing: true };
    return { map: parseTranslationContent(text), missing: false };
  } catch {
    return { map: {}, missing: true };
  }
}

/**
 * Collect the union of keys from PR-changed lang files that belong to
 * (slug, namespace). Returns null on any failure (skip filter, don't block).
 * Returns an empty set when the PR has no matching lang files (forces empty table).
 */
async function collectPrLangKeySet(
  ctx: FlowContext,
  prNumber: number,
  slug: string,
  namespace: string,
): Promise<Set<string> | null> {
  try {
    const pr = await ctx.github.getPullRequest(prNumber);
    const headSha = pr.head?.sha;
    const files = await ctx.github.getPullRequestFiles(prNumber);

    const langFiles = files.filter((f) => {
      const p = parseProjectPath(f.filename);
      return p?.slug === slug && p?.modDomain === namespace;
    });
    if (langFiles.length === 0) return new Set<string>();

    const keys = new Set<string>();
    for (const f of langFiles) {
      // Removed files contribute no head content.
      if (f.status === "removed" || !headSha) continue;
      const parsed = await ctx.github.fetchFileContent(f.filename, headSha);
      if (parsed) {
        for (const k of Object.keys(parsed)) keys.add(k);
      }
    }
    return keys;
  } catch {
    return null;
  }
}

// ─── Flow Definition ─────────────────────────────────────────────────

export const compare_cross_version: Flow<
  typeof compare_cross_version_input,
  typeof compare_cross_version_output
> = {
  name: "compare_cross_version",
  description:
    "跨版本一致性矩阵：固定 (slug, namespace) 在 main 上所有 version 的 en_us + zh_cn，按 key 对齐并标记 EN/ZH 不一致及 EN 一致但 ZH 不同的强信号。",
  input: compare_cross_version_input,
  output: compare_cross_version_output,
  meta: {
    tags: ["compare"],
    risk: "read",
    effects: ["github_read"],
    timeoutMs: 60_000,
    agent_callable: true,
  },

  execute: async (
    ctx: FlowContext,
    input: CompareCrossVersionInput,
  ): Promise<CompareCrossVersionOutput> => {
    const { slug, namespace, prNumber } = input;
    const { owner, name: repoName } = ctx.repo;
    const config = { owner, repoName };

    if (!namespace) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "namespace is required",
        publicMessage: "缺少 namespace（modDomain）参数。",
      });
    }

    // 1. Probe all lang files for this slug (across all versions) in the
    //    local clone. probeModLangFiles dedups by version+type and only
    //    returns versions that actually have a lang file under this namespace.
    const probe = await probeModLangFiles(slug, namespace, config);
    const byVersion = indexProbeByVersion(probe, slug, namespace);

    // Canonical version order: alphabetical ascending (deterministic).
    const versions = [...byVersion.keys()].sort();

    if (versions.length === 0) {
      return {
        slug,
        namespace,
        versions: [],
        rows: [],
        summary: {
          totalKeys: 0,
          enConsistentKeys: 0,
          zhConsistentKeys: 0,
          enSameZhDiffersKeys: 0,
          perVersion: {},
        },
        prFiltered: prNumber !== undefined,
      };
    }

    // 2. Load en+zh maps per version (parallel within a version).
    const versionMaps: VersionMaps[] = await Promise.all(
      versions.map(async (version) => {
        const entry = byVersion.get(version)!;
        const [enRes, zhRes] = await Promise.all([
          loadMap(entry.en, owner, repoName),
          loadMap(entry.zh, owner, repoName),
        ]);
        return { version, en: enRes.map, zh: zhRes.map };
      }),
    );

    // 3. Build the cross-version matrix.
    let result = diffCrossVersionMaps({ versions: versionMaps });

    // 4. Optional PR filter: narrow rows to the key union of PR-changed lang
    //    files for this slug+namespace.
    let prFiltered: boolean | undefined;
    if (prNumber !== undefined) {
      const keySet = await collectPrLangKeySet(ctx, prNumber, slug, namespace);
      if (keySet !== null) {
        if (keySet.size === 0) {
          result = {
            versions: result.versions,
            rows: [],
            summary: recomputeSummary([], result.versions),
          };
        } else {
          result = {
            ...result,
            rows: result.rows.filter((r) => keySet.has(r.key)),
            summary: recomputeSummary(result.rows, result.versions),
          };
        }
        prFiltered = true;
      } else {
        prFiltered = false;
      }
    }

    return {
      slug,
      namespace,
      versions: result.versions,
      rows: result.rows as CrossVersionRow[],
      summary: result.summary as CrossVersionSummary,
      prFiltered,
    };
  },
};

/**
 * Recompute summary counters from the (possibly filtered) row list.
 * Per-version totals are preserved from the original full result.
 */
function recomputeSummary(
  rows: CrossVersionRow[],
  versions: string[],
): CrossVersionSummary {
  const perVersion: Record<string, { total: number; enPresent: number; zhPresent: number }> = {};
  for (const v of versions) perVersion[v] = { total: 0, enPresent: 0, zhPresent: 0 };
  let enConsistentKeys = 0;
  let zhConsistentKeys = 0;
  let enSameZhDiffersKeys = 0;
  for (const row of rows) {
    if (row.enConsistent) enConsistentKeys++;
    if (row.zhConsistent) zhConsistentKeys++;
    if (row.enSameZhDiffers) enSameZhDiffersKeys++;
    for (const v of versions) {
      const cell = row.versions[v];
      if (!cell) continue;
      if (cell.enPresent || cell.zhPresent) perVersion[v]!.total++;
      if (cell.enPresent) perVersion[v]!.enPresent++;
      if (cell.zhPresent) perVersion[v]!.zhPresent++;
    }
  }
  return {
    totalKeys: rows.length,
    enConsistentKeys,
    zhConsistentKeys,
    enSameZhDiffersKeys,
    perVersion,
  };
}
