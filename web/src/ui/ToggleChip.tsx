import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

export interface ToggleChipProps {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  mono?: boolean;
}

export function ToggleChip({ pressed, onClick, children, title, mono = false }: ToggleChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors",
        mono && "font-mono",
        pressed ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-elevated text-muted hover:border-muted/40 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
