import type {
  DiscussionsBrief,
  Finding,
  PrDetail,
  ReviewBrief,
  ReviewDraft,
  WorkspaceBrief,
} from "@cfpa/contracts/api";
import type { Pack } from "@cfpa/review-core/pack";
import { DRAFT_FILE, parseDraftFile } from "@cfpa/review-core/draft";
import { parseLangPath } from "@cfpa/review-core/domain/path";
import { readLocal } from "../../agent/local-store.ts";
import { gh } from "../../github/client.ts";
import { prdata } from "../../prdata.ts";
import { ensurePrDir, prRoot } from "../../workspace.ts";
import { prDetail } from "../../views/pr.ts";
import { trimBody, visibleIssueComment } from "../format.ts";
import { checksOf, checksSummary } from "./checks.ts";
import { defaultRowsInclude, rowsForPack, workspaceBriefs, type RowsOptions } from "./rows.ts";
import { threadsOf, type ThreadsView } from "./threads.ts";
import { peekPack, loadPack } from "../pack.ts";
import type { HarnessSession } from "../types.ts";

export interface BriefOptions {
  review: boolean;
  rows: Omit<RowsOptions, "include"> & { include?: RowsOptions["include"] };
  session?: HarnessSession;
}

function briefWorkspaces(detail: PrDetail, pack: Pack | null): WorkspaceBrief[] {
  if (pack !== null) return workspaceBriefs(pack);
  return detail.workspaces.map((workspace) => {
    let enPath: string | null = null;
    let zhPath: string | null = null;
    let format: "json" | "lang" = "json";
    for (const path of workspace.files) {
      const parsed = parseLangPath(path);
      if (parsed === null) continue;
      if (parsed.locale === "en_us") enPath = path;
      if (parsed.locale === "zh_cn") {
        zhPath = path;
        format = parsed.format;
      }
    }
    return {
      workspace: `${workspace.slug}/${workspace.version}/${workspace.namespace}`,
      format,
      enPath,
      zhPath,
    };
  });
}

async function discussionsOf(n: number): Promise<{ brief: DiscussionsBrief; threads: ThreadsView }> {
  const threads = await threadsOf(n);
  let issueComments = 0;
  let recentIssueComments: DiscussionsBrief["recentIssueComments"];
  let commentsError: string | undefined;
  try {
    const comments = (await gh.listComments(n)).filter(visibleIssueComment);
    issueComments = comments.length;
    recentIssueComments = comments.slice(-3).map((comment) => ({
      author: comment.author,
      body: trimBody(comment.body, 600),
      at: comment.createdAt,
    }));
  } catch (err) {
    commentsError = err instanceof Error ? err.message : String(err);
  }
  return {
    brief: {
      available: threads.available || commentsError === undefined,
      issueComments,
      reviewThreads: threads.threads.length,
      openThreads: threads.threads.filter((thread) => !thread.resolved).length,
      pendingReviewId: threads.pendingReviewId,
      ...(recentIssueComments === undefined ? {} : { recentIssueComments }),
      ...(threads.error === undefined && commentsError === undefined
        ? {}
        : { error: [threads.error, commentsError].filter(Boolean).join("；") }),
    },
    threads,
  };
}

async function draftSummaryOf(n: number, session?: HarnessSession): Promise<ReviewBrief["draft"]> {
  const raw = session === undefined ? null : await readLocal(session.sessionId, DRAFT_FILE);
  const stored: ReviewDraft | null = raw === null ? null : parseDraftFile(raw.content);
  const draft = stored !== null && stored.prNumber === n ? stored : null;
  return {
    exists: draft !== null,
    ...(draft?.updatedAt === undefined ? {} : { updatedAt: draft.updatedAt }),
    ...(draft?.publishedAt === undefined ? {} : { publishedAt: draft.publishedAt }),
    ...(draft?.publishedUrl === undefined ? {} : { publishedUrl: draft.publishedUrl }),
    read: `pr://${n}/draft`,
    write: `pr://${n}/draft`,
    publish: `pr://${n}/review`,
  };
}

