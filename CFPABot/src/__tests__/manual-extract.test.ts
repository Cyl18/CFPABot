// src/__tests__/manual-extract.test.ts
// 手册对齐 DSL v2 纯函数测试: glob 匹配、四种提取 mode(正常 + 边界)、
// 未知 mode/keyFrom 报错、DSL YAML 解析(v1/v2 兼容)、规则覆盖冲突检测、
// 全局/session 规则合并。

import { describe, it, expect } from "bun:test";
import {
  extractManualEntries,
  extractMarkdownHeadings,
  extractLineTable,
  extractKvJson,
  extractRegexEntries,
  globMatch,
  globToRegExp,
  validateManualRules,
  type ManualExtractMode,
  type ManualKeyFrom,
  type ManualRule,
} from "../flows/_shared/manual-extract.js";
import {
  analyzeRuleCoverage,
  mergeManualRules,
  parseManualPlanYaml,
  parseManualRulesYaml,
  emitManualPlanYaml,
} from "../flows/_shared/manual-dsl.js";

interface RuleOverrides {
  name?: string;
  match?: string;
  mode?: string;
  keyFrom?: ManualKeyFrom;
  regex?: string;
}

function rule(partial: RuleOverrides): ManualRule {
  const extract: ManualRule["extract"] = {
    mode: (partial.mode ?? "markdown-heading") as ManualExtractMode,
    keyFrom: partial.keyFrom ?? "heading",
    regex: partial.regex,
  };
  return {
    name: partial.name ?? "test",
    match: partial.match ?? "**/*.md",
    extract,
  };
}

// ─── glob 匹配 ─────────────────────────────────────────────────────────

describe("globMatch", () => {
  it("精确匹配: 字面路径全等", () => {
    expect(globMatch("projects/a/guide.md", "projects/a/guide.md")).toBe(true);
    expect(globMatch("projects/a/guide.md", "projects/a/other.md")).toBe(false);
  });

  it("`*` 只匹配段内字符, 不跨 /", () => {
    expect(globMatch("projects/*.md", "projects/guide.md")).toBe(true);
    expect(globMatch("projects/*.md", "projects/sub/guide.md")).toBe(false);
    expect(globMatch("projects/*.md", "projects/guide.json")).toBe(false);
  });

  it("`**` 跨路径段, 含零段", () => {
    expect(globMatch("projects/**", "projects/a/b/guide.md")).toBe(true);
    expect(globMatch("projects/**", "projects/guide.md")).toBe(true);
    expect(globMatch("projects/**", "other/guide.md")).toBe(false);
    expect(globMatch("**/guide.md", "guide.md")).toBe(true);
    expect(globMatch("**/guide.md", "a/b/guide.md")).toBe(true);
  });

  it("正则元字符按字面处理", () => {
    expect(globMatch("a.b.md", "axb.md")).toBe(false);
    expect(globMatch("a.b.md", "a.b.md")).toBe(true);
    expect(globMatch("lang(zh).json", "lang(zh).json")).toBe(true);
  });

  it("大小写敏感", () => {
    expect(globMatch("*.md", "A.MD")).toBe(false);
    expect(globToRegExp("*.md").source.length).toBeGreaterThan(0);
  });
});

// ─── markdown-heading ──────────────────────────────────────────────────

describe("extractMarkdownHeadings", () => {
  it("`## 标题` 起 section, 下一标题前为内容, key=标题文本", () => {
    const content = [
      "# 手册",
      "前言(不属于任何条目)",
      "## 安装",
      "第一行",
      "第二行",
      "## 配置",
      "配置内容",
    ].join("\n");
    const entries = extractMarkdownHeadings(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toBe("安装");
    expect(entries[0]!.value).toBe("第一行\n第二行");
    expect(entries[0]!.span).toEqual({ start: 3, end: 5 });
    expect(entries[1]!.key).toBe("配置");
    expect(entries[1]!.value).toBe("配置内容");
    expect(entries[1]!.span).toEqual({ start: 6, end: 7 });
  });

  it("边界: `#`/`###` 是正文而非边界; 空标题 `## ` 只作边界不开启 section; 无内容的 ## section value 为空串", () => {
    const content = "# 手册\n## 空节\n### 子节\n内容\n## \n## 四级\n";
    const entries = extractMarkdownHeadings(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      key: "空节",
      value: "### 子节\n内容",
      span: { start: 2, end: 4 },
    });
    expect(entries[1]).toEqual({ key: "四级", value: "", span: { start: 6, end: 6 } });
  });

  it("边界: 空内容返回空数组", () => {
    expect(extractMarkdownHeadings("")).toEqual([]);
  });
});

