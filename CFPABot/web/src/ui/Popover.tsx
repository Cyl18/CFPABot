import { flip, offset, shift, useFloating, useMergeRefs } from "@floating-ui/react";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
  panelClassName?: string;
}

export function Popover({ trigger, label, children, className, panelClassName }: PopoverProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const pointerType = useRef<string>("");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { refs, floatingStyles, isPositioned } = useFloating({
    open,
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(GAP), flip({ padding: MARGIN }), shift({ padding: MARGIN })],
  });
  const triggerRefs = useMergeRefs([refs.setReference, triggerRef]);
  const panelRefs = useMergeRefs([refs.setFloating, panelRef]);

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (panelRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, CLOSE_DELAY);
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

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
        ref={triggerRefs}
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
            ref={panelRefs}
            id={panelId}
            role="dialog"
            aria-label={label}
            style={isPositioned ? floatingStyles : { ...floatingStyles, visibility: "hidden" }}
            className={cn(
              "scroll-thin z-50 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-sm shadow-[var(--shadow-panel)]",
              panelClassName ?? "max-h-72 w-max max-w-80",
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
