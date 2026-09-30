import { isDiffFilter, type DiffFilter } from "@shared/diffview.ts";
import type { SearchPatch } from "@/lib/search.ts";

export interface CrossVersionQuery {
  versions: readonly string[] | null;
  filter: DiffFilter;
  prOnly: boolean;
  query: string;
}

export function crossVersionQuery(search: Record<string, string | undefined>, pr?: number): CrossVersionQuery {
  const versions = search.versions?.split(",").filter((item) => item !== "") ?? [];
  return {
    versions: versions.length === 0 ? null : versions,
    filter: isDiffFilter(search.filter) ? search.filter : "diff",
    prOnly: pr === undefined ? false : search.prOnly !== "0",
    query: search.q ?? "",
  };
}

export function crossVersionPatch(next: Partial<CrossVersionQuery>, pr?: number): SearchPatch {
  const patch: Record<string, string | undefined> = {};
  if (next.versions !== undefined) {
    patch.versions = next.versions === null || next.versions.length === 0 ? undefined : next.versions.join(",");
  }
  if (next.filter !== undefined) patch.filter = next.filter === "diff" ? undefined : next.filter;
  if (next.prOnly !== undefined && pr !== undefined) patch.prOnly = next.prOnly ? undefined : "0";
  if (next.query !== undefined) patch.q = next.query === "" ? undefined : next.query;
  return patch;
}