// ─── line-table ────────────────────────────────────────────────────────

describe("extractLineTable", () => {
  it("每非空行一个条目: key=行号, value=整行", () => {
    const entries = extractLineTable("第一行\n第二行\n第三行");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ key: "1", value: "第一行", span: { start: 1, end: 1 } });
    expect(entries[2]).toEqual({ key: "3", value: "第三行", span: { start: 3, end: 3 } });
  });

  it("边界: 空行跳过, 行号保持真实行号; CRLF 兼容", () => {
    const entries = extractLineTable("\nA\n\nB\r\n");
    expect(entries.map((e) => e.key)).toEqual(["2", "4"]);
    expect(entries[1]!.value).toBe("B");
  });

  it("边界: 全空内容返回空数组", () => {
    expect(extractLineTable("  \n\n")).toEqual([]);
  });
});

// ─── kv-json ───────────────────────────────────────────────────────────

describe("extractKvJson", () => {
  it("扁平化嵌套对象, key 为 a.b.c json-path", () => {
    const entries = extractKvJson(JSON.stringify({ a: { b: { c: "深值" } }, top: "浅值" }));
    expect(entries).toEqual([
      { key: "a.b.c", value: "深值" },
      { key: "top", value: "浅值" },
    ]);
  });

  it("数组用 [i] 下标: a[0].b", () => {
    const entries = extractKvJson(JSON.stringify({ a: [{ b: "x" }, { b: "y" }] }));
    expect(entries.map((e) => e.key)).toEqual(["a[0].b", "a[1].b"]);
    expect(entries[1]!.value).toBe("y");
  });

  it("边界: 非字符串叶子 JSON 化; 空对象返回空数组", () => {
    const entries = extractKvJson(JSON.stringify({ n: 42, ok: true, none: null }));
    expect(entries).toEqual([
      { key: "n", value: "42" },
      { key: "ok", value: "true" },
      { key: "none", value: "null" },
    ]);
    expect(extractKvJson("{}")).toEqual([]);
  });

  it("边界: 非法 JSON 与标量根值抛错", () => {
    expect(() => extractKvJson("{oops")).toThrow(/不是合法 JSON/);
    expect(() => extractKvJson('"just a string"')).toThrow(/根值必须是对象或数组/);
  });
});

// ─── regex ─────────────────────────────────────────────────────────────

describe("extractRegexEntries", () => {
  it("key=捕获组 1, value=完整匹配, span=匹配行号区间(支持 /pattern/flags 字面量)", () => {
    const content = "v1.0 说明\n[tag] v1.1 更新\nv1.2 修复";
    const entries = extractRegexEntries(content, "/^.*?\\[?(v\\d+\\.\\d+)\\]?/gm");
    expect(entries).toEqual([
      { key: "v1.0", value: "v1.0", span: { start: 1, end: 1 } },
      { key: "v1.1", value: "[tag] v1.1", span: { start: 2, end: 2 } },
      { key: "v1.2", value: "v1.2", span: { start: 3, end: 3 } },
    ]);
  });

  it("边界: 无匹配返回空数组", () => {
    expect(extractRegexEntries("nothing here", "^\\[?(v\\d+)\\]?")).toEqual([]);
  });

  it("边界: 缺 regex / 非法 regex / 无捕获组 1 抛错", () => {
    expect(() => extractRegexEntries("x", "")).toThrow(/缺少 extract\.regex/);
    expect(() => extractRegexEntries("x", "([unclosed")).toThrow(/非法/);
    expect(() => extractRegexEntries("abc", "a+")).toThrow(/至少一个捕获组/);
  });

  it("边界: 零宽匹配不进入死循环", () => {
    const entries = extractRegexEntries("abc", "(x*)");
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.key === "")).toBe(true);
  });
});

// ─── dispatcher: 未知 mode / keyFrom 校验 ──────────────────────────────

