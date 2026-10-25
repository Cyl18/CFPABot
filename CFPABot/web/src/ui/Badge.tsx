import { SIZE_LABELS } from "@cfpa/contracts/labels";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Popover } from "@/ui/Popover.tsx";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

export const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-elevated text-muted",
  accent: "border-accent/40 bg-accent-soft text-accent",
  ok: "border-ok/40 bg-ok/15 text-ok",
  warn: "border-warn/40 bg-warn/15 text-warn",
  danger: "border-danger/40 bg-danger/15 text-danger",
  info: "border-info/40 bg-info/15 text-info",
};

export function sizeLabelRank(label: string): number {
  const index = SIZE_LABELS.findIndex((entry) => entry.name === label);
  return index === -1 ? SIZE_LABELS.length : index;
}

export function sizeLabelTone(label: string): BadgeTone | undefined {
  return SIZE_LABELS.find((entry) => entry.name === label)?.tone;
}

/** 数字行数标签按从小到大排在最前，其余保持原顺序。 */
export function orderLabels<T extends string>(labels: readonly T[]): T[] {
  return [...labels].sort((a, b) => sizeLabelRank(a) - sizeLabelRank(b));
}

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
    <span title={label} className={cn(BADGE_BASE, "min-w-0 max-w-44 shrink font-mono", TONES[sizeLabelTone(label) ?? "neutral"])}>
      <span className="truncate">{label}</span>
    </span>
  );
}

export interface TagListProps {
  items: readonly string[];
  label: string;
  className?: string;
}

const FALLBACK_GAP = 4;

export function TagList({ items, label, className }: TagListProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const counterRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState<number | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const probe = probeRef.current;
    const counter = counterRef.current;
    if (!host || !probe || !counter) return;
    const measure = () => {
      const avail = host.clientWidth;
      const widths = Array.from(probe.querySelectorAll<HTMLElement>("[data-chip]"), (chip) => chip.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(probe).columnGap) || FALLBACK_GAP;
      const prefix: number[] = [];
      let acc = 0;
      for (const [index, width] of widths.entries()) {
        acc += width + (index === 0 ? 0 : gap);
        prefix.push(acc);
      }
      let count = 0;
      while (count < widths.length && (prefix[count] ?? 0) <= avail) count += 1;
      if (count === 0 && widths.length > 0) count = 1;
      while (count > 1) {
        counter.textContent = `+${widths.length - count}`;
        if ((prefix[count - 1] ?? 0) + gap + counter.getBoundingClientRect().width <= avail) break;
        count -= 1;
      }
      setShown(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return <span className="text-muted">-</span>;
  const ordered = orderLabels(items);
  const visible = shown === null ? [] : ordered.slice(0, shown);
  const rest = shown === null ? 0 : ordered.length - visible.length;

  return (
    <span ref={hostRef} className={cn("relative flex min-w-0 items-center gap-1", className)}>
      <span aria-hidden="true" className="pointer-events-none invisible absolute inset-0 overflow-hidden">
        {/* 探针要撑到自身内容宽度，否则会被单元格压窄，量出的芯片宽度偏小 */}
        <span ref={probeRef} className="flex w-max items-center gap-1">
          {ordered.map((item) => (
            <span key={item} data-chip className="inline-flex">
              <LabelChip label={item} />
            </span>
          ))}
          <span ref={counterRef} className={cn(BADGE_BASE, "shrink-0 tabular-nums", TONES.neutral)}>
            +0
          </span>
        </span>
      </span>
      {visible.map((item) => (
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
            {ordered.map((item) => (
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
