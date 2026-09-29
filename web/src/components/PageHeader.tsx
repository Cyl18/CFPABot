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
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {back !== undefined && (
          <Link to={back.to} className="mb-1 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            {back.label}
          </Link>
        )}
        <h1 className="text-lg font-semibold">{title}</h1>
        {description !== undefined && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
