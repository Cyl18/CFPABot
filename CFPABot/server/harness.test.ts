import { describe, expect, test } from "bun:test";
import type { ReviewComment, ReviewThread } from "@cfpa/contracts/api";
import { validateDraft } from "@cfpa/review-core/draft";
import { buildTermIndex } from "@cfpa/review-core/domain/terms";
import type { Pack, PackRow, PackWorkspace } from "@cfpa/review-core/pack";
import { missingResource, PR_CHILDREN, resourceTree } from "./harness/catalog.ts";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { prPartsOf } from "./harness/uri.ts";
import { findWriteTarget } from "./harness/write-targets.ts";
import { prepareDraft } from "./harness/review/draft.ts";
import { rowsPage } from "./harness/review/rows.ts";
import { aggregateTerms } from "./harness/review/terms.ts";
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
    expect(tree).toContain("rows?filter=reviewable");
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

  test("reviewable 只留 changed 且在 hunk 内的行，并给出下一页", () => {
    const page = rowsPage(data, {
      filter: "reviewable",
      limit: 1,
      include: { terms: true, threads: true, duplicates: true, patch: true },
    });
    expect(page.total).toBe(2);
    expect(page.counts.reviewable).toBe(2);
    expect(page.rows).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    expect(page.next).toContain("offset=1");
    expect(page.commentsAvailable).toBe(true);
    expect(page.termsLoaded).toBe(true);
    expect(page.patches?.[ZH]).toContain("+A");
  });

  test("行上直接带 path、术语、线程与重复译文", () => {
    const page = rowsPage(data, {
      filter: "reviewable",
      limit: 1,
      include: { terms: true, threads: true, duplicates: true, patch: false },
    });
    const first = page.rows[0]!;
    expect(first.path).toBe(ZH);
    expect(first.en).toBe("A");
    expect(first.zh).toBe("甲");
    expect(first.terms?.[0]?.ok).toBe(true);
    expect(first.threads).toHaveLength(1);
    expect(first.duplicate?.keys).toEqual(["z"]);
  });

  test("paginated 不影响过滤后的总数", () => {
    const last = rowsPage(data, {
      filter: "reviewable",
      offset: 1,
      limit: 1,
      include: { terms: false, threads: false, duplicates: false, patch: false },
    });
    expect(last.nextOffset).toBeNull();
    expect(last.rows[0]?.key).toBe("b");
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
    expect(view.groups[0]?.glossary[0]?.zh).toEqual(["甲"]);
    expect(view.counts.inconsistent).toBe(1);
  });

  test("term 查询直接查 glossary", () => {
    const view = aggregateTerms(pack([]), index, { queries: ["Foo Bar"], changed: false });
    expect(view.queries[0]?.hits[0]?.zh).toEqual(["甲"]);
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