describe("extractManualEntries dispatcher", () => {
  it("白名单外的 mode 抛错(禁止任意代码)", () => {
    const bad = { ...rule({}), extract: { mode: "exec" } } as unknown as ManualRule;
    expect(() => extractManualEntries("x", bad, "path.md")).toThrow(/不支持的提取 mode "exec"/);
  });

  it("keyFrom 与 mode 不匹配抛错", () => {
    const bad = rule({ keyFrom: "line" });
    expect(() => extractManualEntries("## t", bad, "path.md")).toThrow(/要求 keyFrom=heading/);
  });

  it("regex mode 经 dispatcher 走 extract.regex", () => {
    const r = rule({ mode: "regex", keyFrom: "group", regex: "^(v\\d+)" });
    expect(extractManualEntries("v2 内容", r, "path.md")).toEqual([
      { key: "v2", value: "v2", span: { start: 1, end: 1 } },
    ]);
  });
});

// ─── 规则校验 ──────────────────────────────────────────────────────────

describe("validateManualRules", () => {
  it("合法规则零错误; mode 白名单/keyFrom/regex 缺失被查出", () => {
    expect(validateManualRules([rule({})])).toEqual([]);
    const bad = [
      rule({ mode: "bash" }),
      rule({ mode: "regex", keyFrom: "group" }), // 缺 regex
      { name: "x", match: "", extract: { mode: "line-table" } },
      { name: "x", match: "a.md", extract: { mode: "kv-json", keyFrom: "group" } },
    ] as unknown as ManualRule[];
    const errors = validateManualRules(bad);
    expect(errors.join("\n")).toContain("不在白名单");
    expect(errors.join("\n")).toContain("regex mode 需要 extract.regex");
    expect(errors.join("\n")).toContain("match(glob) 不能为空");
    expect(errors.join("\n")).toContain("要求 keyFrom=json-path");
  });

  it("列表内 name 重复报错", () => {
    const errors = validateManualRules([rule({ name: "a" }), rule({ name: "a" })]);
    expect(errors.join("\n")).toContain('规则名重复: "a"');
  });
});

// ─── DSL YAML 解析(v1/v2) ─────────────────────────────────────────────

const V2_YAML = [
  "version: 2",
  "pairs:",
  "  - path: projects/1.20.1/foo/docs/guide.md",
  "    slug: foo",
  "rules:",
  "  - name: guide",
  "    match: projects/**/guide.md",
  "    extract:",
  "      mode: markdown-heading",
  "      keyFrom: heading",
  "  - name: lang",
  "    match: projects/**/zh_cn.json",
  "    extract:",
  "      mode: kv-json",
  "      keyFrom: json-path",
].join("\n");

