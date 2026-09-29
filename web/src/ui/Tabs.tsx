import { useRef } from "react";
import { cn } from "@/lib/cn.ts";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export function tabClass(active: boolean, className?: string): string {
  return cn(
    "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors",
    active ? "bg-accent/15 font-medium text-accent" : "text-muted hover:bg-elevated hover:text-fg",
    className,
  );
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
}

export function Tabs<T extends string>({ items, value, onChange, ariaLabel, className }: TabsProps<T>) {
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
      className={cn("flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1", className)}
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
            className={tabClass(active)}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
