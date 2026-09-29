import type { CheckItem, CheckLevel, CheckReport } from "@shared/api.ts";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Markdown } from "@/components/Markdown.tsx";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";

const LEVEL_META: Record<CheckLevel, { tone: BadgeTone; label: string; icon: ReactNode }> = {
  error: { tone: "danger", label: "错误", icon: <CircleX aria-hidden="true" className="size-4 text-danger" /> },
  warn: { tone: "warn", label: "警告", icon: <TriangleAlert aria-hidden="true" className="size-4 text-warn" /> },
  info: { tone: "info", label: "提示", icon: <Info aria-hidden="true" className="size-4 text-info" /> },
  ok: { tone: "ok", label: "通过", icon: <CircleCheck aria-hidden="true" className="size-4 text-ok" /> },
};

const ORDER: readonly CheckLevel[] = ["error", "warn", "info", "ok"];

function CheckItemRow({ item }: { item: CheckItem }) {
  const meta = LEVEL_META[item.level];
  return (
    <li className="flex gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0">
      <span className="mt-0.5 shrink-0">{meta.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{item.code}</Badge>
          {item.path !== undefined && <code className="truncate font-mono text-xs text-muted">{item.path}</code>}
        </div>
        <Markdown className="mt-1">{item.message}</Markdown>
      </div>
    </li>
  );
}

export function CheckReportView({ report, className }: { report: CheckReport | null; className?: string }) {
  if (report === null) {
    return <EmptyState compact title="暂无检查结果" description="信息评论尚未生成，或该 PR 还没有被检查过。" className={className} />;
  }

  const counts = ORDER.map((level) => ({ level, count: report.items.filter((item) => item.level === level).length }));
  const sorted = [...report.items].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {counts.map(({ level, count }) => (
          <Badge key={level} tone={LEVEL_META[level].tone}>
            {LEVEL_META[level].label} {count}
          </Badge>
        ))}
        <span className="text-xs text-muted">
          {report.items.length} 项 · {report.headSha.slice(0, 7)} · {new Date(report.generatedAt).toLocaleString("zh-CN", { hour12: false })}
        </span>
      </div>
      {sorted.length === 0 ? (
        <EmptyState compact title="没有检查项" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line bg-surface">
          {sorted.map((item, index) => (
            <CheckItemRow key={`${item.code}-${item.path ?? ""}-${index}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
