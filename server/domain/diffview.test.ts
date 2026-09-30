import { expect, test } from "bun:test";
import { diffFacts, matchesFilter, matchesQuery, type DiffEntry, type DiffLane } from "../../shared/diffview.ts";

function cellsOf(rows: readonly { version: string; en: Map<string, string>; zh?: Map<string, string> }[]): Map<string, DiffEntry> {
  const entries = new Map<string, DiffEntry>();
  for (const row of rows) {
    for (const [key, en] of row.en) {
      const entry = entries.get(key) ?? { key, cells: {} };
      entry.cells[row.version] = { en, zh: row.zh?.get(key) ?? null };
      entries.set(key, entry);
    }
  }
  return entries;
}

const VERSIONS: readonly DiffLane[] = [
  { id: "1.19", label: "1.19", role: "real" },
  { id: "1.20", label: "1.20", role: "real" },
  { id: "1.21", label: "1.21", role: "real" },
  { id: "1.22", label: "1.22", role: "real", zhFile: false, skipZh: true },
];

test("跨版本：同文异译、英文改了、未翻译、缺版本各自归类", () => {
  const entries = cellsOf([
    { version: "1.19", en: new Map([["a", "Stone"], ["b", "Dirt"], ["c", "Old"]]), zh: new Map([["a", "石头"], ["b", "泥土"], ["c", "旧"]]) },
    { version: "1.20", en: new Map([["a", "Stone"], ["b", "Dirt"], ["c", "New"]]), zh: new Map([["a", "石块"], ["c", "新"]]) },
    { version: "1.21", en: new Map([["a", "Stone"], ["b", "Dirt"], ["c", "New"]]), zh: new Map([["a", "石头"], ["b", "泥土"], ["c", "新"]]) },
    { version: "1.22", en: new Map([["a", "Stone"]]) },
  ]);

  // 同一句英文两种译法，1.22 没有中文文件但不参与中文比较
  expect(diffFacts(entries.get("a")!, VERSIONS)).toMatchObject({ missing: null, en: false, zh: true, zhAny: true, untranslated: false, stale: false, differs: true });
  // 1.20 有英文没中文：算未翻译，不算两种译法
  expect(diffFacts(entries.get("b")!, VERSIONS)).toMatchObject({ missing: "partial", en: false, zh: false, zhAny: true, untranslated: true, stale: false, differs: true });
  // 英文改了、译文跟着改：不是同文异译，也不算译文没跟上
  expect(diffFacts(entries.get("c")!, VERSIONS)).toMatchObject({ missing: "partial", en: true, zh: false, zhAny: true, untranslated: false, stale: false, differs: true });
});

test("跨版本：只在部分版本里有的 key 不算文案差异，单独归到部分版本缺", () => {
  const lanes: readonly DiffLane[] = [
    { id: "1.19", label: "1.19", role: "real" },
    { id: "1.20", label: "1.20", role: "real" },
  ];
  const entries = cellsOf([
    { version: "1.19", en: new Map([["a", "Stone"]]), zh: new Map([["a", "石头"]]) },
    { version: "1.20", en: new Map([["b", "Dirt"]]), zh: new Map([["b", "泥土"]]) },
  ]);
  expect(diffFacts(entries.get("a")!, lanes)).toMatchObject({ missing: "partial", en: false, zhAny: false, differs: false });
  expect(matchesFilter(diffFacts(entries.get("a")!, lanes), "diff")).toBe(false);
  expect(matchesFilter(diffFacts(entries.get("a")!, lanes), "missing")).toBe(true);
});

test("跨版本：英文改了但译文照抄旧版本，算译文没跟上", () => {
  const lanes: readonly DiffLane[] = [
    { id: "1.19", label: "1.19", role: "real" },
    { id: "1.20", label: "1.20", role: "real" },
  ];
  const entries = cellsOf([
    { version: "1.19", en: new Map([["a", "Old"]]), zh: new Map([["a", "旧"]]) },
    { version: "1.20", en: new Map([["a", "New"]]), zh: new Map([["a", "旧"]]) },
  ]);
  expect(diffFacts(entries.get("a")!, lanes)).toMatchObject({ en: true, zh: false, stale: true, differs: true });
});

