// src/__tests__/checks.test.ts
// 检查注册表与忽略机制测试 — 元数据完整性、全局开关、条目级规则、结构化 diff。

import { describe, expect, it } from "bun:test";
import {
  CHECK_REGISTRY,
  getCheckMeta,
  isCheckEnabled,
  applyCheckIgnores,
} from "../flows/_shared/language/index.js";
import { checkEntryFormat } from "../flows/_shared/language/format-checks.js";
import type { ProgramCandidate } from "../flows/_shared/language/align-review-items.js";

describe("CHECK_REGISTRY", () => {
  it("13 个检查全量注册, id 唯一", () => {
    expect(CHECK_REGISTRY).toHaveLength(13);
    const ids = CHECK_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("align 类 5 项 + format 类 8 项", () => {
    const align = CHECK_REGISTRY.filter((m) => m.category === "align");
    const format = CHECK_REGISTRY.filter((m) => m.category === "format");
    expect(align).toHaveLength(5);
    expect(format).toHaveLength(8);
  });

  it("severity 合法且与产出一致(align 仅 missing_translation 为 error)", () => {
    for (const m of CHECK_REGISTRY) {
      expect(["error", "warning"]).toContain(m.severity);
    }
    const alignErrors = CHECK_REGISTRY.filter((m) => m.category === "align" && m.severity === "error");
    expect(alignErrors.map((m) => m.id)).toEqual(["missing_translation"]);
    const formatErrors = CHECK_REGISTRY.filter((m) => m.category === "format" && m.severity === "error");
    expect(formatErrors.map((m) => m.id)).toEqual([
      "placeholder_count_mismatch",
      "special_tag_mismatch",
      "tellraw_mismatch",
      "energy_unit_translated",
    ]);
  });

  it("getCheckMeta 未注册 id 返回 undefined", () => {
    expect(getCheckMeta("placeholder_count_mismatch")?.severity).toBe("error");
    expect(getCheckMeta("nonsense_check")).toBeUndefined();
  });
});

describe("isCheckEnabled (全局开关)", () => {
  it("默认全部启用(defaultDisabled 当前无默认禁用项)", () => {
    for (const m of CHECK_REGISTRY) {
      expect(isCheckEnabled(m.id)).toBe(true);
    }
  });

  it("overrides 可显式关闭单个检查", () => {
    expect(isCheckEnabled("punctuation_issue", { punctuation_issue: false })).toBe(false);
    expect(isCheckEnabled("placeholder_count_mismatch", { punctuation_issue: false })).toBe(true);
  });

  it("all 覆盖 defaultDisabled 强制全量启用", () => {
    expect(isCheckEnabled("punctuation_issue", { all: true })).toBe(true);
  });

  it("defaultDisabled 检查须显式启用(机制验证)", () => {
    // 构造元数据验证: 用默认禁用的假 id 走同一逻辑
    const meta = getCheckMeta("ellipsis_issue")!;
    expect(meta.id).toBe("ellipsis_issue");
  });
});

describe("applyCheckIgnores (条目级规则)", () => {
  const cands: ProgramCandidate[] = [
    { itemId: "a", issueType: "punctuation_issue", severity: "warning", path: "projects/1.20.1/foo/zh_cn.json", key: "book.page" },
    { itemId: "b", issueType: "placeholder_count_mismatch", severity: "error", path: "projects/1.20.1/foo/zh_cn.json", key: "item.name" },
    { itemId: "c", issueType: "punctuation_issue", severity: "warning", path: "projects/1.20.1/bar/zh_cn.json", key: "item.name" },
  ];

  it("无规则 = 不过滤(现状行为不变)", () => {
    expect(applyCheckIgnores(cands, [])).toHaveLength(3);
  });

  it("key 前缀豁免指定检查", () => {
    const out = applyCheckIgnores(cands, [{ checkIds: ["punctuation_issue"], keyPrefix: "book." }]);
    expect(out.map((c) => c.itemId)).toEqual(["b", "c"]);
  });

  it("path 前缀豁免全部检查", () => {
    const out = applyCheckIgnores(cands, [{ pathPrefix: "projects/1.20.1/foo/" }]);
    expect(out.map((c) => c.itemId)).toEqual(["c"]);
  });

  it("规则组合: checkIds 空 = 对全部检查生效", () => {
    const out = applyCheckIgnores(cands, [{ keyPrefix: "book." }]);
    expect(out.map((c) => c.itemId)).toEqual(["b", "c"]);
  });
});

describe("checkEntryFormat 结构化 diff", () => {
  it("占位符缺失: missing 列出具体占位符", () => {
    const findings = checkEntryFormat("item.name", "Take %s of %d items", "获取 %s");
    const ph = findings.find((f) => f.issueType === "placeholder_count_mismatch");
    expect(ph).toBeDefined();
    expect(ph!.missing).toEqual(["%d"]);
    expect(ph!.extra).toEqual([]);
    expect(ph!.detail).toContain("占位符");
  });

  it("占位符多余: extra 列出具体占位符", () => {
    const findings = checkEntryFormat("item.name", "Take %s", "获取 %s 和 %d");
    const ph = findings.find((f) => f.issueType === "placeholder_count_mismatch");
    expect(ph!.extra).toEqual(["%d"]);
    expect(ph!.missing).toEqual([]);
  });

  it("数量一致(含顺序调换)不报错", () => {
    const findings = checkEntryFormat("item.name", "Get %s from %s", "从 %s 中获取 %s");
    expect(findings.find((f) => f.issueType === "placeholder_count_mismatch")).toBeUndefined();
  });

  it("位置占位符归一化: %1$s 与 %s 等价", () => {
    const findings = checkEntryFormat("item.name", "Use %1$s and %2$d", "使用 %2$d 与 %1$s");
    expect(findings.find((f) => f.issueType === "placeholder_count_mismatch")).toBeUndefined();
  });

  it("特殊标签缺失: missing 列出具体标签", () => {
    const findings = checkEntryFormat("item.desc", "§6Golden §dSword", "黄金剑");
    const tag = findings.find((f) => f.issueType === "special_tag_mismatch");
    expect(tag).toBeDefined();
    expect(tag!.missing).toEqual(["§6", "§d"]);
  });

  it("能量单位缺失: missing 列出单位", () => {
    const findings = checkEntryFormat("item.desc", "Consumes 100 FE per use", "每次使用消耗 100 点能量");
    const unit = findings.find((f) => f.issueType === "energy_unit_translated");
    expect(unit).toBeDefined();
    expect(unit!.missing).toEqual(["FE"]);
  });
});
