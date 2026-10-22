import { Check, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Dialog } from "@/ui/Dialog.tsx";
import { Input } from "@/ui/Input.tsx";

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

export interface OptionPickerProps {
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  icon: ReactNode;
  searchable?: boolean;
  disabled?: boolean;
}

export function OptionPicker({ label, value, options, onChange, icon, searchable = false, disabled = false }: OptionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const needle = query.trim().toLowerCase();
  const rows = needle === "" ? options : options.filter((option) => option.label.toLowerCase().includes(needle));

  return (
    <>
      <button
        type="button"
        title={label}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs text-fg hover:bg-elevated disabled:pointer-events-none disabled:opacity-50"
      >
        {icon}
        <span className="max-w-56 truncate">{selected?.label ?? (value === "" ? label : value)}</span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label} size="sm">
        {searchable && (
          <Input
            autoFocus
            placeholder="按编号或标题搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            wrapperClassName="mb-2"
          />
        )}
        <div className="scroll-thin -mx-1 max-h-[50vh] overflow-y-auto">
          {rows.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">没有匹配项</p>}
          {rows.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated",
                option.value === value && "bg-accent-soft text-accent",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint !== undefined && <span className="shrink-0 text-xs text-muted">{option.hint}</span>}
              {option.value === value && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}
