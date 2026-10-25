import type { ChecksSummary, Finding, ModFileCheck } from "@cfpa/contracts/api";
import { getCheckStatus, isRefreshing } from "../../bot/index.ts";
import { isMainBot } from "../../bot/render.ts";
import { gh, type GhComment } from "../../github/client.ts";
import { prdata } from "../../prdata.ts";

export interface ChecksView {
  status: ChecksSummary["status"];
  headSha: string;
  checkedSha: string | null;
  builtAt: string | null;
  units: string[];
  counts: ChecksSummary["counts"];
  findings: Finding[];
  modFiles: ModFileCheck[];
  error?: string;
  hint?: string;
}

const RANK = { critical: 0, major: 1, minor: 2, neutral: 3 } as const;

/** 信息评论里的报告链接带着检查时的 SHA，是评论里唯一机器可读的检查凭据。 */
export function commentCheckedSha(n: number, comments: readonly GhComment[]): string | null {
  const pattern = new RegExp(`(?:/static/${n}-|/api/Utils/Report/${n}/)([0-9a-f]{7,40})`);
  for (const comment of comments) {
    if (!isMainBot(comment.author, comment.body)) continue;
    const match = pattern.exec(comment.body);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

async function commentsOf(n: number): Promise<GhComment[] | null> {
  try {
    return await gh.listComments(n);
  } catch {
    return null;
  }
}

export function unknownHint(n: number, headSha: string, checkedSha: string | null, readable: boolean): string {
  if (!readable) return "本实例没有该 PR 的检查记录，读取信息评论也失败了；机械项看本地预审（warnings / rows[].findings）。";
  if (checkedSha === null) {
    return "本实例没有该 PR 的检查记录，信息评论里也没有找到检查段；机械项看本地预审（warnings / rows[].findings）。";
  }
  if (headSha.startsWith(checkedSha)) {
    return `信息评论记录该 PR 已在 ${checkedSha} 检查过，但本实例没有结构化报告；评论里的检查段在 pr://${n}/comments 里被过滤，机械项看本地预审（warnings / rows[].findings）。`;
  }
  return `信息评论里的检查基于 ${checkedSha}，当前 head 是 ${headSha.slice(0, 7)}，findings 可能已过期；本实例没有结构化报告，机械项看本地预审（warnings / rows[].findings）。`;
}

/** 空 findings 不等于没跑：把状态、覆盖单元和失败原因一起给出。 */
export async function checksOf(n: number, comments?: readonly GhComment[] | null): Promise<ChecksView> {
  const { pull } = await prdata.files(n);
  const { report, error } = await getCheckStatus(n);
  const status: ChecksView["status"] = isRefreshing(n)
    ? "running"
    : report === null
      ? error === null
        ? "unknown"
        : "failed"
      : report.headSha === pull.headSha
        ? "ok"
        : "stale";
  const counts = { critical: 0, major: 0, minor: 0, neutral: 0 };
  for (const finding of report?.findings ?? []) counts[finding.severity] += 1;
  const findings = report?.findings ?? [];
  const units = report?.units ?? [];
  let hint: string | undefined;
  if (status === "unknown") {
    const list = comments === undefined ? await commentsOf(n) : comments;
    hint = unknownHint(n, pull.headSha, list === null ? null : commentCheckedSha(n, list), list !== null);
  } else if (status === "failed") {
    hint = "本实例记录的上次检查运行失败；报告可能缺失或过期。";
  } else if (status === "ok" && findings.length === 0) {
    hint = `检查已在 ${report?.headSha.slice(0, 7)} 上运行，未发现问题（覆盖 ${units.length} 个单元）。`;
  } else if (status === "stale") {
    hint = `报告基于 ${report?.headSha.slice(0, 7)}，当前 head 是 ${pull.headSha.slice(0, 7)}。`;
  }
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
    ...(hint === undefined ? {} : { hint }),
  };
}

export function checksSummary(view: ChecksView): ChecksSummary {
  return {
    status: view.status,
    headSha: view.headSha,
    checkedSha: view.checkedSha,
    builtAt: view.builtAt,
    unitCount: view.units.length,
    counts: view.counts,
    top: [...view.findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 10),
    modFiles: view.modFiles,
    ...(view.error === undefined ? {} : { error: view.error }),
    ...(view.hint === undefined ? {} : { hint: view.hint }),
  };
}
