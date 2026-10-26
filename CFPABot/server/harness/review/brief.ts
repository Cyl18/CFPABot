import type {
  DiscussionsBrief,
  Finding,
  PrDetail,
  ReviewBrief,
  ReviewDraft,
  ReviewPlan,
  WorkspaceBrief,
} from "@cfpa/contracts/api";
import { SEVERITY_RANK } from "@cfpa/contracts/api";
import type { Pack } from "@cfpa/review-core/pack";
import { parseLangPath } from "@cfpa/review-core/domain/path";
import { gh, type GhComment } from "../../github/client.ts";
import { paths } from "../../paths.ts";
import { prdata } from "../../prdata.ts";
import { ensurePrDir, prRoot } from "../../workspace.ts";
import { prDetail } from "../../views/pr.ts";
import { trimBody, visibleIssueComment } from "../format.ts";
import { checksOf, checksSummary } from "./checks.ts";
import { storedDraftOf } from "./draft.ts";
import { defaultRowsInclude, reviewRowsForPack, rowsUri, workspaceBriefs, type RowsOptions } from "./rows.ts";
import { threadsOf, type ThreadsView } from "./threads.ts";
import { peekPack, loadPack } from "../pack.ts";
import { RESULT_BUDGET_BYTES } from "../result.ts";
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
  headSha: string | null,
): Promise<{ brief: DiscussionsBrief; threads: ThreadsView; comments: GhComment[] | null }> {
  const threads = await threadsOf(n, headSha);
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
  const stored = await storedDraftOf(session?.sessionId);
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
  if (plan !== undefined && !plan.fits) next.add(`write pr://${n}/pack {}`);
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
  return findings
    .filter((finding) => finding.severity === "critical" || finding.severity === "major")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function tallyOf(findings: readonly Finding[]): { critical: number; major: number; minor: number; neutral: number } {
  const counts = { critical: 0, major: 0, minor: 0, neutral: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function fitBrief(brief: ReviewBrief, rowsLink: string | null): ReviewBrief {
  if (Buffer.byteLength(JSON.stringify(brief)) <= RESULT_BUDGET_BYTES) return brief;
  const reduced = { ...brief };
  if (reduced.rows !== undefined) {
    delete reduced.rows;
    if (rowsLink !== null) {
      reduced.hint = `${reduced.hint} 简报预算不足，rows 未内嵌，read ${rowsLink} 取全集。`;
      reduced.next = [`read ${rowsLink}`, ...reduced.next];
    }
  }
  if (Buffer.byteLength(JSON.stringify(reduced)) <= RESULT_BUDGET_BYTES) return reduced;
  reduced.files = { ...reduced.files, items: [], truncated: true };
  reduced.specialFiles = { ...reduced.specialFiles, paths: [], truncated: true };
  reduced.related = [];
  reduced.checks = { ...reduced.checks, top: [] };
  reduced.discussions = { ...reduced.discussions };
  delete reduced.discussions.recentIssueComments;
  if (Buffer.byteLength(JSON.stringify(reduced)) <= RESULT_BUDGET_BYTES) return reduced;
  reduced.workspaces = [];
  reduced.hint = `${reduced.hint} 工作区清单过大已省略。`;
  return reduced;
}

/** 一次拿全貌：PR、工作区、检查、讨论、特殊文件、草稿、下一步；review=1 附全集或分片 plan。 */
export async function reviewBrief(n: number, options: BriefOptions): Promise<ReviewBrief> {
  const detail = await prDetail(n);
  const pack = options.review ? await loadPack(n) : peekPack(n, detail.headSha);
  const workspaces = briefWorkspaces(detail, pack);
  const [discussion, draft, localRoot] = await Promise.all([
    discussionsOf(n, detail.headSha),
    draftSummaryOf(n, options.session),
    ensurePrDir(n).catch(() => prRoot(n)),
  ]);
  const checks = await checksOf(n, discussion.comments);
  const rowsOptions: RowsOptions = {
    ...options.rows,
    include: options.rows.include ?? defaultRowsInclude(),
  };
  const reviewed =
    options.review && pack !== null
      ? await reviewRowsForPack(n, pack, discussion.threads, rowsOptions)
      : undefined;
  const complete = reviewed?.page.complete === true ? reviewed.page : undefined;
  let rows = complete;
  if (complete !== undefined) {
    const pruned = { ...complete };
    delete pruned.workspaces;
    rows = pruned;
  }
  const plan = reviewed?.plan;
  const additions = detail.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = detail.files.reduce((sum, file) => sum + file.deletions, 0);
  const checksView = checksSummary(checks);
  const localFindings =
    pack === null
      ? []
      : pack.workspaces.flatMap((workspace) => [
          ...workspace.checks,
          ...workspace.rows.flatMap((row) => row.findings),
        ]);
  const localMajor = localFindings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "major",
  );
  // 没有 bot 报告时 counts/top 是空的，模型会以为机械项没跑；用本地预审补上。
  if (checksView.status === "unknown" && localFindings.length > 0) {
    checksView.source = "local";
    checksView.unitCount = pack === null ? 0 : pack.workspaces.length;
    checksView.counts = tallyOf(localFindings);
    checksView.top = [...localFindings]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, 10);
    checksView.topTotal = localFindings.length;
    checksView.hint = [checksView.hint, "counts/top 由本地预审填充（键集/占位符/标签/术语），逐行见 rows[].findings。"]
      .filter(Boolean)
      .join(" ");
  }
  const fallbackHint =
    detail.workspaces.length === 0
      ? "没有可预审的语言包工作区；先看 checks 的路径问题和 special-files。"
      : plan !== undefined && !plan.fits
        ? `共 ${plan.total} 行 / ${plan.bytes} B，超过单页预算；要派单先 write pr://${n}/pack {}，分片只作抽查（plan.slices）。`
        : `审查从 rows 开始；一次拿全貌用 read pr://${n}?review=1。`;
  const warnings = warningsOf([...checks.findings, ...localFindings]);
  const warningsShown = warnings.slice(0, 20);
  const hint = [
    localMajor.length === 0 ? undefined : `本地机械检查 ${localMajor.length} 条（含键集/占位符/标签/术语），见 warnings。`,
    warnings.length > warningsShown.length
      ? `warnings 只列前 ${warningsShown.length} 条（共 ${warnings.length}）；全量按 rows?filter=flagged 翻页。`
      : undefined,
    pack?.workspacesTruncated === true ? `预审只覆盖前 ${pack.workspaces.length} 个工作区。` : undefined,
    checksView.hint ?? fallbackHint,
  ]
    .filter(Boolean)
    .join(" ");
  const next = nextOf(n, detail, rows?.next ?? null, plan, pack !== null, reviewed !== undefined, detail.specialFiles.length);
  if (warnings.length > warningsShown.length) {
    next.unshift(
      `read ${rowsUri(n, { filter: "flagged", include: { terms: false, threads: false, duplicates: false, patch: false } })}`,
    );
  }
  const brief: ReviewBrief = {
    next,
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
      workspaces: pack?.counts.workspaces ?? detail.workspaces.length,
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
    warnings: warningsShown,
    warningsTotal: warnings.length,
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
  return fitBrief(brief, reviewed === undefined ? null : rowsUri(n, rowsOptions));
}

