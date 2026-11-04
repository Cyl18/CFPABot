import { describe, expect, test } from "bun:test";
import type { Pack, PackRow, PackWorkspace } from "@cfpa/review-core/pack";
import { reviewRowsForInput } from "./harness/review/rows.ts";
import { withServerFilledFields } from "./harness/review/draft.ts";
import { execPathReason, readPathReason, secretReason } from "./agent/plugins/sandbox.ts";
import { heredocReason } from "./agent/tools/bash.ts";

const EN = "projects/assets/demo/1.20.1/demo/lang/en_us.json";
const ZH = "projects/assets/demo/1.20.1/demo/lang/zh_cn.json";

function row(key: string, headEn: string, headZh: string, line: number, inHunk = true): PackRow {
  return {
    key,
    baseEn: headEn,
    headEn,
    baseZh: headZh,
    headZh,
    headRaw: `    "${key}": "${headZh}",`,
    line,
    inHunk,
    changed: true,
    findings: [],
  };
}

function pack(rows: PackRow[]): Pack {
  const space: PackWorkspace = {
    slug: "demo",
    version: "1.20.1",
    namespace: "demo",
    format: "json",
    enPath: EN,
    zhPath: ZH,
    rows,
    checks: [],
    fileFindings: [],
    duplicates: [{ zh: "甲", keys: ["a", "z"] }],
    counts: { total: rows.length, changed: rows.length, flagged: 0 },
  };

  return {
    prNumber: 7,
    baseSha: "base",
    headSha: "head",
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspaces: [space],
    counts: { workspaces: 1, rows: rows.length, changed: rows.length, flagged: 0 },
  };
}

describe("review rows", () => {
  test("reviewable 只留 changed 且在 hunk 内的行", () => {
    const page = reviewRowsForInput(
      {
        pack: pack([row("a", "A", "甲", 10), row("b", "B", "乙", 20), row("c", "C", "丙", 30, false)]),
        threads: { available: false, headSha: null, pendingReviewId: null, threads: [] },
        terms: null,
        patches: new Map(),
      },
      { filter: "reviewable", include: { terms: false, threads: false, duplicates: false, patch: false } },
    ).page;

    expect(page.total).toBe(2);
    expect(page.rows.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  test("超预算只给 plan，切片链覆盖全部行且每片完整", () => {
    const rows = Array.from({ length: 400 }, (_, index) =>
      row(`k${index}`, "A".repeat(600), "甲".repeat(200), index + 1),
    );
    const input = {
      pack: pack(rows),
      threads: { available: false, headSha: null, pendingReviewId: null, threads: [] },
      terms: null,
      patches: new Map(),
    };
    const options = {
      filter: "reviewable" as const,
      include: { terms: false, threads: false, duplicates: false, patch: false },
    };

    const result = reviewRowsForInput(input, options);

    expect(result.page.rows).toEqual([]);
    expect(result.page.next).toBe(result.plan.slices[0]?.uri ?? null);

    const keys: string[] = [];
    let uri: string | null = result.page.next;
    let pages = 0;

    while (uri !== null) {
      const id = new URL(uri).searchParams.get("slice") ?? "";
      const page = reviewRowsForInput(input, { ...options, slice: id }).page;

      expect(page.complete).toBe(true);
      keys.push(...page.rows.map((entry) => entry.key));
      pages += 1;
      uri = page.next;
    }

    expect(keys).toEqual(rows.map((entry) => entry.key));
    expect(pages).toBe(result.plan.sliceCount);
  });
});

describe("draft 回填", () => {
  test("按 key 定位行、覆盖手写错行，补 en/zh 并去掉 zhNew", async () => {
    const space = pack([row("a", "A", "甲", 41), row("b", "B", "乙", 42)]);
    const payload = JSON.stringify({
      prNumber: 7,
      headSha: "head",
      event: "REQUEST_CHANGES",
      summary: "两处",
      comments: [
        { id: "c1", path: ZH, key: "a", severity: "major", mqm: "accuracy/mistranslation", body: "错", zhNew: "丙" },
        { id: "c2", path: ZH, line: 3, key: "b", mqm: "accuracy/omission", body: "错", zhNew: "丁" },
      ],
    });
    const filled = JSON.parse(await withServerFilledFields(7, payload, space)) as {
      comments: Record<string, unknown>[];
    };

    expect(filled.comments[0]).toMatchObject({ line: 41, en: "A", zh: "甲", suggestion: '    "a": "丙",' });
    expect("zhNew" in (filled.comments[0] ?? {})).toBe(false);
    expect(filled.comments[1]).toMatchObject({ line: 42, severity: "major", suggestion: '    "b": "丁",' });
  });
});

describe("sandbox", () => {
  test("密钥、保留设备名、读取越界与 heredoc 改写都被拦住", () => {
    expect(secretReason({ path: "pr://1/draft", content: "process.env / .env 只是评论正文" })).toBeUndefined();
    expect(secretReason({ command: "printenv" })).toContain("环境变量");
    expect(execPathReason("bash", { command: "make >nul 2>&1" })).toContain("保留设备名");
    expect(execPathReason("bash", { command: "make >/dev/null" })).toBeUndefined();
    expect(readPathReason("read", { path: "artifact://12" }, "D:/ws")).toBeUndefined();
    expect(readPathReason("read", { path: "file:///etc/passwd" }, "D:/ws")).toContain("不在范围内");
    expect(readPathReason("read", { path: "D:/elsewhere/a.txt" }, "D:/ws")).toContain("只读会话 workspace");
    expect(heredocReason("python - <<'EOF'\nprint(1)\nEOF")).toContain("eval");
    expect(heredocReason("cat >> terms.tsv <<'EOF'\n甲\t乙\nEOF")).toContain("write");
    expect(heredocReason("git log --oneline -3")).toBeUndefined();
  });
});
