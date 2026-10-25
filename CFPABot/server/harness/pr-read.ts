import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { gh } from "../github/client.ts";
import { prdata } from "../prdata.ts";
import { sidePaths } from "../domain/pr.ts";
import { prDetail } from "../views/pr.ts";
import { compareWorkspace } from "../views/workspace.ts";
import { specialPairContent, clipSpecialContent } from "../views/special.ts";
import { packSummary, peekPack } from "./pack.ts";
import { jsonResult, numberParam, pageOf, paginate, pickFields, textResult } from "./result.ts";
import { isAgentBody, trimBody, visibleIssueComment, visibleReviewComment } from "./format.ts";
import { missingResource, PR_CHILDREN } from "./catalog.ts";
import { flagParam, listParam, nextPageUri } from "./uri.ts";
import type { PrParts } from "./uri.ts";
import type { HarnessSession } from "./types.ts";
import { checksOf } from "./review/checks.ts";
import { threadsOf } from "./review/threads.ts";
import { reviewBrief } from "./review/brief.ts";
import { defaultRowsInclude, rowsOf, type RowsFilter, type RowsInclude, type RowsOptions } from "./review/rows.ts";
import { termsOf } from "./review/terms.ts";
import { readDraftOf } from "./review/draft.ts";
import { specialPageOf } from "./review/special.ts";

function filterParam(value: string | null, fallback: RowsFilter): RowsFilter {
  if (value === "reviewable" || value === "changed" || value === "flagged" || value === "all") return value;
  if (value === null || value.trim() === "") return fallback;
  throw new Error(`filter 只能是 reviewable / changed / flagged / all，收到：${value}`);
}

function includeParam(raw: string | null): RowsInclude {
  if (raw === null || raw.trim() === "") return defaultRowsInclude();
  const names = [...new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))];
  const known: Record<string, true> = { none: true, all: true, terms: true, threads: true, duplicates: true, patch: true };
  const unknown = names.filter((name) => known[name] !== true);
  if (unknown.length > 0) throw new Error(`include 只认 terms/threads/duplicates/patch/all/none，收到：${unknown.join(", ")}`);
  if (names.includes("none")) {
    if (names.length > 1) throw new Error("include=none 不能和别的字段同时出现。");
    return { terms: false, threads: false, duplicates: false, patch: false };
  }
  if (names.includes("all")) {
    if (names.length > 1) throw new Error("include=all 不能和别的字段同时出现。");
    return { terms: true, threads: true, duplicates: true, patch: true };
  }
  return {
    terms: names.includes("terms"),
    threads: names.includes("threads"),
    duplicates: names.includes("duplicates"),
    patch: names.includes("patch"),
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
      next: nextPageUri(`pr://${n}/files`, uri.query, page.nextOffset),
    });
  }
  const requested = seg.slice(1).join("/");
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
  return textResult(text, { requestedPath: requested, path: sidePath }, {}, { clip: false });
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
  return clipSpecialContent(content);
}

async function readComments(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const [comments, reviews] = await Promise.all([gh.listComments(n), gh.listReviewComments(n)]);
  const limit = pageOf(numberParam(uri.query.get("limit")), undefined, 100, 30).limit;
  const issueOffset = pageOf(numberParam(uri.query.get("issueOffset")), limit, 10_000, 30).offset;
  const reviewOffset = pageOf(numberParam(uri.query.get("reviewOffset")), limit, 10_000, 30).offset;
  const bodyLimit = flagParam(uri.query, "full") ? 20_000 : 2_000;
  const issueAll = comments.filter(visibleIssueComment);
  const reviewAll = reviews.filter(visibleReviewComment);
  const issuePage = issueAll.slice(issueOffset, issueOffset + limit);
  const reviewPage = reviewAll.slice(reviewOffset, reviewOffset + limit);
  const nextIssue = issueOffset + issuePage.length < issueAll.length ? issueOffset + issuePage.length : null;
  const nextReview = reviewOffset + reviewPage.length < reviewAll.length ? reviewOffset + reviewPage.length : null;
  const params = new URLSearchParams(uri.query);
  if (nextIssue !== null) params.set("issueOffset", String(nextIssue));
  if (nextReview !== null) params.set("reviewOffset", String(nextReview));
  params.set("limit", String(limit));
  return jsonResult({
    issueComments: issuePage.map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: trimBody(comment.body, bodyLimit),
      at: comment.createdAt,
      isAgent: isAgentBody(comment.body),
    })),
    issueTotal: issueAll.length,
    reviewComments: reviewPage.map((comment) => ({
      id: comment.id,
      author: comment.author,
      path: comment.path,
      line: comment.line,
      body: trimBody(comment.body, bodyLimit),
      at: comment.createdAt,
      isAgent: isAgentBody(comment.body),
    })),
    reviewTotal: reviewAll.length,
    limit,
    next: nextIssue === null && nextReview === null ? null : `pr://${n}/comments?${params.toString()}`,
  });
}