describe("parseManualPlanYaml", () => {
  it("version 2: pairs + rules 完整解析(含 extract 嵌套)", () => {
    const { plan, errors } = parseManualPlanYaml(V2_YAML);
    expect(errors).toEqual([]);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(2);
    expect(plan!.pairs).toEqual([{ path: "projects/1.20.1/foo/docs/guide.md", slug: "foo" }]);
    expect(plan!.rules).toHaveLength(2);
    expect(plan!.rules![0]).toEqual({
      name: "guide",
      match: "projects/**/guide.md",
      extract: { mode: "markdown-heading", keyFrom: "heading" },
    });
    expect(plan!.rules![1]!.extract.mode).toBe("kv-json");
  });

  it("v1 兼容: version 1 + pairs(inline `- path:` 与裸 `-` 两种写法)", () => {
    for (const body of [
      "  - path: projects/a.md\n    slug: foo",
      "  -\n    path: projects/a.md\n    slug: foo",
    ]) {
      const { plan, errors } = parseManualPlanYaml(`version: 1\npairs:\n${body}`);
      expect(errors).toEqual([]);
      expect(plan!.version).toBe(1);
      expect(plan!.pairs).toEqual([{ path: "projects/a.md", slug: "foo" }]);
      expect(plan!.rules).toEqual([]);
    }
  });

  it("version 1 显式声明且带 rules → 报错; 未写 version 带 rules → 自动 version 2", () => {
    const v1 = parseManualPlanYaml("version: 1\npairs:\n  - path: a.md\nrules:\n  - name: r\n    match: a.md\n    extract:\n      mode: line-table");
    expect(v1.errors.join("\n")).toContain("version: 1 不支持 rules");
    expect(v1.plan).toBeNull();
    const auto = parseManualPlanYaml("pairs:\n  - path: a.md\nrules:\n  - name: r\n    match: a.md\n    extract:\n      mode: line-table");
    expect(auto.errors).toEqual([]);
    expect(auto.plan!.version).toBe(2);
  });

  it("语法错误与空 pairs/rules 报错", () => {
    expect(parseManualPlanYaml("version: 3\npairs:\n  - path: a.md").errors.join("\n")).toContain("version 必须为 1 或 2");
    expect(parseManualPlanYaml("pairs:\n  - path: a.md\nrules:\n  - name: r\n    match: a.md\n    extract:\n      mode: bogus").errors.join("\n")).toContain("不在白名单");
    expect(parseManualPlanYaml("notes: x").errors.join("\n")).toContain("至少需要一个 pair");
    const emptyRules = parseManualPlanYaml(V2_YAML, { requireRules: true });
    const noRules = parseManualPlanYaml("version: 2\npairs:\n  - path: a.md\n", { requireRules: true });
    expect(noRules.errors.join("\n")).toContain("没有 rules");
    expect(emptyRules.errors).toEqual([]);
  });

  it("emit → parse 往返一致(v2 含 rules)", () => {
    const { plan } = parseManualPlanYaml(V2_YAML);
    const reparsed = parseManualPlanYaml(emitManualPlanYaml(plan!));
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.plan).toEqual(plan);
  });

  it("parseManualRulesYaml: 完整计划 / rules 段 / 裸列表三种输入", () => {
    expect(parseManualRulesYaml(V2_YAML).rules).toHaveLength(2);
    const section = "rules:\n  - name: a\n    match: x.md\n    extract:\n      mode: line-table\n";
    expect(parseManualRulesYaml(section).rules.map((r) => r.name)).toEqual(["a"]);
    const bare = "- name: a\n  match: x.md\n  extract:\n    mode: line-table\n- name: b\n  match: y.md\n  extract:\n    mode: kv-json\n";
    const { rules, errors } = parseManualRulesYaml(bare);
    expect(errors).toEqual([]);
    expect(rules.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

// ─── 覆盖分析与合并(dry-run 依赖) ─────────────────────────────────────

describe("analyzeRuleCoverage / mergeManualRules", () => {
  const paths = [
    "projects/1.20.1/foo/guide.md",
    "projects/1.20.1/foo/CHANGELOG.md",
    "projects/1.20.1/bar/guide.md",
  ];

  it("每条 rule 统计匹配文件数 + 第一个匹配文件", () => {
    const rules = [
      { name: "guide", match: "**/guide.md", extract: { mode: "markdown-heading" } },
      { name: "changelog", match: "**/CHANGELOG.md", extract: { mode: "line-table" } },
    ] as ManualRule[];
    const { perRule, conflicts } = analyzeRuleCoverage(rules, paths);
    expect(perRule[0]!.matchedFiles).toEqual([
      "projects/1.20.1/foo/guide.md",
      "projects/1.20.1/bar/guide.md",
    ]);
    expect(perRule[0]!.firstFile).toBe("projects/1.20.1/foo/guide.md");
    expect(perRule[1]!.matchedFiles).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  it("同一文件被多个 rule 命中 → 冲突列出, winner 取第一个", () => {
    const rules = [
      { name: "all-md", match: "**/*.md", extract: { mode: "line-table" } },
      { name: "guide", match: "**/guide.md", extract: { mode: "markdown-heading" } },
    ] as ManualRule[];
    const { conflicts } = analyzeRuleCoverage(rules, paths);
    expect(conflicts).toEqual([
      {
        path: "projects/1.20.1/foo/guide.md",
        matchedBy: ["all-md", "guide"],
        winner: "all-md",
      },
      {
        path: "projects/1.20.1/bar/guide.md",
        matchedBy: ["all-md", "guide"],
        winner: "all-md",
      },
    ]);
  });

  it("mergeManualRules: 全局在前, session 同名覆盖", () => {
    const global = [
      { name: "g1", match: "a.md", extract: { mode: "line-table" } },
      { name: "shared", match: "old.md", extract: { mode: "line-table" } },
    ] as ManualRule[];
    const session = [
      { name: "shared", match: "new.md", extract: { mode: "kv-json" } },
      { name: "s1", match: "b.md", extract: { mode: "line-table" } },
    ] as ManualRule[];
    const merged = mergeManualRules(session, global);
    expect(merged.map((r) => r.name)).toEqual(["g1", "shared", "s1"]);
    expect(merged.find((r) => r.name === "shared")!.match).toBe("new.md");
  });
});
