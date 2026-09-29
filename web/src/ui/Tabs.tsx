import { useRef } from "react";
import { cn } from "@/lib/cn.ts";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export type TabVariant = "segmented" | "underline";

export function tabClass(active: boolean, variant: TabVariant = "segmented", className?: string): string {
  if (variant === "underline") {
    return cn(
      "inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm transition-colors",
      active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:border-line hover:text-fg",
      className,
    );
  }
  return cn(
    "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors",
    active ? "bg-accent/15 font-medium text-accent" : "text-muted hover:bg-elevated hover:text-fg",
    className,
  );
}

export function tabListClass(variant: TabVariant = "segmented", className?: string): string {
  return cn(
    "scroll-thin flex items-center overflow-x-auto",
    variant === "underline" ? "gap-1 overflow-y-hidden border-b border-line" : "h-9 w-fit max-w-full gap-0.5 rounded-lg border border-line bg-surface px-[3px]",
    className,
  );
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  variant?: TabVariant;
  className?: string;
}

export function Tabs<T extends string>({ items, value, onChange, ariaLabel, variant = "segmented", className }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null);

  function move(delta: number) {
    const index = items.findIndex((item) => item.id === value);
    if (index < 0) return;
    const next = items[(index + delta + items.length) % items.length];
    if (!next) return;
    onChange(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={tabListClass(variant, className)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab={item.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={tabClass(active, variant)}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
