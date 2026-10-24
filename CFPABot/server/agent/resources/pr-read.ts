import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getCheckReport } from "../../bot/index.ts";
import { gh, serverGraphql } from "../../github/client.ts";
import { anonymousReviewState } from "../../github/review.ts";
import { prdata } from "../../prdata.ts";
import { ensurePrDir } from "../../workspace.ts";
import { sidePaths } from "../../domain/pr.ts";
import { prDetail } from "../../views/pr.ts";
import { specialPairContent, specialPairs } from "../../views/special.ts";
import { compareWorkspace } from "../../views/workspace.ts";
import { loadPack, packSummary, peekPack, selectRows, workspaceKey } from "../pack.ts";
import { jsonResult, pageOf, textResult } from "../result.ts";
import { isAgentBody, missingResource, trimBody, visibleIssueComment, visibleReviewComment } from "./format.ts";
import type { PrParts } from "./uri.ts";

const PR_CHILDREN = [
  "files",
  "comments",
  "threads",
  "checks",
  "workspaces",
  "compare",
  "special-files",
  "meta",
  "review",
] as const;

export async function readPr(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const seg = uri.path.split("/").filter(Boolean);
  const sub = seg[0];
  if (sub === undefined) return jsonResult(await prDetail(n));

  if (sub === "files") {
    if (seg.length === 1) {
      const { files } = await prdata.files(n);
      return jsonResult({
        prNumber: n,
        files: files.map((file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        })),
      });
    }
    const requested = seg.slice(1).join("/");
    const { pull, files } = await prdata.files(n);
    const file = files.find((entry) => entry.path === requested || entry.previousPath === requested);
    if (file === undefined) throw new Error(`PR #${n} 没有变更文件：${requested}`);
    const side = uri.query.get("side") === "base" ? "base" : "head";
    const sidePath = sidePaths(file)[side];
    if (sidePath === null) throw new Error(`该文件在 ${side} 侧不存在。`);
    const text = await gh.getFile(sidePath, side === "base" ? pull.baseSha : pull.headSha);
    if (text === null) throw new Error(`文件不存在：${sidePath}`);
    return textResult(text, { requestedPath: requested });
  }

  if (sub === "comments") {
    const [comments, reviews] = await Promise.all([gh.listComments(n), gh.listReviewComments(n)]);
    return jsonResult({
      issueComments: comments
        .filter(visibleIssueComment)
        .map((comment) => ({
          author: comment.author,
          body: trimBody(comment.body),
          at: comment.createdAt,
          isAgent: isAgentBody(comment.body),
        })),
      reviewComments: reviews
        .filter(visibleReviewComment)
        .map((comment) => ({
          author: comment.author,
          path: comment.path,
          line: comment.line,
          body: trimBody(comment.body),
          at: comment.createdAt,
          isAgent: isAgentBody(comment.body),
        })),
    });
  }

  if (sub === "threads") {
    const state = await anonymousReviewState(serverGraphql, n);
    if (state === null) throw new Error("会话不存在或 PR 无法读取。");
    return jsonResult({ headSha: state.headSha, pendingReviewId: state.pendingReviewId, threads: state.threads });
  }

  if (sub === "checks") return jsonResult(await getCheckReport(n));

  if (sub === "workspaces") return jsonResult((await prDetail(n)).workspaces);

  if (sub === "compare") {
    const slug = uri.query.get("slug");
    const version = uri.query.get("version");
    const namespace = uri.query.get("namespace");
    if (!slug || !version || !namespace) {
      throw new Error("pr://<n>/compare 需要 ?slug=&version=&namespace=");
    }
    const result = await compareWorkspace(n, { slug, version, namespace }, prdata.fileSource());
    const page = pageOf(Number(uri.query.get("offset") ?? 0), Number(uri.query.get("limit") ?? 100), 200, 100);
    return jsonResult({
      ...result,
      rows: result.rows.slice(page.offset, page.offset + page.limit),
      total: result.rows.length,
      offset: page.offset,
      limit: page.limit,
    });
  }

  if (sub === "special-files") {
    if (seg[1] === "content") {
      const key = uri.query.get("key");
      if (!key) throw new Error("pr://<n>/special-files/content 需要 ?key=");
      const content = await specialPairContent(n, key, prdata.fileSource());
      if (content === null) throw new Error("特殊文件不存在。");
      return jsonResult(content);
    }
    return jsonResult(await specialPairs(n));
  }

  if (sub === "meta") {
    const detail = await prDetail(n);
    const report = await getCheckReport(n);
    const rank = { critical: 0, major: 1, minor: 2, neutral: 3 } as const;
    const counts = { critical: 0, major: 0, minor: 0, neutral: 0 };
    for (const finding of report?.findings ?? []) counts[finding.severity] += 1;
    return jsonResult({
      pr: {
        number: detail.number,
        title: detail.title,
        author: detail.author,
        state: detail.state,
        draft: detail.draft,
        labels: detail.labels,
        baseSha: detail.baseSha,
        headSha: detail.headSha,
        baseRef: detail.baseRef,
        headRef: detail.headRef,
        htmlUrl: detail.htmlUrl,
      },
      localRoot: await ensurePrDir(n, detail.headSha),
      workspaces: detail.workspaces,
      specialFiles: detail.specialFiles,
      related: detail.related,
      checks:
        report === null
          ? null
          : {
              counts,
              top: [...report.findings].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 10),
              modFiles: report.modFiles,
            },
      warnings:
        report?.findings
          .filter((finding) => finding.severity === "critical" || finding.severity === "major")
          .slice(0, 20) ?? [],
    });
  }

  if (sub === "review") {
    if (seg[1] === "rows") {
      const rebuild = uri.query.get("rebuild") === "1";
      const pack = await loadPack(n, rebuild);
      const filter = uri.query.get("filter") ?? "changed";
      if (filter !== "changed" && filter !== "flagged" && filter !== "all") {
        throw new Error("filter 只能是 changed/flagged/all。");
      }
      const selected = selectRows(pack, {
        workspace: uri.query.get("workspace") ?? undefined,
        filter,
        query: uri.query.get("query") ?? undefined,
      });
      const page = pageOf(Number(uri.query.get("offset") ?? 0), Number(uri.query.get("limit") ?? 60), 200, 60);
      return jsonResult({
        total: selected.length,
        offset: page.offset,
        limit: page.limit,
        rows: selected.slice(page.offset, page.offset + page.limit).map(({ workspace, row }) => ({
          workspace: workspaceKey(workspace),
          key: row.key,
          baseEn: row.baseEn,
          headEn: row.headEn,
          baseZh: row.baseZh,
          headZh: row.headZh,
          line: row.line,
          inHunk: row.inHunk,
          changed: row.changed,
          findings: row.findings,
        })),
      });
    }
    const { pull } = await prdata.files(n);
    const pack = peekPack(n, pull.headSha);
    if (pack === null) {
      return jsonResult({ built: false, headSha: pull.headSha, hint: "read pr://<n>/review/rows to build" });
    }
    return jsonResult({ built: true, ...packSummary(pack) });
  }

  return missingResource(`pr://${n}/${seg.join("/")}`, PR_CHILDREN);
}
