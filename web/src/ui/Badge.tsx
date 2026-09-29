import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-elevated text-muted",
  accent: "border-accent/40 bg-accent/15 text-accent",
  ok: "border-ok/40 bg-ok/15 text-ok",
  warn: "border-warn/40 bg-warn/15 text-warn",
  danger: "border-danger/40 bg-danger/15 text-danger",
  info: "border-info/40 bg-info/15 text-info",
};

export interface BadgeProps {
  tone?: BadgeTone;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "neutral", title, className, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4", TONES[tone], className)}
    >
      {children}
    </span>
  );
}

export function LabelChip({ label }: { label: string }) {
  return <Badge className="max-w-40 truncate font-mono">{label}</Badge>;
}

const STATUS_TONES: Record<string, BadgeTone> = {
  added: "ok",
  removed: "danger",
  modified: "warn",
  changed: "warn",
  renamed: "info",
  copied: "info",
  unchanged: "neutral",
};

const STATUS_TEXT: Record<string, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  changed: "修改",
  renamed: "重命名",
  copied: "复制",
  unchanged: "未变",
};

export function FileStatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{STATUS_TEXT[status] ?? status}</Badge>;
}
