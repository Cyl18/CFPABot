import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-lg border border-line bg-surface shadow-[var(--shadow-panel)]", className)}>{children}</section>;
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, actions, className }: CardHeaderProps) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description !== undefined && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>;
}

export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: "ok" | "warn" | "danger" | "info" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : tone === "info" ? "text-info" : "text-fg";
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums leading-7", color)}>{value}</div>
    </div>
  );
}
