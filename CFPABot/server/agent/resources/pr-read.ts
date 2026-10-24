import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getCheckStatus, isRefreshing } from "../../bot/index.ts";
import { gh, serverGraphql } from "../../github/client.ts";
import { anonymousReviewState } from "../../github/review.ts";
import { prdata } from "../../prdata.ts";
import { ensurePrDir } from "../../workspace.ts";
import { sidePaths } from "../../domain/pr.ts";
import { prDetail } from "../../views/pr.ts";
import { specialPairContent, specialPairs } from "../../views/special.ts";
import { compareWorkspace } from "../../views/workspace.ts";
import { loadPack, packSummary, peekPack, selectRows, workspaceKey } from "../pack.ts";
import { jsonResult, pageOf, paginate, textResult } from "../result.ts";
import { isAgentBody, missingResource, trimBody, visibleIssueComment, visibleReviewComment } from "./format.ts";
import type { Finding, ModFileCheck } from "@cfpa/contracts/api";
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
  "related",
] as const;

export async function readPr(uri: PrParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const n = uri.number;
  const seg = uri.path.split("/").filter(Boolean);
  const sub = seg[0];
  if (sub === undefined) return jsonResult(await prDetail(n));

  if (sub === "files") {
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

  if (sub === "checks") {
    const view = await checksOf(n);
    const page = paginate(view.findings, uri.query, 200, 50);
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
      if (!key) {
        throw new Error(
          "pr://<n>/special-files/content 需要 ?key=。key 是带斜杠的相对路径（例：projects/assets/<mod>/<ver>/<ns>/lang/zh_cn.json）；斜杠可直接写，也可编码成 %2F。",
        );
      }
      return jsonResult(await specialContentOrThrow(n, key));
    }
    if (seg.length > 1) return jsonResult(await specialContentOrThrow(n, seg.slice(1).join("/")));
    const page = paginate(await specialPairs(n), uri.query, 100, 20);
    return jsonResult({
      pairs: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      nextOffset: page.nextOffset,
      ...(page.truncated ? { hint: `还有 ${page.total - page.offset - page.items.length} 对；用 ?offset=${page.nextOffset}&limit=${page.limit} 继续。` } : {}),
    });
  }

  if (sub === "meta") {
    const detail = await prDetail(n);
    const checks = await checksOf(n);
    const rank = { critical: 0, major: 1, minor: 2, neutral: 3 } as const;
    const sections: Record<string, unknown> = {
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
      counts: {
        workspaces: detail.workspaces.length,
        specialFiles: detail.specialFiles.length,
        related: detail.related.length,
      },
      workspaces: detail.workspaces.slice(0, 5),
      specialFiles: detail.specialFiles.slice(0, 10),
      related: detail.related.slice(0, 5),
      checks: {
        status: checks.status,
        checkedSha: checks.checkedSha,
        builtAt: checks.builtAt,
        counts: checks.counts,
        top: [...checks.findings].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 10),
        modFiles: checks.modFiles,
        ...(checks.error === undefined ? {} : { error: checks.error }),
        ...(checks.hint === undefined ? {} : { hint: checks.hint }),
      },
      warnings: checks.findings
        .filter((finding) => finding.severity === "critical" || finding.severity === "major")
        .slice(0, 20),
      hint: `列表已裁剪；完整内容用 pr://${n}/workspaces、pr://${n}/special-files、pr://${n}/related（都支持 ?offset=&limit=）。?fields= 只取需要的段。`,
    };
    return jsonResult(pickFields(sections, uri.query));
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
      const rows = selected.slice(page.offset, page.offset + page.limit);
      const nextOffset = page.offset + rows.length < selected.length ? page.offset + rows.length : null;
      return jsonResult({
        total: selected.length,
        offset: page.offset,
        limit: page.limit,
        truncated: nextOffset !== null,
        nextOffset,
        rows: rows.map(({ workspace, row }) => ({
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

async function specialContentOrThrow(n: number, key: string) {
  const content = await specialPairContent(n, key, prdata.fileSource());
  if (content === null) {
    throw new Error(`特殊文件不存在：${key}。key 必须与 pr://${n}/special-files 返回的 key 完全一致。`);
  }
  return content;
}

function pickFields(sections: Record<string, unknown>, query: URLSearchParams): Record<string, unknown> {
  const fields = query.get("fields");
  if (fields === null || fields.trim() === "") return sections;
  const wanted = new Set(fields.split(",").map((field) => field.trim()).filter(Boolean));
  return Object.fromEntries(Object.entries(sections).filter(([key]) => wanted.has(key)));
}

interface ChecksView {
  status: "not_run" | "running" | "ok" | "stale" | "failed";
  headSha: string;
  checkedSha: string | null;
  builtAt: string | null;
  units: string[];
  counts: { critical: number; major: number; minor: number; neutral: number };
  findings: Finding[];
  modFiles: ModFileCheck[];
  error?: string;
  hint?: string;
}

/** 空 findings 不等于没跑：把状态、覆盖单元和失败原因一起给出。 */
async function checksOf(n: number): Promise<ChecksView> {
  const { pull } = await prdata.files(n);
  const { report, error } = await getCheckStatus(n);
  const status: ChecksView["status"] = isRefreshing(n)
    ? "running"
    : report === null
      ? error === null
        ? "not_run"
        : "failed"
      : report.headSha === pull.headSha
        ? "ok"
        : "stale";
  const counts = { critical: 0, major: 0, minor: 0, neutral: 0 };
  for (const finding of report?.findings ?? []) counts[finding.severity] += 1;
  const findings = report?.findings ?? [];
  const units = report?.units ?? [];
  return {
    status,
    headSha: pull.headSha,
    checkedSha: report?.headSha ?? null,
    builtAt: report?.generatedAt ?? null,
    units,
    counts,
    findings,
    modFiles: report?.modFiles ?? [],
    ...(error === null ? {} : { error }),
    ...(status === "not_run" ? { hint: "该 PR 还没有检查报告；等 bot 刷新或请管理员重跑。" } : {}),
    ...(status === "failed" ? { hint: "最近一次检查运行失败；下面的报告可能是旧的或不存在。" } : {}),
    ...(status === "ok" && findings.length === 0
      ? { hint: `检查已在 ${report?.headSha.slice(0, 7)} 上运行，未发现问题（覆盖 ${units.length} 个单元）。` }
      : {}),
    ...(status === "stale" ? { hint: `报告基于 ${report?.headSha.slice(0, 7)}，当前 head 是 ${pull.headSha.slice(0, 7)}。` } : {}),
  };
}
