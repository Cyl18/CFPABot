import { describe, expect, test } from "bun:test";
import type { ReviewComment, ReviewThread } from "@cfpa/contracts/api";
import { validateDraft } from "@cfpa/review-core/draft";
import { buildTermIndex } from "@cfpa/review-core/domain/terms";
import { entryFindings } from "@cfpa/review-core/domain/checks";
import type { Pack, PackRow, PackWorkspace } from "@cfpa/review-core/pack";
import { missingResource, PR_CHILDREN, resourceTree } from "./harness/catalog.ts";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { lineRangeOf, prPartsOf, sliceLines } from "./harness/uri.ts";
import { findWriteTarget } from "./harness/write-targets.ts";
import { buildTools } from "./agent/tools/index.ts";
import { sandboxEnv } from "./agent/tools/bash.ts";
import { prepareDraft } from "./harness/review/draft.ts";
import { reviewRowsForInput } from "./harness/review/rows.ts";
import { aggregateTerms } from "./harness/review/terms.ts";
import { jsonResult } from "./harness/result.ts";
import { secretReason } from "./agent/plugins/sandbox.ts";
import { commentCheckedSha, unknownHint } from "./harness/review/checks.ts";
import type { ThreadsView } from "./harness/review/threads.ts";

const EN = "projects/assets/demo/1.20.1/demo/lang/en_us.json";
const ZH = "projects/assets/demo/1.20.1/demo/lang/zh_cn.json";

function row(key: string, headEn: string, headZh: string, line: number, inHunk = true): PackRow {
  return {
    key,
    baseEn: headEn,
    headEn,
    baseZh: headZh,
    headZh,
    line,
    inHunk,
    changed: true,
    findings: [],
  };
}

