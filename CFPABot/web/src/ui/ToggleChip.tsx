import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { TONES, type BadgeTone } from "@/ui/Badge.tsx";

export interface ToggleChipProps {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  mono?: boolean;
  tone?: BadgeTone;
}

export function ToggleChip({ pressed, onClick, children, title, mono = false, tone }: ToggleChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors",
        mono && "font-mono",
        pressed
          ? "border-accent/50 bg-accent-soft text-accent"
          : tone !== undefined
            ? TONES[tone]
            : "border-line bg-elevated text-muted hover:border-muted/40 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
