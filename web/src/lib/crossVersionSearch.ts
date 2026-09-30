import type { CrossVersionIssueKind } from "@shared/api.ts";
import type { SearchPatch } from "@/lib/search.ts";

export type CrossVersionView = "issues" | "keys";
export type CrossVersionKind = CrossVersionIssueKind | "all";

export interface CrossVersionQuery {
  view: CrossVersionView;
  versions: readonly string[] | null;
  kind: CrossVersionKind;
  prOnly: boolean;
  query: string;
  keyQuery: string;
}

const KINDS: readonly CrossVersionKind[] = ["conflict", "changed", "untranslated", "all"];

export function crossVersionQuery(search: Record<string, string | undefined>, pr?: number): CrossVersionQuery {
  const versions = search.versions?.split(",").filter((item) => item !== "") ?? [];
  const kind = search.kind !== undefined && (KINDS as readonly string[]).includes(search.kind) ? (search.kind as CrossVersionKind) : "conflict";
  return {
    view: search.view === "keys" ? "keys" : "issues",
    versions: versions.length === 0 ? null : versions,
    kind,
    prOnly: pr === undefined ? false : search.prOnly !== "0",
    query: search.q ?? "",
    keyQuery: search.kq ?? "",
  };
}

export function crossVersionPatch(next: Partial<CrossVersionQuery>, pr?: number): SearchPatch {
  const patch: Record<string, string | undefined> = {};
  if (next.view !== undefined) patch.view = next.view === "issues" ? undefined : next.view;
  if (next.versions !== undefined) patch.versions = next.versions === null || next.versions.length === 0 ? undefined : next.versions.join(",");
  if (next.kind !== undefined) patch.kind = next.kind === "conflict" ? undefined : next.kind;
  if (next.prOnly !== undefined && pr !== undefined) patch.prOnly = next.prOnly ? undefined : "0";
  if (next.query !== undefined) patch.q = next.query === "" ? undefined : next.query;
  if (next.keyQuery !== undefined) patch.kq = next.keyQuery === "" ? undefined : next.keyQuery;
  return patch;
}
