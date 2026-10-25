import { rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { ReviewComment, ReviewRowView, ReviewThread, SpecialPairContent } from "@cfpa/contracts/api";
import { validateDraft } from "@cfpa/review-core/draft";
import { buildTermIndex } from "@cfpa/review-core/domain/terms";
import { entryFindings } from "@cfpa/review-core/domain/checks";
import type { Pack, PackRow, PackWorkspace } from "@cfpa/review-core/pack";
import { missingResource, PR_CHILDREN, resourceTree } from "./harness/catalog.ts";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { lineRangeOf, prPartsOf, sliceLines, splitLineSuffix } from "./harness/uri.ts";
import { findWriteTarget } from "./harness/write-targets.ts";
import { buildTools } from "./agent/tools/index.ts";
import { sandboxEnv } from "./agent/tools/bash.ts";
import { localDir, readLocal } from "./agent/local-store.ts";
import { composeSuggestion, prepareDraft, withServerFilledFields } from "./harness/review/draft.ts";
import { reviewRowsForInput, reviewRowViews } from "./harness/review/rows.ts";
import { composeManualSlices, composeWorkPack, persistWorkPack } from "./harness/review/workpack.ts";
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
    headRaw: `    "${key}": "${headZh}",`,
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
    expect(target("pr://12/pack")).toBe("pr-pack");
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

describe("work pack", () => {
  const options = {
    filter: "reviewable" as const,
    include: { terms: true, threads: true, duplicates: true, patch: false },
  };
  const index = buildTermIndex({ "terms-v1.tsv": "en\tzh\nA\t甲\n" });
  const base = {
    threads: {
      available: true,
      headSha: "head",
      pendingReviewId: null,
      threads: [thread],
    } satisfies ThreadsView,
    terms: index,
    patches: new Map<string, string | undefined>(),
  };
  const rowsOf = (space: Pack): ReviewRowView[] => reviewRowViews({ ...base, pack: space }, options);

  test("片文档自包含：路径、MQM、raw、证据都在", () => {
    const space = pack([row("a", "A", "甲", 10), row("b", "B", "乙", 20), row("c", "C", "丙", 30, false)]);
    const { manifest, files } = composeWorkPack(space, rowsOf(space), new Date("2026-01-01T00:00:00.000Z"));
    expect(manifest.counts.reviewable).toBe(2);
    expect(manifest.slices).toHaveLength(1);
    expect(manifest.slices[0]?.rows).toBe(2);
    expect(manifest.slices[0]?.kind).toBe("lang");
    expect(manifest.slices[0]?.doc).toBe("local://pack/head/slices/head-01.md");
    const doc = files[0]?.content ?? "";
    expect(doc).toContain(`文件：${ZH}`);
    expect(doc).toContain("## MQM");
    expect(doc).toContain("accuracy/mistranslation");
    expect(doc).toContain("### a");
    expect(doc).toContain('raw:     "a": "甲",');
    expect(doc).toContain("thread: t1");
    expect(doc).toContain("dup: z");
    expect(doc.match(/^### /gm)).toHaveLength(2);
  });

  test("落盘：manifest 与片文档都能从 local:// 读回", async () => {
    const space = pack([row("a", "A", "甲", 10), row("b", "B", "乙", 20)]);
    const composed = composeWorkPack(space, rowsOf(space));
    const session = `test-workpack-${Date.now().toString(36)}`;
    try {
      await persistWorkPack(session, composed);
      const manifest = await readLocal(session, "pack/manifest.json");
      expect(manifest?.content).toContain('"reviewable": 2');
      const doc = await readLocal(session, composed.files[0]!.name);
      expect(doc?.content).toContain("### a");
      expect(doc?.content).toContain("### b");
    } finally {
      await rm(localDir(session), { recursive: true, force: true });
    }
  });

  test("手册片带两侧行号与变更区间", () => {
    const pair = {
      key: "docs/zh_cn/guide.md",
      kind: "pair" as const,
      en: {
        path: "docs/en_us/guide.md",
        status: "modified" as const,
        base: "line one",
        head: "line one\nline two",
        truncated: false,
        hunks: [{ start: 1, end: 2 }],
      },
      zh: {
        path: "docs/zh_cn/guide.md",
        status: "modified" as const,
        base: "第一行",
        head: "第一行\n第二行",
        truncated: false,
        hunks: [{ start: 2, end: 2 }],
      },
      parsed: null,
    } satisfies SpecialPairContent;
    const manual = composeManualSlices(7, "abcdef1234", [pair]);
    expect(manual.slices).toHaveLength(1);
    expect(manual.slices[0]).toMatchObject({
      kind: "manual",
      pair: "docs/zh_cn/guide.md",
      path: "docs/zh_cn/guide.md",
      doc: "local://pack/abcdef1/slices/abcdef1-m01.md",
    });
    const doc = manual.files[0]?.content ?? "";
    expect(doc).toContain("--- en ---");
    expect(doc).toContain("1| line one");
    expect(doc).toContain("2| 第二行");
    expect(doc).toContain("变更行（zh）：2-2");
    expect(doc).toContain("## MQM");
  });

  test("相邻条目译文进片，回填不用自己找", () => {
    const space = pack([row("a", "A", "甲", 10), row("b", "B", "乙", 20), row("c", "C", "丙", 30)]);
    const doc = composeWorkPack(space, rowsOf(space)).files[0]?.content ?? "";
    expect(doc).toContain("prev: a = 甲");
    expect(doc).toContain("next: c = 丙");
  });

  test("服务端按 raw 拼整行，补 en/zh 并去掉 zhNew", async () => {
    const space = pack([row("a", "A", "甲", 10)]);
    const payload = JSON.stringify({
      prNumber: 7,
      headSha: "head",
      verdict: "changes",
      summary: "一处错译",
      comments: [
        {
          path: ZH,
          line: 10,
          key: "a",
          severity: "major",
          mqm: "accuracy/mistranslation",
          body: "意思反了",
          zhNew: "乙",
        },
      ],
    });
    const filled = JSON.parse(await withServerFilledFields(7, payload, space)) as {
      comments: Record<string, unknown>[];
    };
    expect(filled.comments[0]).toMatchObject({ en: "A", zh: "甲", suggestion: '    "a": "乙",' });
    expect("zhNew" in (filled.comments[0] ?? {})).toBe(false);
  });

  test("拼整行保留缩进与行尾逗号；.lang 不引号", () => {
    expect(composeSuggestion(ZH, "a", '    "a": "甲",', "乙")).toBe('    "a": "乙",');
    expect(composeSuggestion(ZH, "a", '  "a": "甲"', "乙")).toBe('  "a": "乙"');
    expect(composeSuggestion("x/lang/zh_cn.lang", "a", "a=甲", "乙")).toBe("a=乙");
  });

  test("手册评论没有 raw，zhNew 不猜、不拼", async () => {
    const payload = JSON.stringify({
      prNumber: 7,
      headSha: "head",
      verdict: "changes",
      summary: "手册",
      comments: [
        {
          path: "docs/zh_cn/guide.md",
          line: 3,
          key: "docs/zh_cn/guide.md",
          severity: "minor",
          mqm: "fluency/awkward",
          body: "读起来别扭",
          suggestion: "改好的整行中文",
          zhNew: "不该被用",
        },
      ],
    });
    const filled = JSON.parse(await withServerFilledFields(7, payload, pack([]))) as {
      comments: Record<string, unknown>[];
    };
    expect(filled.comments[0]?.suggestion).toBe("改好的整行中文");
    expect("zhNew" in (filled.comments[0] ?? {})).toBe(false);
  });

  test("按预算切片，同 key 组不切开", () => {
    const space = pack([
      row("mod.page.a.one", "A", "甲", 1),
      row("mod.page.a.two", "B", "乙", 2),
      row("mod.page.b.one", "C", "丙", 3),
    ]);
    const { manifest } = composeWorkPack(space, rowsOf(space), new Date("2026-01-01T00:00:00.000Z"), 120);
    expect(manifest.counts.slices).toBe(2);
    expect(manifest.slices[0]).toMatchObject({ firstKey: "mod.page.a.one", lastKey: "mod.page.a.two" });
    expect(manifest.slices[1]?.firstKey).toBe("mod.page.b.one");
    expect(manifest.slices.every((slice) => slice.bytes > 0)).toBe(true);
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

  test("查询前的行范围也剥掉，普通路径不动", () => {
    expect(splitLineSuffix("x/zh_cn.json:85-125")).toEqual({
      path: "x/zh_cn.json",
      range: { start: 85, end: 125 },
    });
    expect(splitLineSuffix("x/zh_cn.json:85")).toEqual({ path: "x/zh_cn.json", range: { start: 85, end: null } });
    expect(splitLineSuffix("x/zh_cn.json")).toEqual({ path: "x/zh_cn.json", range: null });
    expect(splitLineSuffix("x/zh_cn.json:raw")).toEqual({ path: "x/zh_cn.json:raw", range: null });
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
  test("covers 可与 suggestion 并存；suggestion 不是整行时报错", () => {
    const patches = new Map<string, string | undefined>([
      [ZH, ['@@ -8,2 +8,2 @@', '   "a": "x",', '-  "b": "旧",', '+  "b": "新",'].join("\n")],
    ]);
    const draft = (suggestion: string) => ({
      prNumber: 7,
      headSha: "head",
      verdict: "changes" as const,
      summary: "总结",
      comments: [
        {
          id: "c1",
          path: ZH,
          line: 9,
          key: "b",
          severity: "minor" as const,
          mqm: "fluency/spacing",
          body: "原因",
          suggestion,
          covers: ["c"],
        },
      ],
    });
    expect(validateDraft(draft('  "b": "新。",'), { patches })).toEqual([]);
    expect(validateDraft(draft('"b": "新。"'), { patches }).some((error) => error.includes("缩进"))).toBe(true);
    expect(
      validateDraft(draft('  "b": 新。,'), { patches }).some((error) => error.includes("JSON 条目")),
    ).toBe(true);
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
