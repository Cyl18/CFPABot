// src/flows/compare/compare_get_sources.ts
// Flow: compare_get_sources - build compare-source lists (PR head/base + repo main + CurseForge)
// for the Compare tool. Replaces inline algorithm previously in api/frontend/compare.ts.
// Risk: read | Effects: github_read (CurseForge lookup is best-effort read, no side effects)

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { buildRawUrl, buildRawBlobUrl } from "@/client/github/index.js";
import { probeModLangFiles, type LangFileInfo } from "@/client/local-repo.js";
import { findCurseForgeAddon, downloadCurseForgeFile } from "@/client/curseforge-client.js";
import { extractZipEntry } from "@/client/local-repo.js";
import { extractModSet } from "@/flows/_shared/project-path/index.js";

// ─── Input Schema ────────────────────────────────────────────────────

export const compare_get_sources_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  modIdFilter: Type.Optional(Type.String({ description: "Filter mod identities by slug" })),
}, { additionalProperties: false });

export type CompareGetSourcesInput = Static<typeof compare_get_sources_input>;

// ─── Output DTO ──────────────────────────────────────────────────────

const SourceItemSchema = Type.Object({
  path: Type.String(),
  ref: Type.Union([Type.Literal("head"), Type.Literal("base"), Type.Literal("main")]),
  type: Type.Union([Type.Literal("en"), Type.Literal("zh")]),
  url: Type.String(),
});

const CurseForgeItemSchema = Type.Object({
  modName: Type.String(),
  fileUrl: Type.String(),
  entryPath: Type.String(),
  type: Type.Union([Type.Literal("en"), Type.Literal("zh")]),
});

export const compare_get_sources_output = Type.Object({
  prFiles: Type.Array(SourceItemSchema),
  repoFiles: Type.Array(SourceItemSchema),
  curseForgeFiles: Type.Array(CurseForgeItemSchema),
});

export type CompareGetSourcesOutput = Static<typeof compare_get_sources_output>;

// ─── Flow Definition ─────────────────────────────────────────────────