function workspace(rows: PackRow[]): PackWorkspace {
  return {
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
}

function pack(rows: PackRow[]): Pack {
  const space = workspace(rows);
  return {
    prNumber: 7,
    baseSha: "base",
    headSha: "head",
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspaces: [space],
    counts: { workspaces: 1, rows: rows.length, changed: rows.length, flagged: 0 },
  };
}

const comment: ReviewComment = {
  id: "c1",
  author: "reviewer",
  avatarUrl: "",
  body: "之前提过",
  createdAt: "2026-01-01T00:00:00.000Z",
  url: "",
  pending: false,
  mine: false,
};

const thread: ReviewThread = {
  id: "t1",
  path: ZH,
  line: 10,
  originalLine: 10,
  outdated: false,
  resolved: false,
  comments: [comment],
};

describe("harness catalog", () => {
  test("新入口在资源树与子资源名里", () => {
    for (const name of ["rows", "terms", "draft", "special-files"]) expect(PR_CHILDREN).toContain(name);
    const tree = resourceTree();
    expect(tree).toContain("pr://<n>  #");
    expect(tree).toContain("rows?slice=");
    expect(tree).toContain("terms?term=");
    expect(tree).toContain("draft");
    expect(tree).not.toContain("help://");
  });

  test("未知资源给出可用子资源与入口", () => {
    expect(() => missingResource("pr://7/nope", PR_CHILDREN)).toThrow(/可用：/);
    expect(() => missingResource("pr://7/nope", PR_CHILDREN)).toThrow(/read pr:\/\/<n>\?review=1/);
  });
});

describe("write targets", () => {
  test("custom tools include bash and delegate", () => {
    const names = buildTools({ sessionId: "test-session", prNumber: 1 } as never, []).map((tool) => tool.name);
    expect(names.sort()).toEqual(["bash", "delegate"]);
  });

  test("draft, review and inline comment resolve to distinct handlers", () => {
    const target = (uri: string): string | undefined => {
      const url = new URL(uri);
      const internal = {
        rawHost: url.hostname,
        pathname: url.pathname,
        searchParams: url.searchParams,
      } as InternalUrl;
      return findWriteTarget(prPartsOf(internal))?.id;
    };
    expect(target("pr://12/draft")).toBe("pr-draft");
    expect(target("pr://12/review")).toBe("pr-review");
    expect(target("pr://12/review?event=APPROVE")).toBe("pr-review");
    expect(target("pr://12/review/submit")).toBe("pr-review-submit");
    expect(target("pr://12/files/a/b/zh_cn.json/comments?line=3")).toBe("pr-inline-comment");
    expect(target("pr://12/rows")).toBeUndefined();
  });
});

describe("review rows", () => {
  const index = buildTermIndex({
    "terms-v1.tsv": "en\tzh\nA\t甲\n",
  });
  const threads: ThreadsView = {
    available: true,
    headSha: "head",
    pendingReviewId: null,
    threads: [thread],
  };
  const data = {
    pack: pack([row("a", "A", "甲", 10), row("b", "B", "乙", 20), row("c", "C", "丙", 30, false)]),
    threads,
    terms: index,
    patches: new Map<string, string | undefined>([[ZH, "@@ -1,1 +1,2 @@\n+A\n+B"]]),
  };

  test("reviewable 只留 changed 且在 hunk 内的行", () => {
    const page = reviewRowsForInput(data, {
      filter: "reviewable",
      include: { terms: true, threads: true, duplicates: true, patch: true },
    }).page;
    expect(page.total).toBe(2);
    expect(page.counts.reviewable).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page.next).toBeNull();
    expect(page.commentsAvailable).toBe(true);
    expect(page.termsLoaded).toBe(true);
    expect(page.patches?.[ZH]).toContain("+A");
  });

  test("行上直接带 path、术语、线程与重复译文", () => {
    const page = reviewRowsForInput(data, {
      filter: "reviewable",
      include: { terms: true, threads: true, duplicates: true, patch: false },
    }).page;
    const first = page.rows[0]!;
    expect(first.path).toBe(ZH);
    expect(first.en).toBe("A");
    expect(first.zh).toBe("甲");
    expect(first.terms?.[0]?.ok).toBe(true);
    expect(first.threads).toHaveLength(1);
    expect(first.duplicate?.keys).toEqual(["z"]);
  });

  test("同 key 的已 resolved 线程跨 workspace 传播，未解决的不传播", () => {
    const modernPath = "projects/assets/demo/1.21/demo/lang/zh_cn.json";
    const modern = {
      ...workspace([row("a", "A", "甲", 10)]),
      version: "1.21",
      enPath: "projects/assets/demo/1.21/demo/lang/en_us.json",
      zhPath: modernPath,
    };
    const shared = { ...thread, id: "t2", path: modernPath, resolved: true };
    const open = { ...thread, id: "t3", path: modernPath, resolved: false };
    const both: Pack = {
      ...pack([row("a", "A", "甲", 10)]),
      workspaces: [workspace([row("a", "A", "甲", 10)]), modern],
    };
    const page = reviewRowsForInput(
      {
        pack: both,
        threads: { available: true, headSha: "head", pendingReviewId: null, threads: [thread, shared, open] },
        terms: null,
        patches: new Map(),
      },
      { filter: "reviewable", include: { terms: false, threads: true, duplicates: false, patch: false } },
    ).page;
    const [legacyRow, modernRow] = page.rows;
    expect(legacyRow?.threads?.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(modernRow?.threads?.map((entry) => entry.id).sort()).toEqual(["t2", "t3"]);
  });
});

describe("review rows plan", () => {
  const options = {
    filter: "reviewable" as const,
    include: { terms: false, threads: false, duplicates: false, patch: false },
  };

  test("预算内一次给全集，complete 为真", () => {
    const input = {
      pack: pack([row("a", "A", "甲", 10), row("b", "B", "乙", 20)]),
      threads: { available: false, headSha: null, pendingReviewId: null, threads: [] },
      terms: null,
      patches: new Map(),
    };
    const result = reviewRowsForInput(input, options);
    expect(result.plan.fits).toBe(true);
    expect(result.plan.slices).toEqual([]);
    expect(result.page.complete).toBe(true);
    expect(result.page.rows.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(result.page.next).toBeNull();
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
    const result = reviewRowsForInput(input, options);
    expect(result.plan.fits).toBe(false);
    expect(result.page.complete).toBe(false);
    expect(result.page.rows).toEqual([]);
    expect(result.page.plan).toEqual(result.plan);
    expect(result.page.next).toBe(result.plan.slices[0]?.uri ?? null);
    expect(result.plan.sliceCount).toBeGreaterThan(result.plan.slices.length);
    expect(result.plan.slices.every((slice) => slice.rows <= 300)).toBe(true);
    expect(result.plan.slices[0]).not.toHaveProperty("start");

    const keys: string[] = [];
    let uri: string | null = result.page.next;
    let pages = 0;
    while (uri !== null) {
      const id = new URL(uri).searchParams.get("slice") ?? "";
      const page = reviewRowsForInput(input, { ...options, slice: id }).page;
      expect(page.complete).toBe(true);
      expect(page.slice).toBe(id);
      expect(page.rows).toHaveLength(page.limit);
      keys.push(...page.rows.map((entry) => entry.key));
      pages += 1;
      uri = page.next;
    }
    expect(keys).toEqual(rows.map((entry) => entry.key));
    expect(pages).toBe(result.plan.sliceCount);
  });

  test("同一 key 组跨预算也不切开", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, index) =>
        row(`mod.page.alpha.f${index}`, "A".repeat(600), "甲".repeat(200), index + 1),
      ),
      ...Array.from({ length: 25 }, (_, index) =>
        row(`mod.page.beta.f${index}`, "A".repeat(600), "甲".repeat(200), index + 26),
      ),
    ];
    const input = {
      pack: pack(rows),
      threads: { available: false, headSha: null, pendingReviewId: null, threads: [] },
      terms: null,
      patches: new Map(),
    };
    const { plan } = reviewRowsForInput(input, options);
    expect(plan.slices).toHaveLength(2);
    expect(plan.slices[0]).toMatchObject({
      rows: 25,
      firstKey: "mod.page.alpha.f0",
      lastKey: "mod.page.alpha.f24",
    });
    expect(plan.slices[0]!.bytes).toBeGreaterThan(plan.budgetBytes);
    expect(plan.slices[1]?.firstKey).toBe("mod.page.beta.f0");
  });

  test("未知分片报错并指向重新取 plan", () => {
    const input = {
      pack: pack([row("a", "A", "甲", 10)]),
      threads: { available: false, headSha: null, pendingReviewId: null, threads: [] },
      terms: null,
      patches: new Map(),
    };
    expect(() => reviewRowsForInput(input, { ...options, slice: "nope#0" })).toThrow(/重新 read pr:\/\/7\?review=1/);
  });

  test("旧 head 的 slice 不会命中新 plan", () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row(`k${index}`, "A".repeat(600), "甲".repeat(200), index + 1),
    );
    const threads = { available: false, headSha: null, pendingReviewId: null, threads: [] };
    const { plan } = reviewRowsForInput({ pack: pack(rows), threads, terms: null, patches: new Map() }, options);
    const stale = plan.slices[0]!.id;
    expect(stale.startsWith("head~")).toBe(true);
    expect(() =>
      reviewRowsForInput({ pack: { ...pack(rows), headSha: "nextsha" }, threads, terms: null, patches: new Map() }, { ...options, slice: stale }),
    ).toThrow(/旧 head/);
  });
});

