import { describe, expect, test } from "bun:test";
import type { TermTable } from "@cfpa/contracts/api";
import { renderReviewBody, draftInputSchema, validateDraft } from "@cfpa/review-core/draft";
import { buildTermIndex } from "@cfpa/review-core/domain/terms";
import {
  extractTermCandidates,
  parseTermInput,
  renderTermBlock,
  renderSliceTerms,
  validateTermTable,
} from "@cfpa/review-core/domain/term-table";
import type { Pack } from "@cfpa/review-core/pack";
import { composeWorkPack, normalizeSliceDoc } from "./review/workpack.ts";
import { prepareDraft } from "./review/draft.ts";

const pack: Pack = {
  prNumber: 42,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  generatedAt: "2026-01-01T00:00:00.000Z",
  workspaces: [
    {
      slug: "example",
      version: "1.20.1",
      namespace: "mod",
      format: "json",
      enPath: "en_us.json",
      zhPath: "zh_cn.json",
      rows: [
        {
          key: "item.mod.life_essence",
          headEn: "Life Essence",
          headZh: "生命精华",
          line: 1,
          inHunk: true,
          changed: true,
          findings: [],
        },
        {
          key: "block.mod.catalyst",
          headEn: "Catalyst",
          headZh: "催化剂",
          line: 2,
          inHunk: true,
          changed: true,
          findings: [],
        },
        {
          key: "gui.mod.catalyst",
          headEn: "Catalyst",
          headZh: "触媒",
          line: 3,
          inHunk: true,
          changed: true,
          findings: [],
        },
        {
          key: "gui.mod.sentence",
          headEn: "This sentence is far too long to be treated as a term",
          headZh: "这句话太长了",
          line: 4,
          inHunk: true,
          changed: true,
          findings: [],
        },
        {
          key: "tooltip.mod.life",
          headEn: "Life Essence",
          headZh: "生命精华",
          line: 5,
          inHunk: false,
          changed: false,
          findings: [],
        },
      ],
      checks: [],
      fileFindings: [],
      duplicates: [],
      counts: { total: 5, changed: 4, flagged: 0 },
    },
  ],
  counts: { workspaces: 1, rows: 5, changed: 4, flagged: 0 },
};

const index = buildTermIndex({ "terms-v1.tsv": "en\tzh\nLife Essence\t生命源质\n" });

describe("extractTermCandidates", () => {
  test("注册名出现一次就进候选，并带全文上下文", () => {
    const life = extractTermCandidates(pack, index).find((entry) => entry.en === "Life Essence");
    expect(life?.count).toBe(1);
    expect(life?.contexts.map((context) => context.key)).toEqual(["item.mod.life_essence", "tooltip.mod.life"]);
    expect(life?.suggest).toBe("lock");
    expect(life?.vanilla?.zh).toEqual(["生命源质"]);
  });

  test("重复词进候选，多译法标 pending", () => {
    const catalyst = extractTermCandidates(pack, index).find((entry) => entry.en === "Catalyst");
    expect(catalyst?.count).toBe(2);
    expect(catalyst?.inPr.map((variant) => variant.zh).sort()).toEqual(["触媒", "催化剂"].sort());
    expect(catalyst?.suggest).toBe("pending");
  });

  test("长句不进候选", () => {
    expect(extractTermCandidates(pack, index).some((entry) => entry.en.includes("far too long"))).toBe(false);
  });
});

