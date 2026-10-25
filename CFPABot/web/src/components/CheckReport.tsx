import type { CheckReport, Finding, Severity } from "@cfpa/contracts/api";
import { FINDING_CODE_RANK } from "@cfpa/contracts/findings";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Markdown } from "@/components/Markdown.tsx";
import { cn } from "@/lib/cn.ts";
import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

type Worst = Severity | "ok";

const SEVERITY_ICON: Record<Worst, ReactNode> = {
  critical: <CircleX aria-label="错误" className="size-4 text-danger" />,
  major: <TriangleAlert aria-label="警告" className="size-4 text-warn" />,
  minor: <Info aria-label="提示" className="size-4 text-info" />,
  neutral: <Info aria-label="备注" className="size-4 text-muted" />,
  ok: <CircleCheck aria-label="通过" className="size-4 text-ok" />,
};

const SEVERITY_RANK: Record<Worst, number> = { critical: 0, major: 1, minor: 2, neutral: 3, ok: 4 };

type Filter = "attention" | "info" | "ok" | "all";

const FILTERS: readonly { id: Filter; label: string; severities: readonly Worst[] }[] = [
  { id: "attention", label: "需关注", severities: ["critical", "major", "minor"] },
  { id: "info", label: "提示", severities: ["neutral"] },
  { id: "ok", label: "通过", severities: ["ok"] },
  { id: "all", label: "全部", severities: ["critical", "major", "minor", "neutral", "ok"] },
];

interface Section {
  key: string;
  title: string;
  findings: Finding[];
  worst: Worst;
}

function sectionsOf(report: CheckReport): Section[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of report.findings) {
    const key = finding.unit ?? "";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [finding]);
    else list.push(finding);
  }
  for (const unit of report.units) if (!groups.has(unit)) groups.set(unit, []);
  const sections = [...groups].map(([key, list]): Section => {
    const sorted = [...list].sort(
      (a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || ((FINDING_CODE_RANK[a.code] ?? 9) - (FINDING_CODE_RANK[b.code] ?? 9)),
    );
    const worst = sorted.reduce<Worst>((acc, finding) => (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[acc] ? finding.severity : acc), "ok");
    return { key, title: key === "" ? "PR 整体" : key, findings: sorted, worst };
  });
  return sections.sort((a, b) => Number(a.key !== "") - Number(b.key !== ""));
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <li className="flex gap-2.5 px-3 py-2">
      <span className="mt-0.5 shrink-0">{SEVERITY_ICON[finding.severity]}</span>
      <div className="min-w-0 flex-1">
        {finding.path !== undefined && (
          <code className="block truncate font-mono text-xs text-muted" title={finding.path}>
            {finding.path}
          </code>
        )}
        {finding.key !== undefined && (
          <code className="block truncate font-mono text-xs text-muted" title={finding.key}>
            {finding.key}
          </code>
        )}
        <Markdown>{finding.detail}</Markdown>
        {finding.keys !== undefined && finding.keys.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted">{finding.keys.length} 个 Key</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-elevated/40 p-2 font-mono text-[11px] text-muted">
              {finding.keys.join("\n")}
            </pre>
          </details>
        )}
      </div>
      <span className="shrink-0 pt-0.5 font-mono text-[11px] text-muted/70">{finding.code}</span>
    </li>
  );
}

function SectionBlock({ section, severities }: { section: Section; severities: readonly Worst[] }) {
  if (severities.includes("ok")) {
    if (section.findings.length > 0) return null;
  } else if (!section.findings.some((finding) => severities.includes(finding.severity))) {
    return null;
  }
  const shown = section.findings.filter((finding) => severities.includes(finding.severity));
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line bg-elevated/40 px-3 py-1.5">
        {SEVERITY_ICON[section.worst]}
        <h4 className={cn("min-w-0 truncate text-xs font-medium", section.key !== "" && "font-mono")} title={section.title}>
          {section.title}
        </h4>
      </header>
      {shown.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted">无问题</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((finding, index) => (
            <FindingRow key={`${finding.code}-${finding.key ?? finding.path ?? ""}-${index}`} finding={finding} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CheckReportView({ report, className }: { report: CheckReport | null; className?: string }) {
  const [filter, setFilter] = useState<Filter | null>(null);
  if (report === null) {
    return <EmptyState compact title="暂无检查结果" description="本实例还没有该 PR 的结构化检查报告；信息评论里可能仍有检查段。" className={className} />;
  }

  const counts = FILTERS.map((option) => {
    if (option.id === "ok") {
      return { ...option, count: report.units.filter((unit) => !report.findings.some((finding) => finding.unit === unit)).length };
    }
    return { ...option, count: report.findings.filter((finding) => option.severities.includes(finding.severity)).length };
  });
  const preferred = filter ?? (counts[0] !== undefined && counts[0].count > 0 ? "attention" : "all");
  const active = counts.find((option) => option.id === preferred && option.count > 0) ?? counts[counts.length - 1];
  const sections = sectionsOf(report);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <p className="text-xs text-muted">
        检查提交 <code className="font-mono">{report.headSha.slice(0, 7)}</code> · {formatDateTime(report.generatedAt)} · {formatRelative(report.generatedAt)}
      </p>
      {report.findings.length === 0 && report.units.length === 0 ? (
        <EmptyState compact title="没有检查项" />
      ) : (
        <>
          <div role="group" aria-label="按级别筛选" className="flex flex-wrap items-center gap-1.5">
            {counts
              .filter((option) => option.count > 0 || option.id === "all")
              .map((option) => (
                <ToggleChip key={option.id} pressed={option.id === active?.id} onClick={() => setFilter(option.id)}>
                  {option.label}
                  <span className="tabular-nums opacity-60">{option.count}</span>
                </ToggleChip>
              ))}
          </div>
          <div className="flex flex-col gap-3">
            {sections.map((section) => (
              <SectionBlock key={section.key} section={section} severities={active?.severities ?? []} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
