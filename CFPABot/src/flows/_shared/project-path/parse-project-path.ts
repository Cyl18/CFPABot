// src/flows/_shared/project-path/parse-project-path.ts
// PURE: Minecraft mod project path parsing and construction.
// No I/O, no globals, no side effects.

import type { ModProjectPath } from "../types.js";

// Supported path patterns:
//   projects/assets/{slug}/{gameVersion}/{modDomain}/lang/{file}
//   projects/{gameVersion}/{slug}/{modDomain}/lang/{file}    (old format)
//
// Examples:
//   projects/assets/twilightforest/1.21.1/twilightforest/lang/zh_cn.json
//   projects/1.12.2/actuallyadditions/actuallyadditions/lang/zh_cn.lang

const PROJECT_PATH_RE =
  /^projects\/(?:(assets)\/)?([^/]+)\/([^/]+)\/([^/]+)\/lang\/(.+)$/;

/**
 * Parse a Minecraft mod project language file path into its components.
 * Returns `null` if the path does not match a known pattern.
 */
export function parseProjectPath(raw: string): ModProjectPath | null {
  const m = raw.match(PROJECT_PATH_RE);
  if (!m) return null;

  // With "assets" prefix: projects/assets/{slug}/{version}/{domain}/lang/{file}
  // Without "assets": projects/{version}/{slug}/{domain}/lang/{file}
  const hasAssets = m[1] === "assets";

  if (hasAssets) {
    return {
      slug: m[2]!,
      gameVersion: m[3]!,
      modDomain: m[4]!,
      fileName: m[5]!,
      isOldFormat: false,
    };
  }

  return {
    slug: m[3]!,
    gameVersion: m[2]!,
    modDomain: m[4]!,
    fileName: m[5]!,
    isOldFormat: true,
  };
}

/**
 * Build a standard-format project path from its components.
 * Always uses the new `projects/assets/...` format.
 */
export function buildProjectPath(
  slug: string,
  gameVersion: string,
  modDomain: string,
  fileName: string,
): string {
  return `projects/assets/${slug}/${gameVersion}/${modDomain}/lang/${fileName}`;
}

/**
 * Build a language file path for a specific locale (e.g. "zh_cn", "en_us").
 * Convenience wrapper around buildProjectPath.
 */
export function buildLangFilePath(
  slug: string,
  gameVersion: string,
  modDomain: string,
  locale: string,
  format: "json" | "lang" = "json",
): string {
  return buildProjectPath(slug, gameVersion, modDomain, `${locale}.${format}`);
}

/**
 * Returns true when the path looks like a mod language file (zh_cn or en_us).
 */
export function isLangFilePath(path: string): boolean {
  return /\/lang\/(zh_cn|en_us)\.(json|lang)$/i.test(path);
}

/**
 * Returns true when the path is a zh_cn translation file.
 */
export function isChineseTranslationPath(path: string): boolean {
  return /\/lang\/zh_cn\.(json|lang)$/i.test(path);
}

/**
 * Extract the locale from a language file path (e.g. "zh_cn" from ".../lang/zh_cn.json").
 * Returns null if the path doesn't end in a known language file pattern.
 */
export function extractLocale(path: string): string | null {
  const m = path.match(/\/lang\/(.+)\.(json|lang)$/);
  return m ? m[1]! : null;
}

// ─── PR relation helpers ────────────────────────────────────────────

/** A PR that shares a slug with another PR, with the game version. */
export interface PRRelationEntry {
  prNumber: number;
  version: string;
}

/**
 * Format a human-readable warning about related PRs that touch the same mod.
 * Returns null when there are no relations to report.
 */
export function formatRelationsWarning(
  prNumber: number,
  relations: Array<{ prNumber: number; slug: string; versions: string[] }>,
): string | null {
  if (relations.length === 0) return null;

  const lines: string[] = [
    "⚠️ **关联 PR 提醒** - 以下 PR 也修改了相同模组，建议协调合并顺序以避免冲突：",
    "",
  ];

  for (const rel of relations) {
    const versionsStr = rel.versions.length > 0 ? ` (${rel.versions.join(", ")})` : "";
    lines.push(`- PR #${rel.prNumber}: \`${rel.slug}\`${versionsStr}`);
  }

  return lines.join("\n");
}

