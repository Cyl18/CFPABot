import { ArrowUp } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Button } from "@/ui/Button.tsx";

const MAX_HEIGHT = 180;

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  pending?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  top?: ReactNode;
  hint?: ReactNode;
  leading?: ReactNode;
  error?: string;
  className?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  pending = false,
  disabled = false,
  autoFocus = false,
  top,
  hint,
  leading,
  error,
  className,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const empty = value.trim() === "";
  const submit = () => {
    if (disabled || pending || empty) return;
    onSubmit();
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-panel)] transition-colors focus-within:border-accent/60",
        className,
      )}
    >
      {top !== undefined && <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">{top}</div>}
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        aria-label="消息输入"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        className="scroll-thin block max-h-[180px] min-h-[52px] w-full resize-none bg-transparent px-3.5 py-3 text-sm text-fg placeholder:text-muted/70 focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        {leading}
        <span className="ml-auto min-w-0 truncate text-[11px] text-muted">{error ?? hint}</span>
        <Button
          variant="primary"
          size="sm"
          loading={pending}
          disabled={disabled || empty}
          icon={<ArrowUp aria-hidden="true" className="size-3.5" />}
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
