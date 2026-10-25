import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { gh } from "../github/client.ts";
import { prdata } from "../prdata.ts";
import { sidePaths } from "../domain/pr.ts";
import { prDetail } from "../views/pr.ts";
import { compareWorkspace } from "../views/workspace.ts";
import { specialPairContent } from "../views/special.ts";
import { packSummary, peekPack } from "./pack.ts";
import { jsonResult, pageOf, paginate, pickFields, textResult } from "./result.ts";
import { isAgentBody, trimBody, visibleIssueComment, visibleReviewComment } from "./format.ts";
import { missingResource, PR_CHILDREN } from "./catalog.ts";
import { flagParam, listParam, sliceLines, splitLineRange } from "./uri.ts";
import type { PrParts } from "./uri.ts";
import type { HarnessSession } from "./types.ts";
import { checksOf } from "./review/checks.ts";
import { threadsOf } from "./review/threads.ts";
import { reviewBrief } from "./review/brief.ts";
import { defaultRowsInclude, rowsOf, type RowsFilter, type RowsInclude, type RowsOptions } from "./review/rows.ts";
import { termsOf } from "./review/terms.ts";
import { readDraftOf } from "./review/draft.ts";
import { specialPageOf } from "./review/special.ts";

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function filterParam(value: string | null, fallback: RowsFilter): RowsFilter {
  if (value === "reviewable" || value === "changed" || value === "flagged" || value === "all") return value;
  return fallback;
}

function includeParam(raw: string | null): RowsInclude {
  if (raw === null || raw.trim() === "") return defaultRowsInclude();
  const names = new Set(raw.split(",").map((name) => name.trim()));
  if (names.has("none")) return { terms: false, threads: false, duplicates: false, patch: false };
  if (names.has("all")) return { terms: true, threads: true, duplicates: true, patch: true };
  return {
    terms: names.has("terms"),
    threads: names.has("threads"),
    duplicates: names.has("duplicates"),
    patch: names.has("patch"),
  };
}

function rowsQuery(uri: PrParts, fallback: RowsFilter): RowsOptions {
  const keys = listParam(uri.query, "key", "keys");
  return {
    filter: filterParam(uri.query.get("filter"), fallback),
    ...(uri.query.get("workspace") === null ? {} : { workspace: uri.query.get("workspace") ?? undefined }),
    ...(uri.query.get("prefix") === null ? {} : { prefix: uri.query.get("prefix") ?? undefined }),
    ...(keys.length === 0 ? {} : { keys }),
    ...(uri.query.get("query") === null ? {} : { query: uri.query.get("query") ?? undefined }),
    ...(uri.query.get("slice") === null ? {} : { slice: uri.query.get("slice") ?? undefined }),
    ...(numberParam(uri.query.get("offset")) === undefined ? {} : { offset: numberParam(uri.query.get("offset")) }),
    ...(numberParam(uri.query.get("limit")) === undefined ? {} : { limit: numberParam(uri.query.get("limit")) }),
    rebuild: flagParam(uri.query, "rebuild"),
    include: includeParam(uri.query.get("include")),
  };
}

function briefRowsQuery(uri: PrParts): RowsOptions {
  return rowsQuery(uri, "reviewable");
}

async function readFiles(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const seg = uri.path.split("/").filter(Boolean);
  if (seg.length === 1) {
    const { files } = await prdata.files(n);
    const page = paginate(
      files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      })),
      uri.query,
    );
    return jsonResult({
      prNumber: n,
      files: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    });
  }
  const { path: requested, range } = splitLineRange(seg.slice(1).join("/"));
  const { pull, files } = await prdata.files(n);
  const file = files.find((entry) => entry.path === requested || entry.previousPath === requested);
  if (file === undefined) throw new Error(`PR #${n} 没有变更文件：${requested}`);
  if (uri.query.get("format") === "patch") {
    if (file.patch === undefined || file.patch === "") {
      throw new Error(`${file.path} 没有可用的 diff patch（二进制、过大或未变更）；改用 ?side=head 读内容。`);
    }
    return textResult(file.patch, { requestedPath: requested, path: file.path });
  }
  const side = uri.query.get("side") === "base" ? "base" : "head";
  const sidePath = sidePaths(file)[side];
  if (sidePath === null) throw new Error(`该文件在 ${side} 侧不存在。`);
  const text = await gh.getFile(sidePath, side === "base" ? pull.baseSha : pull.headSha);
  if (text === null) throw new Error(`文件不存在：${sidePath}`);
  return textResult(range === null ? text : sliceLines(text, range), { requestedPath: requested, path: sidePath });
}

async function readSpecial(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const seg = uri.path.split("/").filter(Boolean);
  const keys = listParam(uri.query, "key", "keys");
  if (seg[1] === "content") {
    const key = uri.query.get("key");
    if (!key) throw new Error("pr://<n>/special-files/content 需要 ?key=，或直接 read pr://<n>/special-files/<key>。");
    return jsonResult(await specialContentOrThrow(n, key));
  }
  if (seg.length > 1) return jsonResult(await specialContentOrThrow(n, seg.slice(1).join("/")));
  const withText = uri.query.get("include") === "text" || keys.length > 0;
  return jsonResult(
    await specialPageOf(n, {
      keys,
      ...(numberParam(uri.query.get("offset")) === undefined ? {} : { offset: numberParam(uri.query.get("offset")) }),
      ...(numberParam(uri.query.get("limit")) === undefined ? {} : { limit: numberParam(uri.query.get("limit")) }),
      withText,
    }),
  );
}

