import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckReport, Finding, Severity } from "@cfpa/contracts/api";
import { checkReportPath } from "../paths.ts";
import { CHECK_TRANSLATE_HINT, Lines } from "./render.ts";

const SEVERITY: Record<Severity, { icon: string; label: string; rank: number }> = {
  critical: { icon: "❌", label: "错误", rank: 0 },
  major: { icon: "⚠", label: "警告", rank: 1 },
  minor: { icon: "ℹ", label: "提示", rank: 2 },
  neutral: { icon: "ℹ", label: "备注", rank: 3 },
};

const CODE_RANK: Record<string, number> = { mod_not_found: 0, slug_changed: 0, mod_domain: 1, key_parity: 2, mod_en: 3 };
const MAX_REPORT_EMBED = 30000;

function fold(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>\n\n`;
}

function lineOf(finding: Finding): string {
  const meta = SEVERITY[finding.severity];
  const where = finding.path ? `\`${finding.path}\`：` : finding.key ? `\`${finding.key}\`：` : "";
  const detail = finding.detail.replace(/^\s*(?:✔|❌|⚠|❗|ℹ)\uFE0F?\s*/u, "");
  return `${meta.icon} ${where}${detail}`;
}

function bySeverity(a: Finding, b: Finding): number {
  const rank = SEVERITY[a.severity].rank - SEVERITY[b.severity].rank;
  if (rank !== 0) return rank;
  const code = (CODE_RANK[a.code] ?? 9) - (CODE_RANK[b.code] ?? 9);
  return code !== 0 ? code : a.detail.localeCompare(b.detail);
}

function groupsOf(findings: readonly Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.unit ?? "";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [finding]);
    else list.push(finding);
  }
  return groups;
}

function reportText(report: CheckReport): string {
  const sb = new Lines();
  for (const finding of report.findings) {
    if (!finding.keys || finding.keys.length === 0) continue;
    sb.line(`${finding.unit ?? "PR"} ${finding.code}: ${finding.detail}`);
    for (const key of finding.keys) sb.line(`    ${key}`);
    sb.line();
  }
  for (const file of report.modFiles) {
    if (file.status !== "mismatch") continue;
    sb.line(`${file.slug}/${file.version}/${file.namespace} 与模组语言文件不一致`);
    if (file.missing.length > 0) sb.line(`  缺失: ${file.missing.join(", ")}`);
    if (file.extra.length > 0) sb.line(`  多余: ${file.extra.join(", ")}`);
    if (file.changed.length > 0) sb.line(`  变更: ${file.changed.join(", ")}`);
    sb.line();
  }
  return sb.text().trim();
}

export async function buildCheckComment(report: CheckReport, publicUrl: string): Promise<string> {
  const sb = new Lines();
  const typos = report.findings.filter((finding) => finding.code === "typo");
  const groups = groupsOf(report.findings.filter((finding) => finding.code !== "typo"));
  const pr = groups.get("");
  groups.delete("");
  if (pr !== undefined && pr.length > 0) {
    sb.raw(`${[...pr].sort(bySeverity).map(lineOf).join("\n")}\n\n`);
  }

  const units = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const severity of ["critical", "major", "minor", "neutral"] as const) {
    const chosen = units.filter(
      ([, list]) =>
        list.reduce<Severity>((acc, finding) => (SEVERITY[finding.severity].rank < SEVERITY[acc].rank ? finding.severity : acc), "neutral") ===
        severity,
    );
    if (chosen.length === 0) continue;
    const meta = SEVERITY[severity];
    const names = chosen.map(([unit]) => unit);
    const summary = `${meta.icon} ${meta.label} · ${names.length} 个模组：${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}`;
    const body = chosen
      .map(([unit, list]) => `**${unit}**\n${[...list].sort(bySeverity).map(lineOf).join("\n")}`)
      .join("\n\n");
    sb.raw(fold(summary, body));
  }

  const passed = report.units.filter((unit) => !groups.has(unit));
  if (passed.length > 0) {
    sb.raw(
      fold(
        `✔ 通过 · ${passed.length} 个模组：${passed.slice(0, 3).join("、")}${passed.length > 3 ? " 等" : ""}`,
        passed.join("、"),
      ),
    );
  }

  if (typos.length > 0) {
    const errors = typos.filter((finding) => finding.severity === "major").length;
    const icon = errors > 0 ? "❌" : "ℹ";
    const counts = errors > 0 ? `${typos.length} 条（错误 ${errors}）` : `${typos.length} 条`;
    sb.raw(fold(`${icon} 译名检测 · ${counts}`, `${typos.map(lineOf).join("\n")}\n\n${CHECK_TRANSLATE_HINT}`));
  }

  const text = reportText(report);
  if (text !== "") {
    const reportPath = checkReportPath(report.prNumber, report.headSha);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, text, "utf8");
    const reportUrl = `${publicUrl}/api/Utils/Report/${report.prNumber}/${report.headSha.slice(0, 7)}`;
    if (text.length <= MAX_REPORT_EMBED) {
      sb.raw(fold("📄 详细检查报告", text.replaceAll("\n", "<br>").replaceAll(" ", "&nbsp;")));
    }
    sb.line(`完整报告在 [这里](${reportUrl}) 查看。PR 更新也会更新检查。`);
  }
  return sb.text();
}