async function readCompare(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const slug = uri.query.get("slug");
  const version = uri.query.get("version");
  const namespace = uri.query.get("namespace");
  if (!slug || !version || !namespace) throw new Error("pr://<n>/compare 需要 ?slug=&version=&namespace=");
  const includeReview = flagParam(uri.query, "review");
  const reviewKeys = includeReview ? pageOf(undefined, numberParam(uri.query.get("reviewKeys")), 1000, 100).limit : 0;
  const result = await compareWorkspace(n, { slug, version, namespace }, prdata.fileSource(), reviewKeys);
  const { review, reviewEn, ...rest } = result;
  const page = pageOf(numberParam(uri.query.get("offset")), numberParam(uri.query.get("limit")), 500, 100);
  const shown: typeof result.rows = [];
  let bytes = 0;
  for (const row of result.rows.slice(page.offset, page.offset + page.limit)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (shown.length > 0 && bytes + size > 25_000) break;
    shown.push(row);
    bytes += size;
  }
  const nextOffset = page.offset + shown.length < result.rows.length ? page.offset + shown.length : null;
  return jsonResult({
    ...rest,
    ...(includeReview ? { review, reviewEn } : {}),
    rows: shown,
    total: result.rows.length,
    offset: page.offset,
    limit: page.limit,
    nextOffset,
    next: nextPageUri(`pr://${n}/compare`, uri.query, nextOffset),
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

function assertChildless(seg: string[], uri: PrParts): void {
  if (seg.length > 1) throw missingResource(`pr://${uri.number}/${seg.join("/")}`, PR_CHILDREN);
}

export async function readPr(
  uri: PrParts,
  session?: HarnessSession,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const seg = uri.path.split("/").filter(Boolean);
  const sub = seg[0];
  if (sub !== undefined && !PR_CHILDREN.includes(sub)) {
    throw missingResource(`pr://${n}/${seg.join("/")}`, PR_CHILDREN);
  }
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

  if (sub === "rows") {
    assertChildless(seg, uri);
    return jsonResult(await rowsOf(n, rowsQuery(uri, "reviewable")));
  }

  if (sub === "review") {
    if (seg[1] === "rows") {
      if (seg.length > 2) throw missingResource(`pr://${n}/${seg.join("/")}`, PR_CHILDREN);
      return jsonResult(await rowsOf(n, rowsQuery(uri, "changed")));
    }
    if (seg.length > 1) throw missingResource(`pr://${n}/${seg.join("/")}`, PR_CHILDREN);
    return readReviewSummary(uri);
  }

  if (sub === "terms") {
    assertChildless(seg, uri);
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

  if (sub === "draft") {
    assertChildless(seg, uri);
    return jsonResult(await readDraftOf(n, session?.sessionId));
  }

  if (sub === "files") return readFiles(uri);

  if (sub === "comments") {
    assertChildless(seg, uri);
    return readComments(uri);
  }

  if (sub === "threads") {
    assertChildless(seg, uri);
    return jsonResult(await threadsOf(n));
  }

  if (sub === "checks") {
    assertChildless(seg, uri);
    const view = await checksOf(n);
    const page = paginate(view.findings, uri.query, 500, 100);
    return jsonResult({
      ...view,
      findings: page.items,
      findingsTotal: page.total,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
      next: nextPageUri(`pr://${n}/checks`, uri.query, page.nextOffset),
    });
  }

  if (sub === "workspaces") {
    assertChildless(seg, uri);
    return jsonResult((await prDetail(n)).workspaces);
  }

  if (sub === "related") {
    assertChildless(seg, uri);
    const page = paginate(prdata.related(n), uri.query, 100, 20);
    return jsonResult({
      related: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
      next: nextPageUri(`pr://${n}/related`, uri.query, page.nextOffset),
    });
  }

  if (sub === "compare") {
    assertChildless(seg, uri);
    return readCompare(uri);
  }

  if (sub === "special-files") return readSpecial(uri);

  if (sub === "meta") {
    assertChildless(seg, uri);
    const brief = await reviewBrief(n, {
      review: false,
      rows: briefRowsQuery(uri),
      ...(session === undefined ? {} : { session }),
    });
    return jsonResult(pickFields(brief, uri.query));
  }

  return missingResource(`pr://${n}/${seg.join("/")}`, PR_CHILDREN);
}