async function specialContentOrThrow(n: number, key: string) {
  const content = await specialPairContent(n, key, prdata.fileSource());
  if (content === null) {
    throw new Error(`特殊文件不存在：${key}。key 必须与 pr://${n}/special-files 返回的 key 完全一致。`);
  }
  return content;
}

async function readComments(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const [comments, reviews] = await Promise.all([gh.listComments(n), gh.listReviewComments(n)]);
  return jsonResult({
    issueComments: comments
      .filter(visibleIssueComment)
      .map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: isAgentBody(comment.body) ? comment.body : trimBody(comment.body),
        at: comment.createdAt,
        isAgent: isAgentBody(comment.body),
      })),
    reviewComments: reviews
      .filter(visibleReviewComment)
      .map((comment) => ({
        id: comment.id,
        author: comment.author,
        path: comment.path,
        line: comment.line,
        body: isAgentBody(comment.body) ? comment.body : trimBody(comment.body),
        at: comment.createdAt,
        isAgent: isAgentBody(comment.body),
      })),
  });
}

async function readCompare(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const slug = uri.query.get("slug");
  const version = uri.query.get("version");
  const namespace = uri.query.get("namespace");
  if (!slug || !version || !namespace) throw new Error("pr://<n>/compare 需要 ?slug=&version=&namespace=");
  const result = await compareWorkspace(n, { slug, version, namespace }, prdata.fileSource());
  const page = pageOf(numberParam(uri.query.get("offset")), numberParam(uri.query.get("limit")), 500, 100);
  return jsonResult({
    ...result,
    rows: result.rows.slice(page.offset, page.offset + page.limit),
    total: result.rows.length,
    offset: page.offset,
    limit: page.limit,
  });
}

async function readReviewSummary(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const { pull } = await prdata.files(n);
  const pack = peekPack(n, pull.headSha);
  if (pack === null) {
    return jsonResult({
      built: false,
      headSha: pull.headSha,
      next: [`read pr://${n}?review=1`],
      hint: "预审 pack 还没构建；read pr://<n>?review=1 会构建并给出全集或分片 plan。",
    });
  }
  return jsonResult({
    built: true,
    ...packSummary(pack),
    next: [`read pr://${n}?review=1`, `read pr://${n}/terms?changed=1`],
  });
}

export async function readPr(
  uri: PrParts,
  session?: HarnessSession,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const seg = uri.path.split("/").filter(Boolean);
  const sub = seg[0];
  if (sub === undefined) {
    const review = flagParam(uri.query, "review") || flagParam(uri.query, "rows");
    return jsonResult(
      await reviewBrief(n, {
        review,
        rows: briefRowsQuery(uri),
        ...(session === undefined ? {} : { session }),
      }),
    );
  }

  if (sub === "rows") return jsonResult(await rowsOf(n, rowsQuery(uri, "reviewable")));

  if (sub === "review") {
    if (seg[1] === "rows") {
      return jsonResult(await rowsOf(n, rowsQuery(uri, "changed")));
    }
    return readReviewSummary(uri);
  }

  if (sub === "terms") {
    const queries = listParam(uri.query, "term", "q");
    return jsonResult(
      await termsOf(n, {
        queries,
        changed: flagParam(uri.query, "changed") || queries.length === 0,
        ...(numberParam(uri.query.get("offset")) === undefined ? {} : { offset: numberParam(uri.query.get("offset")) }),
        ...(numberParam(uri.query.get("limit")) === undefined ? {} : { limit: numberParam(uri.query.get("limit")) }),
        rebuild: flagParam(uri.query, "rebuild"),
      }),
    );
  }

  if (sub === "draft") return jsonResult(await readDraftOf(n, session?.sessionId));

  if (sub === "files") return readFiles(uri);

  if (sub === "comments") return readComments(uri);

  if (sub === "threads") return jsonResult(await threadsOf(n));

  if (sub === "checks") {
    const view = await checksOf(n);
    const page = paginate(view.findings, uri.query, 500, 100);
    return jsonResult({
      ...view,
      findings: page.items,
      findingsTotal: page.total,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    });
  }

  if (sub === "workspaces") return jsonResult((await prDetail(n)).workspaces);

  if (sub === "related") {
    const page = paginate(prdata.related(n), uri.query, 100, 20);
    return jsonResult({
      related: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
    });
  }

  if (sub === "compare") return readCompare(uri);

  if (sub === "special-files") return readSpecial(uri);

  if (sub === "meta") {
    const brief = await reviewBrief(n, {
      review: false,
      rows: briefRowsQuery(uri),
      ...(session === undefined ? {} : { session }),
    });
    return jsonResult(pickFields(brief, uri.query));
  }

  return missingResource(`pr://${n}/${seg.join("/")}`, PR_CHILDREN);
}