export const compare_get_sources: Flow<typeof compare_get_sources_input, typeof compare_get_sources_output> = {
  name: "compare_get_sources",
  description: "构建 Compare 工具的源文件列表：PR head/base 变更文件、本地仓库 main 分支语言文件、CurseForge 模组文件。",
  input: compare_get_sources_input,
  output: compare_get_sources_output,
  meta: {
    tags: ["compare", "pr"],
    risk: "read",
    effects: ["github_read"],
    timeoutMs: 30_000,
    agent_callable: true,
  },

  execute: async (ctx, input): Promise<CompareGetSourcesOutput> => {
    const { prNumber, modIdFilter } = input;
    const { owner, repoName, defaultBranch } = ctx.config;

    // 1. Fetch PR metadata + changed files in parallel
    const [pr, rawFiles] = await Promise.all([
      ctx.github.getPullRequest(prNumber),
      ctx.github.getPullRequestFiles(prNumber),
    ]);

    const baseSha = pr.base?.sha;
    const baseRef = pr.base?.ref ?? defaultBranch;
    const headSha = pr.head?.sha;
    const headRef = pr.head?.ref ?? defaultBranch;

    // 2. Filter translation files and build head/base source lists
    interface SourceItem { path: string; ref: "head" | "base" | "main"; type: "en" | "zh"; url: string }
    const prItems: SourceItem[] = [];
    const baseItems: SourceItem[] = [];
    const seenPrPaths = new Set<string>();
    const seenBaseBuildPaths = new Set<string>();

    for (const f of rawFiles) {
      const filename = f.filename;
      if (!filename.endsWith(".json") && !filename.endsWith(".lang")) continue;

      const lower = filename.toLowerCase();
      const type: "en" | "zh" =
        lower.includes("zh_cn") || lower.includes("zh-cn") || lower.includes("zh_") ? "zh" : "en";

      if (f.status !== "removed") {
        if (!seenPrPaths.has(filename)) {
          seenPrPaths.add(filename);
          prItems.push({
            path: filename,
            ref: "head",
            type,
            url: headSha
              ? buildRawBlobUrl(owner, repoName, filename, headSha)
              : buildRawUrl(owner, repoName, filename, headRef),
          });
        }
      }
      if (f.status !== "added") {
        if (!seenBaseBuildPaths.has(filename)) {
          seenBaseBuildPaths.add(filename);
          baseItems.push({
            path: filename,
            ref: "base",
            type,
            url: baseSha
              ? buildRawBlobUrl(owner, repoName, filename, baseSha)
              : buildRawUrl(owner, repoName, filename, baseRef),
          });
        }
      }
    }

    // 3. Extract mod identities from all changed paths, filter by modId
    const allChangedPaths = rawFiles.map((f) => f.filename);
    const { identities } = extractModSet(allChangedPaths);
    const filteredIdentities = identities.filter(
      (i) => i.slug !== "minecraft" && (!modIdFilter || i.slug === modIdFilter),
    );

    // 4. Probe repo files for each mod identity (best-effort, errors hidden).
    const repoPromises = filteredIdentities.map(async (identity) => {
      try {
        return await probeModLangFiles(identity.slug, identity.modDomain, ctx.config, {
          gameVersion: identity.gameVersion,
        });
      } catch {
        return [] as LangFileInfo[];
      }
    });
    const repoResults = await Promise.allSettled(repoPromises);
    const repoFileItems: SourceItem[] = [];
    const seenRepoPaths = new Set<string>();
    for (const result of repoResults) {
      if (result.status === "fulfilled") {
        for (const f of result.value) {
          const dedupeKey = `main|${f.path}`;
          if (seenRepoPaths.has(dedupeKey)) continue;
          seenRepoPaths.add(dedupeKey);
          repoFileItems.push({ path: f.path, ref: "main", type: f.type, url: f.url });
        }
      }
    }

    // 5. Combine base ref (from PR diff) + main branch (from local clone), dedupe by path
    const seenBasePaths = new Set<string>();
    const uniqueBaseItems: SourceItem[] = [];
    for (const item of baseItems) {
      const key = `base|${item.path}`;
      if (seenBasePaths.has(key)) continue;
      seenBasePaths.add(key);
      uniqueBaseItems.push(item);
    }
    const repoFiles: SourceItem[] = [...uniqueBaseItems, ...repoFileItems];

    // 6. Query CurseForge (best-effort, only when API key is configured)
    interface CurseForgeItem { modName: string; fileUrl: string; entryPath: string; type: "en" | "zh" }
    const curseForgeFiles: CurseForgeItem[] = [];
    if (process.env.CF_API_KEY) {
      for (const identity of filteredIdentities) {
        try {
          const addon = await findCurseForgeAddon(identity.slug, { timeoutMs: 10_000 });
          const checkedFileIds = new Set<number>();
          for (const file of addon.latestFiles) {
            if (checkedFileIds.has(file.id)) continue;
            checkedFileIds.add(file.id);
            if (!file.downloadUrl || !file.isAvailable) continue;

            for (const mod of file.modules) {
              const enPaths = [
                `assets/${mod.name}/lang/en_us.json`,
                `assets/${mod.name}/lang/en_us.lang`,
              ];
              const zhPaths = [
                `assets/${mod.name}/lang/zh_cn.json`,
                `assets/${mod.name}/lang/zh_cn.lang`,
              ];
              for (const entryPath of enPaths) {
                curseForgeFiles.push({ modName: addon.name, fileUrl: file.downloadUrl, entryPath, type: "en" });
              }
              for (const entryPath of zhPaths) {
                curseForgeFiles.push({ modName: addon.name, fileUrl: file.downloadUrl, entryPath, type: "zh" });
              }
            }
          }
        } catch {
          // CurseForge lookup failure is non-fatal per mod
        }
      }
    }

    return { prFiles: prItems, repoFiles, curseForgeFiles };
  },
};
