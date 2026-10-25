import type { SpecialFilesPage } from "@cfpa/contracts/api";
import { prdata } from "../../prdata.ts";
import { specialContents, specialPairs } from "../../views/special.ts";
import { pageOf } from "../result.ts";
import { nextPageUri } from "../uri.ts";

export interface SpecialOptions {
  keys: string[];
  offset?: number;
  limit?: number;
  withText: boolean;
}

/** 指南类 PR 的主入口：一次内联多对内容，而不是每对一次 read。 */
export async function specialPageOf(n: number, options: SpecialOptions): Promise<SpecialFilesPage> {
  const pairs = await specialPairs(n);
  const known = new Set(pairs.map((pair) => pair.key));
  const missing = options.keys.filter((key) => !known.has(key));
  const selected =
    options.keys.length === 0 ? pairs : pairs.filter((pair) => options.keys.includes(pair.key));
  const page = pageOf(options.offset, options.limit, options.withText ? 12 : 100, options.withText ? 2 : 20);
  const slice = selected.slice(page.offset, page.offset + page.limit);
  let items: SpecialFilesPage["items"] = slice;
  let shown = slice.length;
  if (options.withText) {
    const full = await specialContents(
      n,
      slice.map((pair) => pair.key),
      prdata.fileSource(),
    );
    const kept: SpecialFilesPage["items"] = [];
    let bytes = 0;
    for (const item of full) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (kept.length > 0 && bytes + size > 40_000) break;
      kept.push(item);
      bytes += size;
    }
    items = kept;
    shown = kept.length;
  }
  const nextOffset = page.offset + shown < selected.length ? page.offset + shown : null;
  const params = new URLSearchParams();
  if (options.withText) params.set("include", "text");
  for (const key of options.keys) params.append("keys", key);
  params.set("limit", String(page.limit));
  const next = nextPageUri(`pr://${n}/special-files`, params, nextOffset);
  return {
    prNumber: n,
    total: selected.length,
    offset: page.offset,
    limit: page.limit,
    nextOffset,
    withText: options.withText,
    items,
    ...(missing.length === 0 ? {} : { missing }),
    next,
    hint:
      next === null
        ? `本页 ${shown} 对，已取完 ${selected.length} 对。`
        : `本页 ${shown} 对，还剩 ${selected.length - page.offset - shown} 对；继续 read ${next}`,
  };
}
