import { describe, expect, test } from "bun:test";
import type { TermTable } from "@cfpa/contracts/api";
import { validateTermTable } from "@cfpa/review-core/domain/term-table";
import type { Pack } from "@cfpa/review-core/pack";

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
      ],
      checks: [],
      fileFindings: [],
      duplicates: [],
      counts: { total: 2, changed: 2, flagged: 0 },
    },
  ],
  counts: { workspaces: 1, rows: 2, changed: 2, flagged: 0 },
};

describe("validateTermTable", () => {
  const table: TermTable = {
    prNumber: 42,
    headSha: "a".repeat(40),
    updatedAt: "2026-01-01T00:00:00.000Z",
    terms: [{ en: "Life Essence", zh: "生命源质", bucket: "lock", source: "zh_cn_cfpa: 2 例" }],
  };

  test("head 变更、包外术语、discard 无 note 打回，子串与手册正文放行", () => {
    expect(validateTermTable(table, pack)).toEqual([]);
    expect(validateTermTable({ ...table, headSha: "c".repeat(40) }, pack).join("\n")).toContain("术语表基于");

    const unknown = { ...table, terms: [{ en: "Unknown Term", zh: "未知", bucket: "new" as const, source: "本 PR" }] };

    expect(validateTermTable(unknown, pack).join("\n")).toContain("不在本 PR 的语言包原文里");

    const substring = { ...table, terms: [{ en: "Essence", zh: "精华", bucket: "new" as const, source: "本 PR" }] };
    const manual = { ...table, terms: [{ en: "Euler Angles", zh: "欧拉角", bucket: "new" as const, source: "本 PR" }] };

    expect(validateTermTable(substring, pack)).toEqual([]);
    expect(validateTermTable(manual, pack, "旋转使用 Euler Angles 表示。")).toEqual([]);

    const discard = { ...table, terms: [{ en: "Catalyst", zh: "", bucket: "discard" as const, source: "不是术语" }] };

    expect(validateTermTable(discard, pack).join("\n")).toContain("discard 必须写 note");
  });
});
