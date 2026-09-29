import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/cn.ts";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  className?: string;
}

export function PageHeader({ title, description, actions, back, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-5 flex flex-col gap-1", className)}>
      {back !== undefined && (
        <Link to={back.to} className="inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="text-xl font-semibold leading-9 tracking-tight">{title}</h1>
          {description !== undefined && <div className="text-[13px] text-muted">{description}</div>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
