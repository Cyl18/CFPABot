import type { PrFile, PrState, PrSummary } from "@cfpa/contracts/api";
import { parseLangPath } from "@cfpa/review-core/domain/path";
import type { GhFile, GhPull } from "../github/types.ts";

/** 视图层需要的文件文本来源；实现由数据层注入，视图不直接碰 GitHub。 */
export interface FileSource {
  read(path: string | null, ref: string): Promise<string | null>;
  readMany(paths: readonly string[], ref: string): Promise<Map<string, string>>;
}

export interface LangEntry {
  slug: string;
  version: string;
}

export function prStateOf(pull: Pick<GhPull, "state" | "merged">): PrState {
  if (pull.state === "open") return "open";
  return pull.merged ? "merged" : "closed";
}

/** 一份 PR 涉及的语言文件条目；删除文件也算涉及，关联 PR 与跨版本视图都靠它。 */
export function langEntriesOf(files: readonly Pick<GhFile, "path">[]): { slugs: string[]; entries: LangEntry[] } {
  const slugs = new Set<string>();
  const entries: LangEntry[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (!parsed) continue;
    slugs.add(parsed.slug);
    const key = `${parsed.slug}\u0000${parsed.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ slug: parsed.slug, version: parsed.version });
  }
  return { slugs: [...slugs].sort(), entries };
}

export function summarizePr(pull: GhPull, slugs: readonly string[]): PrSummary {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.author,
    state: prStateOf(pull),
    draft: pull.draft,
    labels: pull.labels,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    headSha: pull.headSha,
    slugs: [...slugs].sort(),
  };
}

export function sidePaths(file: Pick<PrFile, "status" | "path" | "previousPath">): {
  base: string | null;
  head: string | null;
} {
  return {
    base: file.status === "added" ? null : file.status === "renamed" ? file.previousPath ?? file.path : file.path,
    head: file.status === "removed" ? null : file.path,
  };
}
