// src/flows/_shared/project-path/extract-mod-set.ts
// PURE: Extract the set of unique mod identities from changed file paths.
// No I/O, no globals, no side effects.

import type { ModIdentity, ModPathEntry } from "../types.js";
import { parseProjectPath } from "./parse-project-path.js";

/**
 * Extract mod identities from a list of changed file paths.
 * Filters to only parseable mod language-file paths and deduplicates by
 * (slug, gameVersion, modDomain).
 *
 * Returns both the unique mod identities and the full list of parsed entries.
 */
export function extractModSet(
  changedPaths: string[],
): { identities: ModIdentity[]; entries: ModPathEntry[] } {
  const seen = new Set<string>();
  const identities: ModIdentity[] = [];
  const entries: ModPathEntry[] = [];

  for (const raw of changedPaths) {
    const parsed = parseProjectPath(raw);
    if (!parsed) continue;

    entries.push({ rawPath: raw, parsed });

    const key = `${parsed.slug}:${parsed.gameVersion}:${parsed.modDomain}`;
    if (!seen.has(key)) {
      seen.add(key);
      identities.push({
        slug: parsed.slug,
        gameVersion: parsed.gameVersion,
        modDomain: parsed.modDomain,
      });
    }
  }

  return { identities, entries };
}


