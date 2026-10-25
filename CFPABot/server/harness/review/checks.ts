import type { ChecksSummary, Finding, ModFileCheck } from "@cfpa/contracts/api";
import { getCheckStatus, isRefreshing } from "../../bot/index.ts";
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

/** 空 findings 不等于没跑：把状态、覆盖单元和失败原因一起给出。 */
export async function checksOf(n: number): Promise<ChecksView> {
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