test("PR 翻译比较：新增、删除、补翻译、仍未翻译", () => {
  const lanes: readonly DiffLane[] = [
    { id: "main", label: "main", role: "ref" },
    { id: "pr", label: "PR", role: "real" },
  ];
  const entries: Record<string, DiffEntry> = {
    gone: { key: "gone", cells: { main: { en: "Old", zh: "旧" }, pr: null } },
    added: { key: "added", cells: { main: null, pr: { en: "New", zh: "新" } } },
    fixed: { key: "fixed", cells: { main: { en: "Fix", zh: null }, pr: { en: "Fix", zh: "修好" } } },
    open: { key: "open", cells: { main: { en: "Todo", zh: null }, pr: { en: "Todo", zh: null } } },
    same: { key: "same", cells: { main: { en: "Same", zh: "一样" }, pr: { en: "Same", zh: "一样" } } },
  };

  expect(diffFacts(entries.gone!, lanes)).toMatchObject({ missing: "remove", differs: true, untranslated: false });
  expect(diffFacts(entries.added!, lanes)).toMatchObject({ missing: "add", differs: true });
  // main 是基准侧，不参与未翻译判定：PR 补上了译文就不算未翻译，但也不构成两种译法
  expect(diffFacts(entries.fixed!, lanes)).toMatchObject({ missing: null, zh: false, zhAny: true, differs: true, untranslated: false });
  // 两边都没有中文：不算有差异，但仍是未翻译
  expect(diffFacts(entries.open!, lanes)).toMatchObject({ missing: null, differs: false, untranslated: true });
  expect(diffFacts(entries.same!, lanes)).toMatchObject({ differs: false, untranslated: false });
  expect(matchesFilter(diffFacts(entries.open!, lanes), "diff")).toBe(false);
  expect(matchesFilter(diffFacts(entries.open!, lanes), "untranslated")).toBe(true);
  expect(matchesFilter(diffFacts(entries.same!, lanes), "all")).toBe(true);
});

test("整份没有中文文件的来源不算未翻译，也不产生中文差异", () => {
  const lanes: readonly DiffLane[] = [
    { id: "1.20", label: "1.20", role: "real" },
    { id: "1.21", label: "1.21", role: "real", zhFile: false, skipZh: true },
  ];
  const entries = cellsOf([
    { version: "1.20", en: new Map([["a", "Stone"]]), zh: new Map([["a", "石头"]]) },
    { version: "1.21", en: new Map([["a", "Stone"]]) },
  ]);
  expect(diffFacts(entries.get("a")!, lanes)).toMatchObject({ zh: false, zhAny: false, untranslated: false, differs: false });
});

test("模组 jar 和对照来源的英文不一样才算与模组不一致", () => {
  const lanes: readonly DiffLane[] = [
    { id: "main", label: "main", role: "ref" },
    { id: "pr", label: "PR", role: "real" },
    { id: "jar", label: "模组 jar", role: "extra" },
  ];
  const entries: Record<string, DiffEntry> = {
    same: { key: "same", cells: { main: { en: "A", zh: "甲" }, pr: { en: "A", zh: "甲" }, jar: { en: "A", zh: null } } },
    drift: { key: "drift", cells: { main: { en: "A", zh: "甲" }, pr: { en: "A", zh: "甲" }, jar: { en: "B", zh: null } } },
    absent: { key: "absent", cells: { main: { en: "A", zh: "甲" }, pr: { en: "A", zh: "甲" }, jar: null } },
  };
  expect(diffFacts(entries.same!, lanes)).toMatchObject({ extra: false, differs: false });
  expect(diffFacts(entries.drift!, lanes)).toMatchObject({ extra: true, differs: false });
  expect(diffFacts(entries.absent!, lanes)).toMatchObject({ extra: true, differs: false });
  expect(matchesFilter(diffFacts(entries.drift!, lanes), "extra")).toBe(true);
  expect(matchesFilter(diffFacts(entries.same!, lanes), "extra")).toBe(false);
});

test("搜索覆盖 key、英文和中文", () => {
  const lanes: readonly DiffLane[] = [
    { id: "main", label: "main", role: "ref" },
    { id: "pr", label: "PR", role: "real" },
  ];
  const entry: DiffEntry = { key: "block.foo.bar", cells: { main: { en: "Old name", zh: "旧名" }, pr: { en: "New name", zh: "新名" } } };
  expect(matchesQuery(entry, lanes, "")).toBe(true);
  expect(matchesQuery(entry, lanes, "foo")).toBe(true);
  expect(matchesQuery(entry, lanes, "old")).toBe(true);
  expect(matchesQuery(entry, lanes, "新名")).toBe(true);
  expect(matchesQuery(entry, lanes, "nope")).toBe(false);
});