describe("terms evidence", () => {
  const index = buildTermIndex({
    "terms-v1.tsv": "en\tzh\nFoo Bar\t甲\n",
  });

  test("同一英文的多种译法按缺失排序", () => {
    const view = aggregateTerms(
      pack([row("a", "Foo Bar", "甲", 1), row("b", "Foo Bar", "乙", 2)]),
      index,
      { queries: [], changed: true },
    );
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.en).toBe("Foo Bar");
    expect(view.groups[0]?.inPr.map((item) => item.zh).sort()).toEqual(["乙", "甲"]);
    expect(view.groups[0]?.misses).toBe(1);
    expect(view.groups[0]?.missed[0]?.zh).toEqual(["甲"]);
    expect(view.counts.inconsistent).toBe(1);
  });

  test("term 查询直接查 glossary", () => {
    const view = aggregateTerms(pack([]), index, { queries: ["Foo Bar"], changed: false });
    expect(view.queries[0]?.hits[0]?.zh).toEqual(["甲"]);
  });
});

describe("bash 子进程环境", () => {
  test("默认按 UTF-8，显式设置时保留", () => {
    const env = sandboxEnv({ PATH: "x" }, "cwd");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.HOME).toBe("cwd");
    expect(sandboxEnv({ PATH: "x", PYTHONIOENCODING: "gbk" }, "cwd").PYTHONIOENCODING).toBe("gbk");
    expect(sandboxEnv({ PATH: "x", OPENAI_API_KEY: "secret" }, "cwd").OPENAI_API_KEY).toBeUndefined();
  });
});