describe("validateTermTable", () => {
  const table: TermTable = {
    prNumber: 42,
    headSha: "a".repeat(40),
    updatedAt: "2026-01-01T00:00:00.000Z",
    terms: [{ en: "Life Essence", zh: "生命源质", bucket: "lock", source: "zh_cn_cfpa: 2 例" }],
  };

  test("合法表无错", () => {
    expect(validateTermTable(table, pack)).toEqual([]);
  });

  test("换 head 打回", () => {
    expect(validateTermTable({ ...table, headSha: "c".repeat(40) }, pack).join("\n")).toContain("术语表基于");
  });

  test("包里没有的 en 打回", () => {
    const errors = validateTermTable(
      { ...table, terms: [{ en: "Unknown Term", zh: "未知", bucket: "new", source: "本 PR" }] },
      pack,
    );
    expect(errors.join("\n")).toContain("不在本 PR 的语言包原文里");
  });

  test("整句里的词按子串命中放行", () => {
    const errors = validateTermTable(
      { ...table, terms: [{ en: "Essence", zh: "精华", bucket: "new", source: "本 PR" }] },
      pack,
    );
    expect(errors).toEqual([]);
  });

  test("拒收时给最近候选", () => {
    const errors = validateTermTable(
      { ...table, terms: [{ en: "Life Essenses", zh: "生命源质", bucket: "new", source: "本 PR" }] },
      pack,
    );
    expect(errors.join("\n")).toContain("相近：Life Essence");
  });

  test("手册正文里出现的词也放行", () => {
    const errors = validateTermTable(
      { ...table, terms: [{ en: "Euler Angles", zh: "欧拉角", bucket: "new", source: "本 PR" }] },
      pack,
      "旋转使用 Euler Angles 表示。",
    );
    expect(errors).toEqual([]);
  });

  test("discard 必须写 note", () => {
    const errors = validateTermTable(
      { ...table, terms: [{ en: "Catalyst", zh: "", bucket: "discard", source: "不是术语" }] },
      pack,
    );
    expect(errors.join("\n")).toContain("discard 必须写 note");
  });
});

describe("render", () => {
  const terms = [
    { en: "Life Essence", zh: "生命源质", bucket: "lock" as const, source: "zh_cn_cfpa: 2 例" },
    { en: "Catalyst", zh: "触媒", bucket: "new" as const, source: "本 PR 新建" },
    { en: "Not A Term", zh: "", bucket: "discard" as const, source: "整句", note: "不是术语" },
  ];

  test("折叠块只列定译", () => {
    const block = renderTermBlock(terms);
    expect(block).toContain("<details>");
    expect(block).toContain("锁定 1 / 新建 1");
    expect(block).toContain("| Catalyst | 触媒 | 本 PR 新建 |");
    expect(block).not.toContain("Not A Term");
  });

  test("片头按上限截断并提示", () => {
    const lines = renderSliceTerms(terms, 1, 42).join("\n");
    expect(lines).toContain("Life Essence = 生命源质");
    expect(lines).toContain("另 1 条见 pr://42/terms");
    expect(lines).toContain("termProposals");
  });
});

describe("parseTermInput", () => {
  test("裸数组与 {terms} 都收", () => {
    const bare = parseTermInput('[{"en":"Catalyst","zh":"触媒","bucket":"new","source":"本 PR"}]', 42, "a".repeat(40));
    expect(bare.table?.terms[0]?.zh).toBe("触媒");
    expect(bare.table?.prNumber).toBe(42);
    const wrapped = parseTermInput('{"terms":[]}', 42, "a".repeat(40));
    expect(wrapped.errors).toEqual([]);
  });

  test("bucket 非法报错", () => {
    const parsed = parseTermInput('[{"en":"Catalyst","zh":"触媒","bucket":"locked","source":"x"}]', 42, "a".repeat(40));
    expect(parsed.table).toBeUndefined();
    expect(parsed.errors.join("\n")).toContain("bucket 只能是");
  });
});

