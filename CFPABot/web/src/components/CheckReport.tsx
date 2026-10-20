import type { CheckItem, CheckLevel, CheckReport } from "@shared/api.ts";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Markdown } from "@/components/Markdown.tsx";
import { cn } from "@/lib/cn.ts";
import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const LEVEL_ICON: Record<CheckLevel, ReactNode> = {
  error: <CircleX aria-label="错误" className="size-4 text-danger" />,
  warn: <TriangleAlert aria-label="警告" className="size-4 text-warn" />,
  info: <Info aria-label="提示" className="size-4 text-info" />,
  ok: <CircleCheck aria-label="通过" className="size-4 text-ok" />,
};

const LEVEL_RANK: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2, ok: 3 };

const CODE_RANK: Record<string, number> = { mod_not_found: 0, slug_changed: 0, mod_domain: 1, key_parity: 2, mod_en: 3 };

type Filter = "attention" | "info" | "ok" | "all";

const FILTERS: readonly { id: Filter; label: string; levels: readonly CheckLevel[] }[] = [
  { id: "attention", label: "需关注", levels: ["error", "warn"] },
  { id: "info", label: "提示", levels: ["info"] },
  { id: "ok", label: "通过", levels: ["ok"] },
  { id: "all", label: "全部", levels: ["error", "warn", "info", "ok"] },
];

const LEADING_GLYPH = /^\s*(?:✔|❌|⚠|❗|ℹ)\uFE0F?\s*/u;

interface Section {
  key: string;
  title: string;
  items: CheckItem[];
  worst: CheckLevel;
}

function sectionsOf(items: readonly CheckItem[]): Section[] {
  const groups = new Map<string, CheckItem[]>();
  for (const item of items) {
    const key = item.unit ?? "";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  }
  const sections = [...groups].map(([key, list]): Section => {
    const sorted = [...list].sort((a, b) => (CODE_RANK[a.code] ?? 9) - (CODE_RANK[b.code] ?? 9));
    const worst = sorted.reduce<CheckLevel>((acc, item) => (LEVEL_RANK[item.level] < LEVEL_RANK[acc] ? item.level : acc), "ok");
    return { key, title: key === "" ? "PR 整体" : key, items: key === "" ? list : sorted, worst };
  });
  return sections.sort((a, b) => Number(a.key !== "") - Number(b.key !== ""));
}

function CheckItemRow({ item }: { item: CheckItem }) {
  return (
    <li className="flex gap-2.5 px-3 py-2">
      <span className="mt-0.5 shrink-0">{LEVEL_ICON[item.level]}</span>
      <div className="min-w-0 flex-1">
        {item.path !== undefined && (
          <code className="block truncate font-mono text-xs text-muted" title={item.path}>
            {item.path}
          </code>
        )}
        <Markdown>{item.message.replace(LEADING_GLYPH, "")}</Markdown>
      </div>
      <span className="shrink-0 pt-0.5 font-mono text-[11px] text-muted/70">{item.code}</span>
    </li>
  );
}

function SectionBlock({ section, levels }: { section: Section; levels: readonly CheckLevel[] }) {
  const shown = section.items.filter((item) => levels.includes(item.level));
  if (shown.length === 0) return null;
  const hidden = section.items.length - shown.length;
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line bg-elevated/40 px-3 py-1.5">
        {LEVEL_ICON[section.worst]}
        <h4 className={cn("min-w-0 truncate text-xs font-medium", section.key !== "" && "font-mono")} title={section.title}>
          {section.title}
        </h4>
        {hidden > 0 && <span className="ml-auto shrink-0 text-xs text-muted">另 {hidden} 项未显示</span>}
      </header>
      <ul className="divide-y divide-line">
        {shown.map((item, index) => (
          <CheckItemRow key={`${item.code}-${item.path ?? ""}-${index}`} item={item} />
        ))}
      </ul>
    </section>
  );
}

export function CheckReportView({ report, className }: { report: CheckReport | null; className?: string }) {
  const [filter, setFilter] = useState<Filter | null>(null);
  if (report === null) {
    return <EmptyState compact title="暂无检查结果" description="信息评论尚未生成，或该 PR 还没有被检查过。" className={className} />;
  }

  const counts = FILTERS.map((option) => ({
    ...option,
    count: report.items.filter((item) => option.levels.includes(item.level)).length,
  }));
  const preferred = filter ?? (counts[0] !== undefined && counts[0].count > 0 ? "attention" : "all");
  const active = counts.find((option) => option.id === preferred && option.count > 0) ?? counts[counts.length - 1];
  const sections = sectionsOf(report.items);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <p className="text-xs text-muted">
        检查提交 <code className="font-mono">{report.headSha.slice(0, 7)}</code> · {formatDateTime(report.generatedAt)} · {formatRelative(report.generatedAt)}
      </p>
      {report.items.length === 0 ? (
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
          <div className="flex flex-col gap-2">
            {sections.map((section) => (
              <SectionBlock key={section.key} section={section} levels={active?.levels ?? []} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
