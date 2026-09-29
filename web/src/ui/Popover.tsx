import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn.ts";

const GAP = 6;
const MARGIN = 8;
const CLOSE_DELAY = 120;

export interface PopoverProps {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
}

export function Popover({ trigger, label, children, className }: PopoverProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const pointerType = useRef<string>("");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const panelId = useId();

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - panel.height;
    const top = below + panel.height > window.innerHeight - MARGIN && above >= MARGIN ? above : below;
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - MARGIN - panel.width));
    setPosition({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (triggerRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail !== 0 && pointerType.current === "mouse") show();
    else setOpen((value) => !value);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="inline-flex shrink-0 rounded"
        onPointerDown={(event) => {
          pointerType.current = event.pointerType;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") show();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") scheduleClose();
        }}
        onBlur={scheduleClose}
        onClick={onClick}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={label}
            style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: "hidden" }}
            className={cn(
              "scroll-thin fixed z-50 max-h-72 w-max max-w-80 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-sm shadow-[var(--shadow-panel)]",
              className,
            )}
            onPointerEnter={cancelClose}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") scheduleClose();
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