function nextOf(n: number, detail: PrDetail, rowsNext: string | null, hasPack: boolean, specialTotal: number): string[] {
  const next = new Set<string>();
  if (rowsNext !== null) next.add(rowsNext);
  if (specialTotal > 0) next.add(`read pr://${n}/special-files?include=text&limit=6`);
  if (detail.workspaces.length === 0) {
    next.add(`read pr://${n}/files`);
    next.add(`read pr://${n}/checks`);
  } else {
    if (!hasPack) next.add(`read pr://${n}/rows?filter=reviewable&limit=120`);
    next.add(`read pr://${n}/terms?changed=1`);
    next.add(`read pr://${n}/draft`);
  }
  if (rowsNext === null) next.add(`read pr://${n}?review=1&limit=120`);
  return [...next];
}

function warningsOf(findings: readonly Finding[]): Finding[] {
  const rank = { critical: 0, major: 1, minor: 2, neutral: 3 } as const;
  return findings
    .filter((finding) => finding.severity === "critical" || finding.severity === "major")
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, 20);
}

/** 一次拿全貌：PR、工作区、检查、讨论、特殊文件、草稿、下一步；review=1 再附第一页行。 */
export async function reviewBrief(n: number, options: BriefOptions): Promise<ReviewBrief> {
  const detail = await prDetail(n);
  const checks = await checksOf(n);
  const pack = options.review ? await loadPack(n) : peekPack(n, detail.headSha);
  const workspaces = briefWorkspaces(detail, pack);
  const [discussion, draft, localRoot] = await Promise.all([
    discussionsOf(n),
    draftSummaryOf(n, options.session),
    ensurePrDir(n, detail.headSha).catch(() => prRoot(n)),
  ]);
  const rows =
    options.review && pack !== null
      ? await rowsForPack(n, pack, discussion.threads, {
          ...options.rows,
          include: options.rows.include ?? defaultRowsInclude(),
        })
      : undefined;
  const additions = detail.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = detail.files.reduce((sum, file) => sum + file.deletions, 0);
  const checksView = checksSummary(checks);
  return {
    next: nextOf(n, detail, rows?.next ?? null, pack !== null, detail.specialFiles.length),
    hint:
      checksView.hint ??
      (detail.workspaces.length === 0
        ? "没有可预审的语言包工作区；先看 checks 的路径问题和 special-files。"
        : `审查从 rows 开始；一次拿全貌用 read pr://${n}?review=1&limit=120。`),
    pr: {
      number: detail.number,
      title: detail.title,
      author: detail.author,
      state: detail.state,
      draft: detail.draft,
      labels: detail.labels,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      headSha: detail.headSha,
      slugs: detail.slugs,
      htmlUrl: detail.htmlUrl,
      baseRef: detail.baseRef,
      baseSha: detail.baseSha,
      headRef: detail.headRef,
      headRepo: detail.headRepo,
    },
    localRoot,
    counts: {
      files: detail.files.length,
      additions,
      deletions,
      workspaces: detail.workspaces.length,
      specialFiles: detail.specialFiles.length,
      related: detail.related.length,
      changedRows: rows?.counts.changed ?? pack?.counts.changed ?? null,
      flaggedRows: rows?.counts.flagged ?? pack?.counts.flagged ?? null,
    },
    files: {
      total: detail.files.length,
      items: detail.files.slice(0, 300),
      truncated: detail.files.length > 300,
    },
    workspaces,
    checks: checksView,
    warnings: warningsOf(checks.findings),
    specialFiles: {
      total: detail.specialFiles.length,
      paths: detail.specialFiles.slice(0, 50),
      truncated: detail.specialFiles.length > 50,
    },
    related: detail.related,
    discussions: discussion.brief,
    draft,
    capabilities: {
      writeScope: options.session?.writeScope ?? "off",
      publish: (options.session?.writeScope ?? "off") === "on",
    },
    ...(rows === undefined ? {} : { rows }),
  };
}

