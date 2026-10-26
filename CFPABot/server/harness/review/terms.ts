import type { ReviewTermsView, TermGroup, TermVariant } from "@cfpa/contracts/api";
import { lookupTerm, matchTerms, type TermIndex } from "@cfpa/review-core/domain/terms";
import type { Pack } from "@cfpa/review-core/pack";
import { glossaryTerms } from "../../domain/glossary.ts";
import { prdata } from "../../prdata.ts";
import { pageOf } from "../result.ts";
import { nextPageUri } from "../uri.ts";
import { loadPack } from "../pack.ts";

export interface TermsOptions {
  queries: string[];
  changed: boolean;
  offset?: number;
  limit?: number;
  rebuild?: boolean;
}

interface GroupBuilder {
  en: string;
  translations: Map<string, Set<string>>;
  missed: Map<string, TermGroup["missed"][number]>;
  rows: number;
  misses: number;
}

/** 把同一英文在本 PR 里的多种译法与 glossary 权威译法对齐；只给可行动的组。 */
export function aggregateTerms(pack: Pack, index: TermIndex | null, options: TermsOptions): ReviewTermsView {
  const builders = new Map<string, GroupBuilder>();
  let changedRows = 0;
  let missRows = 0;
  for (const workspace of pack.workspaces) {
    for (const row of workspace.rows) {
      if (!row.changed) continue;
      changedRows += 1;
      const en = row.headEn?.trim() ?? "";
      if (en === "") continue;
      const builder = builders.get(en) ?? { en, translations: new Map(), missed: new Map(), rows: 0, misses: 0 };
      builder.rows += 1;
      const zh = row.headZh?.trim() ?? "";
      if (zh !== "") {
        const keys = builder.translations.get(zh) ?? new Set<string>();
        keys.add(row.key);
        builder.translations.set(zh, keys);
      }
      if (index !== null) {
        const hits = matchTerms(index, row.key, row.headEn ?? "", row.headZh ?? "", workspace.version);
        const failed = hits.filter((entry) => !entry.ok);
        if (failed.length > 0) {
          builder.misses += 1;
          missRows += 1;
          for (const entry of failed) {
            const existing = builder.missed.get(entry.en);
            if (existing === undefined) {
              builder.missed.set(entry.en, {
                en: entry.en,
                zh: entry.zh,
                keys: [row.key],
                ...(entry.reason === undefined ? {} : { reason: entry.reason }),
              });
            } else if (!existing.keys.includes(row.key)) {
              existing.keys.push(row.key);
            }
          }
        }
      }
      builders.set(en, builder);
    }
  }

  const groups: TermGroup[] = [];
  for (const builder of builders.values()) {
    if (builder.translations.size <= 1 && builder.misses === 0) continue;
    const inPr: TermVariant[] = [...builder.translations.entries()]
      .map(([zh, keys]) => ({ zh, keys: [...keys].sort(), count: keys.size }))
      .sort((a, b) => b.count - a.count || a.zh.localeCompare(b.zh));
    groups.push({
      en: builder.en,
      inPr,
      missed: [...builder.missed.values()].slice(0, 5),
      rows: builder.rows,
      misses: builder.misses,
    });
  }
  groups.sort(
    (a, b) =>
      Number(b.inPr.length > 1) - Number(a.inPr.length > 1) ||
      b.misses - a.misses ||
      b.inPr.length - a.inPr.length ||
      b.rows - a.rows ||
      a.en.localeCompare(b.en),
  );
  const page = pageOf(options.offset, options.limit, 200, 100);
  let shown = groups.slice(page.offset, page.offset + page.limit);
  let bytes = 0;
  let kept = 0;
  for (const group of shown) {
    const size = Buffer.byteLength(JSON.stringify(group));
    if (kept > 0 && bytes + size > 20_000) break;
    bytes += size;
    kept += 1;
  }
  shown = shown.slice(0, kept);
  const nextOffset = page.offset + shown.length < groups.length ? page.offset + shown.length : null;
  const params = new URLSearchParams();
  for (const term of options.queries) params.append("term", term);
  if (options.changed) params.set("changed", "1");
  params.set("limit", String(page.limit));
  return {
    prNumber: pack.prNumber,
    headSha: pack.headSha,
    glossary: {
      loaded: index !== null,
      size: index?.all.length ?? 0,
    },
    queries: options.queries.map((q) => ({
      q,
      hits: index === null ? [] : lookupTerm(index, q, 8).map((hit) => ({ en: hit.en, zh: hit.zh, ...(hit.reason === undefined ? {} : { reason: hit.reason }) })),
    })),
    groups: shown,
    counts: {
      changedRows,
      groups: groups.length,
      inconsistent: groups.filter((group) => group.inPr.length > 1).length,
      misses: missRows,
    },
    offset: page.offset,
    limit: page.limit,
    nextOffset,
    next: nextPageUri(`pr://${pack.prNumber}/terms`, params, nextOffset),
    hint:
      nextOffset !== null
        ? `还有 ${groups.length - page.offset - shown.length} 组；继续 read ${nextPageUri(`pr://${pack.prNumber}/terms`, params, nextOffset)}`
        : groups.length === 0
          ? "没有发现可行动的术语分歧；逐行证据仍在 rows 的 terms 字段里。"
          : "同词多译与术语缺失都在这里；逐行命中看 rows 的 terms。",
  };
}

export async function termsOf(n: number, options: TermsOptions): Promise<ReviewTermsView> {
  const index = await glossaryTerms();
  if (!options.changed && options.queries.length > 0) {
    const { pull } = await prdata.files(n);
    return {
      prNumber: n,
      headSha: pull.headSha,
      glossary: { loaded: index !== null, size: index?.all.length ?? 0 },
      queries: options.queries.map((q) => ({
        q,
        hits: index === null ? [] : lookupTerm(index, q, 8).map((hit) => ({ en: hit.en, zh: hit.zh, ...(hit.reason === undefined ? {} : { reason: hit.reason }) })),
      })),
      groups: [],
      counts: { changedRows: 0, groups: 0, inconsistent: 0, misses: 0 },
      offset: 0,
      limit: options.limit ?? 100,
      nextOffset: null,
      next: null,
      hint: "只查了 glossary；要看本 PR 的同词多译，加 changed=1。",
    };
  }
  const pack = await loadPack(n, options.rebuild === true);
  return aggregateTerms(pack, index, options);
}
