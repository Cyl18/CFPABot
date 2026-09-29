import { ChevronDown } from "lucide-react";
import { useId, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn.ts";
import type { FieldProps } from "@/ui/Input.tsx";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldProps {
  options: readonly SelectOption[];
}

export function Select({ label, hint, error, wrapperClassName, className, options, id, ...rest }: SelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const describedBy = error !== undefined ? `${fieldId}-error` : hint !== undefined ? `${fieldId}-hint` : undefined;
  return (
    <div className={cn("flex flex-col gap-1", wrapperClassName)}>
      {label !== undefined && (
        <label htmlFor={fieldId} className="text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={error !== undefined ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-9 w-full appearance-none rounded-md border border-line bg-surface pl-2.5 pr-8 text-sm text-fg disabled:opacity-60 focus:border-accent focus:outline-none",
            error !== undefined && "border-danger",
            className,
          )}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
      </div>
      {hint !== undefined && error === undefined && (
        <p id={`${fieldId}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={`${fieldId}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
