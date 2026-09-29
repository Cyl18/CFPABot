import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 py-10 text-center", className)}>
      {icon !== undefined && <div className="text-muted">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {description !== undefined && <p className="max-w-lg text-xs text-muted">{description}</p>}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
