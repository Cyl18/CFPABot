// src/flows/compare/compare_workspace.ts
// Flow: compare_workspace — four-source (en/zh × base/head) diff for a single
// workspace (slug/version/namespace). Returns aligned CompareWorkspaceRow[]
// plus per-language summary and missing-file meta.
// Risk: read | Effects: github_read
//
// Performs path resolution against the PR's file list so renamed folders/base
// paths (e.g. PR #6026 halcyon↔datanessence) load the actual base path while
// head uses the new path. Files are loaded through the authenticated Contents
// API (loadFileAtRef / loadJsonLangAtRef), never bare raw fetch that silently
// swallows 404s.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import {
  diffWorkspaceMaps,
  parseTranslationContent,
  type CompareWorkspaceRow,
  type WorkspaceSummary,
} from "@/flows/_shared/language/index.js";
import {
  parseProjectPath,
  buildLangFilePath,
  extractLocale,
} from "@/flows/_shared/project-path/parse-project-path.js";
import { loadJsonLangAtRef, loadFileAtRef } from "@/flows/_internal/load-file-at-ref.js";
import type { PullRequestFile } from "@/client/github/types.js";

// ─── Input Schema ────────────────────────────────────────────────────

export const compare_workspace_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  slug: Type.String({ description: "Mod slug (namespace folder name)" }),
  version: Type.String({ description: "Game version folder" }),
  namespace: Type.String({ description: "Namespace (usually matches slug)" }),
}, { additionalProperties: false });

export type CompareWorkspaceInput = Static<typeof compare_workspace_input>;

// ─── Output DTO ──────────────────────────────────────────────────────

// Inline TypeBox mirror of CompareWorkspaceRow so the Flow output schema
// is self-contained (no runtime dependency on a shared DTO).
const CompareWorkspaceRowSchema = Type.Object({
  key: Type.String(),
  oldEnglish: Type.String(),
  newEnglish: Type.String(),
  oldChinese: Type.String(),
  newChinese: Type.String(),
  enStatus: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("modify"), Type.Literal("unchanged")]),
  zhStatus: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("modify"), Type.Literal("unchanged")]),
}, { additionalProperties: false });

const WorkspaceSummarySchema = Type.Object({
  total: Type.Number(),
  en: Type.Object({
    add: Type.Number(),
    remove: Type.Number(),
    modify: Type.Number(),
    unchanged: Type.Number(),
  }),
  zh: Type.Object({
    add: Type.Number(),
    remove: Type.Number(),
    modify: Type.Number(),
    unchanged: Type.Number(),
  }),
}, { additionalProperties: false });

export const compare_workspace_output = Type.Object({
  rows: Type.Array(CompareWorkspaceRowSchema),
  summary: WorkspaceSummarySchema,
  meta: Type.Object({
    workspace: Type.Object({
      slug: Type.String(),
      version: Type.String(),
      namespace: Type.String(),
    }),
    baseSha: Type.String(),
    headSha: Type.String(),
    missingFiles: Type.Array(Type.String()),
  }),
}, { additionalProperties: false });

export type CompareWorkspaceOutput = Static<typeof compare_workspace_output>;

// ─── Path resolution from PR file list ───────────────────────────────

type Locale = "en_us" | "zh_cn";

interface LocaleSource {
  slug: string;
  version: string;
  namespace: string;
}

interface ResolvedLocale {
  locale: Locale;
  /** null when the side genuinely has no file (added/removed). */
  headPath: string | null;
  basePath: string | null;
  format: "json" | "lang";
}

/** Prune a candidate path so trailing slashes/whitespace can't break matching. */
function normalizePath(p: string): string {
  return p.trim().replace(/^\/+/, "");
}

/**
 * Pick, for a locale, the PR file whose path matches this workspace and
 * locale. Honors renamed (previous_filename), added, removed, modified.
 * Falls back to synthesizing the head path when the locale has no entry.
 */
function resolveLocale(prFiles: PullRequestFile[], ws: LocaleSource, locale: Locale): ResolvedLocale {
  const expectedHead = buildLangFilePath(ws.slug, ws.version, ws.namespace, locale, "json");

  const matching = prFiles.filter((f) => {
    const parsed = parseProjectPath(normalizePath(f.filename));
    if (!parsed) return false;
    return parsed.slug === ws.slug
      && parsed.gameVersion === ws.version
      && parsed.modDomain === ws.namespace
      && extractLocale(normalizePath(f.filename)) === locale;
  });

  // Prefer an exact head-path hit, then the first matching entry.
  const file = matching.find((f) => normalizePath(f.filename) === expectedHead) ?? matching[0];

  if (!file) {
    return { locale, headPath: expectedHead, basePath: expectedHead, format: "json" };
  }

  const fileName = normalizePath(file.filename);
  const format: "json" | "lang" = fileName.endsWith(".lang") ? "lang" : "json";

  const loc = extractLocale(fileName) ?? locale;
  const localizedHead = buildLangFilePath(ws.slug, ws.version, ws.namespace, loc, format);
  const headPath = fileName === localizedHead ? localizedHead : fileName;

  const prevRaw = file.previous_filename ? normalizePath(file.previous_filename) : null;

  switch (file.status) {
    case "renamed": {
      const basePath = prevRaw ?? headPath;
      return { locale, headPath, basePath, format };
    }
    case "added": {
      // File only exists at head — base genuinely absent.
      return { locale, headPath, basePath: null, format };
    }
    case "removed": {
      // GitHub keeps the old path on `filename`; head does not exist.
      return { locale, headPath: null, basePath: headPath, format };
    }
    case "modified":
    case "changed":
    default: {
      return { locale, headPath, basePath: headPath, format };
    }
  }
}

