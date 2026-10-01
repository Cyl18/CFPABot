import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Popover } from "@/ui/Popover.tsx";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-elevated text-muted",
  accent: "border-accent/40 bg-accent-soft text-accent",
  ok: "border-ok/40 bg-ok/15 text-ok",
  warn: "border-warn/40 bg-warn/15 text-warn",
  danger: "border-danger/40 bg-danger/15 text-danger",
  info: "border-info/40 bg-info/15 text-info",
};

const BADGE_BASE = "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-xs font-medium leading-none";

export interface BadgeProps {
  tone?: BadgeTone;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "neutral", title, className, children }: BadgeProps) {
  return (
    <span title={title} className={cn(BADGE_BASE, "shrink-0", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function LabelChip({ label }: { label: string }) {
  return (
    <span title={label} className={cn(BADGE_BASE, "min-w-0 max-w-44 shrink font-mono", TONES.neutral)}>
      <span className="truncate">{label}</span>
    </span>
  );
}

export interface TagListProps {
  items: readonly string[];
  max: number;
  label: string;
  className?: string;
}

export function TagList({ items, max, label, className }: TagListProps) {
  if (items.length === 0) return <span className="text-muted">-</span>;
  const shown = items.length > max ? items.slice(0, Math.max(1, max - 1)) : items;
  const rest = items.length - shown.length;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((item) => (
        <LabelChip key={item} label={item} />
      ))}
      {rest > 0 && (
        <Popover
          label={`${label}（共 ${items.length} 个）`}
          trigger={<span className={cn(BADGE_BASE, "shrink-0 tabular-nums", TONES.neutral, "hover:border-accent/50 hover:text-fg")}>+{rest}</span>}
        >
          <p className="mb-2 text-xs text-muted">
            {label} · {items.length}
          </p>
          <ul className="flex flex-wrap gap-1">
            {items.map((item) => (
              <li key={item} className="min-w-0 max-w-full">
                <LabelChip label={item} />
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  added: "ok",
  removed: "danger",
  modified: "warn",
  changed: "warn",
  renamed: "info",
  copied: "info",
  unchanged: "neutral",
  missing: "danger",
};

const STATUS_TEXT: Record<string, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  changed: "修改",
  renamed: "重命名",
  copied: "复制",
  unchanged: "未变",
  missing: "缺失",
};

export function FileStatusBadge({ status, prefix }: { status: string; prefix?: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? "neutral"}>
      {prefix}
      {STATUS_TEXT[status] ?? status}
    </Badge>
  );
}