describe("result budget", () => {
  test("超预算返回可解析的错误信封", () => {
    const result = jsonResult({ blob: "x".repeat(60_000) });
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    expect(result.isError).toBe(true);
    expect(JSON.parse(text).budgetBytes).toBe(45_000);
    expect(Buffer.byteLength(text)).toBeLessThan(50_000);
  });

  test("写入正文里的敏感词不触发沙箱密钥扫描", () => {
    expect(secretReason({ path: "pr://1/draft", content: "process.env / .env 只是评论正文" })).toBeUndefined();
    expect(secretReason({ command: "printenv" })).toContain("环境变量");
  });
});

describe("Patchouli 标记", () => {
  test("中文收尾 $ 少于英文时报没闭合", () => {
    expect(entryFindings("k", "$(thing)Ambit$", "$(thing)影响范围").some((finding) => finding.code === "patchouli_mismatch")).toBe(true);
    expect(entryFindings("k", "$(thing)Ambit$", "$(hex)影响范围/$").some((finding) => finding.code === "patchouli_mismatch")).toBe(false);
  });
});

describe("files 行范围", () => {
  test("直接解析 omp 剥出的选择器", () => {
    expect(lineRangeOf("160-172")).toEqual({ start: 160, end: 172 });
    expect(lineRangeOf("160")).toEqual({ start: 160, end: null });
    expect(lineRangeOf("raw")).toBeNull();
  });

  test("按行切，end 越界夹到末尾，start 越界报错", () => {
    const text = "a\nb\nc\nd\n";
    expect(sliceLines(text, { start: 2, end: 3 })).toBe("b\nc");
    expect(sliceLines(text, { start: 3, end: null })).toBe("c\nd\n");
    expect(sliceLines(text, { start: 3, end: 999 })).toBe("c\nd\n");
    expect(() => sliceLines(text, { start: 9, end: null })).toThrow(/只有 5 行/);
  });
});

describe("draft", () => {
  test("服务端补 prNumber、headSha 与 id", () => {
    const result = prepareDraft(
      JSON.stringify({
        verdict: "changes",
        summary: "总结",
        comments: [
          {
            path: ZH,
            line: 10,
            key: "a",
            severity: "minor",
            mqm: "fluency/spacing",
            body: "原因",
            suggestion: "改好的整行",
          },
        ],
      }),
      7,
      "head",
    );
    expect(result.errors).toEqual([]);
    expect(result.draft?.prNumber).toBe(7);
    expect(result.draft?.headSha).toBe("head");
    expect(result.draft?.comments[0]?.id).toBe("c1");
  });

  test("缺 suggestion、重复 key、坏 mqm 都会报错", () => {
    const result = prepareDraft(
      JSON.stringify({
        prNumber: 7,
        verdict: "changes",
        summary: "总结",
        comments: [
          { path: ZH, line: 10, key: "a", severity: "minor", mqm: "bad/type", body: "原因" },
          { path: ZH, line: 11, key: "a", severity: "minor", mqm: "fluency/spacing", body: "原因" },
        ],
      }),
      7,
      "head",
    );
    expect(result.draft).toBeDefined();
    const errors = validateDraft(result.draft!, {});
    expect(errors.some((error) => error.includes("mqm"))).toBe(true);
    expect(errors.some((error) => error.includes("suggestion"))).toBe(true);
    expect(errors.some((error) => error.includes("key 重复"))).toBe(true);
  });
});

function botComment(body: string, author = "cfpa-bot[bot]") {
  return { id: 1, author, isBot: true, body: `<!--CYBOT-->\n${body}`, createdAt: "", updatedAt: "", htmlUrl: "" };
}

describe("checks hint", () => {
  test("两种报告链接都能取到检查 SHA", () => {
    const legacy = "报告在 [这里](https://cfpa.cyan.cafe/static/6133-7f2057d.txt) 查看。";
    const current = "报告在 [这里](http://localhost:5173/api/Utils/Report/6094/878b65a) 查看。";
    expect(commentCheckedSha(6133, [botComment(legacy)])).toBe("7f2057d");
    expect(commentCheckedSha(6094, [botComment(current)])).toBe("878b65a");
    expect(commentCheckedSha(6094, [botComment(current, "someone")])).toBeNull();
  });

  test("没有本地报告时只陈述证据，不断言 PR 未检查", () => {
    expect(unknownHint(6133, "7f2057dd1fed", "7f2057d", true)).toContain("已在 7f2057d 检查过");
    expect(unknownHint(6133, "aaaaaaaa", "7f2057d", true)).toContain("可能已过期");
    expect(unknownHint(6133, "aaaaaaaa", null, true)).not.toContain("还没有检查报告");
  });
});