// ─── Authenticated loading ───────────────────────────────────────────

/**
 * Load + parse one language map through the authenticated Contents API.
 * Returns null (→ empty map, missing:true) on genuine absent content;
 * logs a warn line for every missing/failed load (never silent).
 */
async function loadOneSide(
  ctx: FlowContext,
  path: string | null,
  ref: string,
  format: "json" | "lang",
  label: string,
): Promise<{ map: Record<string, string>; missing: boolean }> {
  if (!path) return { map: {}, missing: true };

  try {
    if (format === "json") {
      const result = await loadJsonLangAtRef(ctx, path, ref);
      if (result === null) {
        ctx.logger.warn({ path, ref, label }, "compare_workspace: 语言文件不可用");
        return { map: {}, missing: true };
      }
      return { map: result, missing: false };
    }

    const file = await loadFileAtRef(ctx, { path, ref });
    if (file.content === null) {
      ctx.logger.warn({ path, ref, label }, "compare_workspace: 语言文件不可用");
      return { map: {}, missing: true };
    }
    return { map: parseTranslationContent(file.content), missing: false };
  } catch (err) {
    ctx.logger.warn(
      { path, ref, label, err: err instanceof Error ? err.message : String(err) },
      "compare_workspace: 语言文件加载失败",
    );
    return { map: {}, missing: true };
  }
}

// ─── Flow Definition ─────────────────────────────────────────────────

export const compare_workspace: Flow<
  typeof compare_workspace_input,
  typeof compare_workspace_output
> = {
  name: "compare_workspace",
  description: "四源工作区对比：PR base/head × en_us/zh_cn，返回对齐行 + 双语 status 摘要。",
  input: compare_workspace_input,
  output: compare_workspace_output,
  meta: {
    tags: ["compare"],
    risk: "read",
    effects: ["github_read"],
    timeoutMs: 30_000,
    agent_callable: true,
  },

  execute: async (ctx, input): Promise<CompareWorkspaceOutput> => {
    const { prNumber, slug, version, namespace } = input;

    // 1. Load PR metadata for base/head SHAs.
    const pr = await ctx.github.getPullRequest(prNumber);
    const baseSha = pr.base?.sha ?? "";
    const headSha = pr.head?.sha ?? "";

    if (!baseSha || !headSha) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `PR ${prNumber} missing base/head SHA`,
        publicMessage: `PR ${prNumber} 缺少 base 或 head SHA，无法构建对比。`,
      });
    }

    // Resolve per-locale base/head paths against the PR's file list. This is
    // what lets renamed folders (PR #6026 halcyon↔datanessence) load base from
    // the previous path while head uses the new path.
    const prFiles = await ctx.github.getPullRequestFiles(prNumber);
    const ws: LocaleSource = { slug, version, namespace };
    const resolved = (["en_us", "zh_cn"] as const).map((locale) =>
      resolveLocale(prFiles, ws, locale),
    );

    const loads = await Promise.all(resolved.map(async (r) => {
      const [base, head] = await Promise.all([
        loadOneSide(ctx, r.basePath, baseSha, r.format, `${r.locale} (base)`),
        loadOneSide(ctx, r.headPath, headSha, r.format, `${r.locale} (head)`),
      ]);
      return { locale: r.locale, base, head };
    }));
    const byLocale = new Map(loads.map((l) => [l.locale, l] as const));

    const en = byLocale.get("en_us")!;
    const zh = byLocale.get("zh_cn")!;

    const missingFiles: string[] = [];
    for (const l of loads) {
      if (l.base.missing) missingFiles.push(`${l.locale} (base)`);
      if (l.head.missing) missingFiles.push(`${l.locale} (head)`);
    }

    // 2. Run the pure diff.
    const { rows, summary } = diffWorkspaceMaps({
      enOld: en.base.map,
      enNew: en.head.map,
      zhOld: zh.base.map,
      zhNew: zh.head.map,
    });

    return {
      rows: rows as CompareWorkspaceRow[],
      summary: summary as WorkspaceSummary,
      meta: {
        workspace: { slug, version, namespace },
        baseSha,
        headSha,
        missingFiles,
      },
    };
  },
};
