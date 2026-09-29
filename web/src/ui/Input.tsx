import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn.ts";

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  wrapperClassName?: string;
}

const FIELD_BASE =
  "w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-muted/70 disabled:opacity-60 focus:border-accent focus:outline-none";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldProps {
  icon?: ReactNode;
}

export function Input({ label, hint, error, wrapperClassName, className, id, icon, ...rest }: InputProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const describedBy = error !== undefined ? `${fieldId}-error` : hint !== undefined ? `${fieldId}-hint` : undefined;
  const input = (
    <input
      id={fieldId}
      aria-invalid={error !== undefined ? true : undefined}
      aria-describedby={describedBy}
      className={cn(FIELD_BASE, "h-9", icon !== undefined && "pl-8", error !== undefined && "border-danger", className)}
      {...rest}
    />
  );
  return (
    <div className={cn("flex flex-col gap-1", wrapperClassName)}>
      {label !== undefined && (
        <label htmlFor={fieldId} className="text-xs font-medium text-muted">
          {label}
        </label>
      )}
      {icon === undefined ? (
        input
      ) : (
        <div className="relative">
          <span aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted [&>svg]:size-4">
            {icon}
          </span>
          {input}
        </div>
      )}
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

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldProps {}

export function Textarea({ label, hint, error, wrapperClassName, className, id, ...rest }: TextareaProps) {
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
      <textarea
        id={fieldId}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy}
        className={cn(FIELD_BASE, "scroll-thin min-h-20 py-2 leading-relaxed", error !== undefined && "border-danger", className)}
        {...rest}
      />
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

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function Checkbox({ label, hint, className, id, ...rest }: CheckboxProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="flex items-start gap-2">
      <input id={fieldId} type="checkbox" className={cn("mt-0.5 size-4 accent-[var(--accent)]", className)} {...rest} />
      <div className="flex flex-col">
        <label htmlFor={fieldId} className="text-sm">
          {label}
        </label>
        {hint !== undefined && <span className="text-xs text-muted">{hint}</span>}
      </div>
    </div>
  );
}
