import type {
  DiscussionsBrief,
  Finding,
  PrDetail,
  ReviewBrief,
  ReviewDraft,
  ReviewPlan,
  WorkspaceBrief,
} from "@cfpa/contracts/api";
import type { Pack } from "@cfpa/review-core/pack";
import { DRAFT_FILE, parseDraftFile } from "@cfpa/review-core/draft";
import { parseLangPath } from "@cfpa/review-core/domain/path";
import { readLocal } from "../../agent/local-store.ts";
import { gh, type GhComment } from "../../github/client.ts";
import { paths } from "../../paths.ts";
import { prdata } from "../../prdata.ts";
import { ensurePrDir, prRoot } from "../../workspace.ts";
import { prDetail } from "../../views/pr.ts";
import { trimBody, visibleIssueComment } from "../format.ts";
import { checksOf, checksSummary } from "./checks.ts";
import { defaultRowsInclude, reviewRowsForPack, workspaceBriefs, type RowsOptions } from "./rows.ts";
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

async function discussionsOf(
  n: number,
): Promise<{ brief: DiscussionsBrief; threads: ThreadsView; comments: GhComment[] | null }> {
  const threads = await threadsOf(n);
  let issueComments = 0;
  let recentIssueComments: DiscussionsBrief["recentIssueComments"];
  let commentsError: string | undefined;
  let comments: GhComment[] | null = null;
  try {
    const all = await gh.listComments(n);
    comments = all;
    const visible = all.filter(visibleIssueComment);
    issueComments = visible.length;
    recentIssueComments = visible.slice(-3).map((comment) => ({
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
    comments,
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

function nextOf(
  n: number,
  detail: PrDetail,
  rowsNext: string | null,
  plan: ReviewPlan | undefined,
  hasPack: boolean,
  hasReviewData: boolean,
  specialTotal: number,
): string[] {
  const next = new Set<string>();
  if (rowsNext !== null) next.add(`read ${rowsNext}`);
  if (plan !== undefined && !plan.fits) {
    for (const slice of plan.slices) next.add(`read ${slice.uri}`);
  }
  if (specialTotal > 0) next.add(`read pr://${n}/special-files?include=text&limit=6`);
  if (detail.workspaces.length === 0) {
    next.add(`read pr://${n}/files`);
    next.add(`read pr://${n}/checks`);
  } else {
    if (!hasPack) next.add(`read pr://${n}?review=1`);
    next.add(`read pr://${n}/terms?changed=1`);
    next.add(`read pr://${n}/draft`);
  }
  if (rowsNext === null && !hasReviewData) next.add(`read pr://${n}?review=1`);
  return [...next];
}

function warningsOf(findings: readonly Finding[]): Finding[] {
  const rank = { critical: 0, major: 1, minor: 2, neutral: 3 } as const;
  return findings
    .filter((finding) => finding.severity === "critical" || finding.severity === "major")
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, 20);
}

/** 一次拿全貌：PR、工作区、检查、讨论、特殊文件、草稿、下一步；review=1 附全集或分片 plan。 */
export async function reviewBrief(n: number, options: BriefOptions): Promise<ReviewBrief> {
  const detail = await prDetail(n);
  const pack = options.review ? await loadPack(n) : peekPack(n, detail.headSha);
  const workspaces = briefWorkspaces(detail, pack);
  const [discussion, draft, localRoot] = await Promise.all([
    discussionsOf(n),
    draftSummaryOf(n, options.session),
    ensurePrDir(n, detail.headSha).catch(() => prRoot(n)),
  ]);
  const checks = await checksOf(n, discussion.comments);
  const reviewed =
    options.review && pack !== null
      ? await reviewRowsForPack(n, pack, discussion.threads, {
          ...options.rows,
          include: options.rows.include ?? defaultRowsInclude(),
        })
      : undefined;
  const rows = reviewed?.page.complete === true ? reviewed.page : undefined;
  const plan = reviewed?.plan;
  const additions = detail.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = detail.files.reduce((sum, file) => sum + file.deletions, 0);
  const checksView = checksSummary(checks);
  const localChecks = pack?.workspaces.flatMap((workspace) => workspace.checks) ?? [];
  const localMajor = localChecks.filter(
    (finding) => finding.severity === "critical" || finding.severity === "major",
  );
  const fallbackHint =
    detail.workspaces.length === 0
      ? "没有可预审的语言包工作区；先看 checks 的路径问题和 special-files。"
      : plan !== undefined && !plan.fits
        ? `共 ${plan.total} 行 / ${plan.bytes} B，超过单页预算；从 next 开始逐片读，共 ${plan.sliceCount} 片，不要用 offset。`
        : `审查从 rows 开始；一次拿全貌用 read pr://${n}?review=1。`;
  const hint = [
    localMajor.length === 0 ? undefined : `本地机械检查 ${localMajor.length} 条（含键集），见 warnings。`,
    checksView.hint ?? fallbackHint,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    next: nextOf(n, detail, rows?.next ?? null, plan, pack !== null, reviewed !== undefined, detail.specialFiles.length),
    hint,
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
    repoRoot: paths.repo,
    ...(plan === undefined ? {} : { plan }),
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
      items: detail.files.slice(0, 100),
      truncated: detail.files.length > 100,
    },
    workspaces,
    checks: checksView,
    warnings: warningsOf([...checks.findings, ...localChecks]),
    specialFiles: {
      total: detail.specialFiles.length,
      paths: detail.specialFiles.slice(0, 30),
      truncated: detail.specialFiles.length > 30,
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

