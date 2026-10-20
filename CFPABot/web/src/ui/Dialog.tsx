import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Button } from "@/ui/Button.tsx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const SIZES = { sm: "max-w-md", md: "max-w-2xl", lg: "max-w-4xl" } as const;

export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: DialogProps) {
  const previousFocus = useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
          <DialogPrimitive.Content
            onOpenAutoFocus={() => {
              previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }}
            onCloseAutoFocus={() => {
              previousFocus.current?.focus();
            }}
            className={cn("relative w-full rounded-lg border border-line bg-surface shadow-[var(--shadow-panel)]", SIZES[size])}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
                {description !== undefined && (
                  <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
                <X aria-hidden="true" className="size-4" />
              </Button>
            </header>
            <div className="scroll-thin max-h-[65vh] overflow-y-auto px-4 py-3">{children}</div>
            {footer !== undefined && (
              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>
            )}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
