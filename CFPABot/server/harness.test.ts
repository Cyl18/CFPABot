import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewComment, ReviewThread } from "@cfpa/contracts/api";
import { buildTermIndex } from "@cfpa/review-core/domain/terms";
import type { Pack, PackRow, PackWorkspace } from "@cfpa/review-core/pack";
import { reviewRowsForInput } from "./harness/review/rows.ts";
import { withServerFilledFields } from "./harness/review/draft.ts";
import { aggregateTerms } from "./harness/review/terms.ts";
import { execPathReason, readPathReason, secretReason } from "./agent/plugins/sandbox.ts";
import { heredocReason } from "./agent/tools/bash.ts";
import { prefetch } from "./agent/tools/delegate.ts";
import { localDir } from "./agent/local-store.ts";
import { splitLineSuffix } from "./harness/uri.ts";
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
});

describe("review rows plan", () => {
  const options = {
    filter: "reviewable" as const,
    include: { terms: false, threads: false, duplicates: false, patch: false },
  };

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
});

describe("draft 回填", () => {
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

  test("line 可省：按 key 定位，手写的错行被 key 覆盖", async () => {
    const space = pack([row("a", "A", "甲", 41), row("b", "B", "乙", 42)]);
    const payload = JSON.stringify({
      prNumber: 7,
      headSha: "head",
      verdict: "changes",
      summary: "两处",
      comments: [
        { id: "c1", path: ZH, key: "a", severity: "major", mqm: "accuracy/mistranslation", body: "错", zhNew: "丙" },
        { id: "c2", path: ZH, line: 3, key: "b", mqm: "accuracy/reversed", body: "错", zhNew: "丁" },
      ],
    });
    const filled = JSON.parse(await withServerFilledFields(7, payload, space)) as {
      comments: Record<string, unknown>[];
    };
    expect(filled.comments[0]).toMatchObject({ line: 41, suggestion: '    "a": "丙",' });
    expect(filled.comments[1]).toMatchObject({ line: 42, severity: "critical", suggestion: '    "b": "丁",' });
  });
});

describe("terms 归组", () => {
  test("missed 带命中该术语的 key", () => {
    const index = buildTermIndex({ "terms-v1.tsv": "en\tzh\nA\t甲\n" });
    const view = aggregateTerms(pack([row("a", "A", "乙", 10), row("b", "A", "乙", 20)]), index, {
      queries: [],
      changed: true,
    });
    expect(view.groups[0]?.missed[0]).toMatchObject({ en: "A", keys: ["a", "b"] });
  });
});

describe("行范围", () => {
  test("查询前只认 :N / :N-M，其它选择器指向 URI 末尾", () => {
    expect(splitLineSuffix("files/a.json:85-125")).toEqual({ path: "files/a.json", range: { start: 85, end: 125 } });
    expect(splitLineSuffix("files/a.json")).toEqual({ path: "files/a.json", range: null });
    expect(() => splitLineSuffix("files/a.json:85-")).toThrow(/末尾/);
    expect(() => splitLineSuffix("files/a.json:-5")).toThrow(/末尾/);
    expect(() => splitLineSuffix("files/a.json:1-30,-30")).toThrow(/末尾/);
    expect(() => splitLineSuffix("files/a.json:raw")).toThrow(/末尾/);
  });
});

describe("bash heredoc", () => {
  test("heredoc 里的程序与文件改写分别改走 eval 与 write", () => {
    expect(heredocReason("python - <<'EOF'\nprint(1)\nEOF")).toContain("eval");
    expect(heredocReason('cd "$CFPA_REPO" && python3 - <<EOF\nprint(1)\nEOF')).toContain("eval");
    expect(heredocReason("cat >> terms.tsv <<'EOF'\n甲\t乙\nEOF")).toContain("write");
    expect(heredocReason("cat > notes.md <<EOF\n正文\nEOF")).toContain("write");
  });

  test("脚本文件、单行 -c 与普通命令放行", () => {
    expect(
      heredocReason('python3 "$CFPA_ROOT/skills/prep/scripts/termgen/final.py" mod prep ./scope -o ./prep/x'),
    ).toBeUndefined();
    expect(heredocReason('python -c "import json;print(1)"')).toBeUndefined();
    expect(heredocReason("git log --oneline -3")).toBeUndefined();
  });
});

describe("本地分片预取", () => {
  test("8 KB 边界切在多字节字符中间时整份送达，不判成二进制", async () => {
    const sessionId = `test-prefetch-${Date.now().toString(36)}`;
    const dir = localDir(sessionId);
    await mkdir(join(dir, "pack"), { recursive: true });
    // 3000 个「甲」= 9000 B，8192 落在第二个字节上。
    await writeFile(join(dir, "pack", "s.md"), `${"甲".repeat(3000)}\n结尾标记\n`, "utf8");
    try {
      const joined = await prefetch(["local://pack/s.md"], sessionId);
      expect(joined).not.toContain("Cannot read binary");
      expect(joined).toContain("结尾标记");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sandbox", () => {
  test("写入正文里的敏感词不触发沙箱密钥扫描", () => {
    expect(secretReason({ path: "pr://1/draft", content: "process.env / .env 只是评论正文" })).toBeUndefined();
    expect(secretReason({ command: "printenv" })).toContain("环境变量");
  });

  test("保留设备名不能当重定向目标", () => {
    expect(execPathReason("bash", { command: "make >nul 2>&1" })).toContain("保留设备名");
    expect(execPathReason("bash", { command: "ls 2>NUL" })).toContain("保留设备名");
    expect(execPathReason("bash", { command: "make >/dev/null" })).toBeUndefined();
    expect(execPathReason("bash", { command: "node check.js" })).toBeUndefined();
  });
});

describe("sandbox 读取 scheme", () => {
  test("artifact/agent 放行，未知 scheme 与越界绝对路径拒绝", () => {
    expect(readPathReason("read", { path: "artifact://12" }, "D:/ws")).toBeUndefined();
    expect(readPathReason("read", { path: "agent://review-1/2" }, "D:/ws")).toBeUndefined();
    expect(readPathReason("read", { path: "file:///etc/passwd" }, "D:/ws")).toContain("不在范围内");
    expect(readPathReason("read", { path: "D:/elsewhere/a.txt" }, "D:/ws")).toContain("只读会话 workspace");
  });
});