describe("注入", () => {
  const table: TermTable = {
    prNumber: 42,
    headSha: "a".repeat(40),
    updatedAt: "2026-01-01T00:00:00.000Z",
    terms: [
      { en: "Life Essence", zh: "生命源质", bucket: "lock", source: "zh_cn_cfpa: 2 例" },
      { en: "Not A Term", zh: "", bucket: "discard", source: "整句", note: "不是术语" },
    ],
  };

  test("冻结表进片头与 manifest", () => {
    const composed = composeWorkPack(
      pack,
      [
        {
          workspace: "example/1.20.1/mod",
          path: "projects/assets/example/1.20.1/mod/lang/zh_cn.json",
          key: "item.mod.life_essence",
          en: "Life Essence",
          zh: "生命精华",
          line: 1,
          inHunk: true,
          changed: true,
          findings: [],
        },
      ],
      new Date("2026-01-01T00:00:00.000Z"),
      undefined,
      table,
    );
    const doc = composed.files.find((file) => file.name.endsWith(".md"))?.content ?? "";
    expect(doc).toContain("术语表（已冻结，逐字照用）");
    expect(doc).toContain("Life Essence = 生命源质");
    expect(doc).not.toContain("Not A Term");
    expect(composed.manifest.terms?.locked).toBe(1);
    expect(composed.manifest.terms?.total).toBe(2);
  });

  test("正文末尾折叠块只列定译", () => {
    const body = renderReviewBody({
      prNumber: 42,
      headSha: "a".repeat(40),
      verdict: "approve",
      summary: "无问题。",
      comments: [],
      terms: table.terms,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(body).toContain("<details>");
    expect(body).toContain("| Life Essence | 生命源质 |");
    expect(body).not.toContain("Not A Term");
  });
});

describe("片文档比对", () => {
  test("只差版本号与片 id 视为相同", () => {
    const a = "# 审查分片 e15d83b-02\n文件：projects/assets/dh/1.20/x.md\ncriteria page_contents ==\n";
    const b = "# 审查分片 e15d83b-09\n文件：projects/assets/dh/1.21/x.md\ncriteria page_contents ==\n";
    expect(normalizeSliceDoc(a, "e15d83b-02")).toBe(normalizeSliceDoc(b, "e15d83b-09"));
  });

  test("正文有差异就不算相同", () => {
    const a = "# 审查分片 s-01\n文件：x/1.20/a.md\ncriteria page_contents ==\n";
    const b = "# 审查分片 s-02\n文件：x/1.21/a.md\ncriteria page_contents !=\n";
    expect(normalizeSliceDoc(a, "s-01")).not.toBe(normalizeSliceDoc(b, "s-02"));
  });
});

describe("draftInputSchema", () => {
  test("手册评论省略 key 时补空串", () => {
    const parsed = draftInputSchema.safeParse({
      prNumber: 1,
      verdict: "changes",
      summary: "s",
      comments: [{ id: "c1", path: "a.md", line: 3, mqm: "style/house-style", body: "b", suggestion: "s" }],
    });
    expect(parsed.success && parsed.data.comments[0]?.key).toBe("");
  });

  test("skipped 收 identical", () => {
    const parsed = draftInputSchema.safeParse({
      prNumber: 1,
      verdict: "approve",
      summary: "s",
      comments: [],
      skipped: [{ slice: "s-09", reason: "identical", identicalTo: "s-02" }],
    });
    expect(parsed.success && parsed.data.skipped?.[0]?.identicalTo).toBe("s-02");
  });
});

describe("文件级评论", () => {
  const comment = {
    id: "c1",
    path: "projects/assets/x/1.21/x/doc/zh_cn/a.md",
    key: "",
    mqm: "accuracy/mistranslation",
    body: "整篇的口径问题",
    severity: "minor" as const,
  };
  const draft = {
    prNumber: 1,
    headSha: "a".repeat(40),
    verdict: "changes" as const,
    summary: "s",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("fileLevel 不需要 line", () => {
    expect(validateDraft({ ...draft, comments: [{ ...comment, fileLevel: true }] }, {})).toEqual([]);
  });

  test("fileLevel 不能带 line、key、suggestion", () => {
    const errors = validateDraft(
      { ...draft, comments: [{ ...comment, fileLevel: true, line: 3, suggestion: "x" }] },
      {},
    ).join("\n");
    expect(errors).toContain("不要给 line");
    expect(errors).toContain("不支持 suggestion");
  });

  test("手册行级评论必须给 line 或 fileLevel", () => {
    expect(validateDraft({ ...draft, comments: [{ ...comment }] }, {}).join("\n")).toContain("fileLevel:true");
  });

  test("文件级评论进正文", () => {
    const body = renderReviewBody({ ...draft, comments: [{ ...comment, fileLevel: true }] });
    expect(body).toContain("文件级意见");
    expect(body).toContain("1 条文件级");
    expect(body).toContain("整篇的口径问题");
  });

  test("prepareDraft 接受不带 line 的文件级评论", () => {
    const prepared = prepareDraft(
      JSON.stringify({
        prNumber: 1,
        verdict: "changes",
        summary: "s",
        comments: [{ ...comment, fileLevel: true }],
      }),
      1,
      "a".repeat(40),
    );
    expect(prepared.errors).toEqual([]);
    expect(prepared.draft?.comments[0]?.fileLevel).toBe(true);
    expect(prepared.draft?.comments[0]?.line).toBeUndefined();
  });
});
