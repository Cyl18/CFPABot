import type { ToolCallView } from "@cfpa/contracts/api";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Markdown } from "@/components/Markdown.tsx";
import { cn } from "@/lib/cn.ts";
import { CopyButton } from "@/ui/CopyButton.tsx";
import { cacheRatio, formatDuration, formatTokens, turnElapsed, type Step, type ToolItem, type Turn } from "./turns.ts";
import { toolComposition, ToolBody, toolPreview } from "./ToolViews.tsx";

type AssistantRowItem = NonNullable<Turn["answer"]>;

const TOOL_DOT: Record<ToolCallView["state"], string> = {
  pending: "bg-muted/60",
  running: "animate-pulse bg-warn",
  done: "bg-ok",
  error: "bg-danger",
};

const TOOL_LABEL: Record<ToolCallView["state"], string> = {
  pending: "等待",
  running: "运行中",
  done: "完成",
  error: "失败",
};

function clock(at: string): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const ToolRow = memo(function ToolRow({ item, prNumber }: { item: ToolItem; prNumber?: number }) {
  const { tool, at } = item;
  const preview = tool.progress ?? toolPreview(tool);
  return (
    <details className="agent-fade group border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-elevated/40">
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TOOL_DOT[tool.state])} />
        <span className="sr-only">{TOOL_LABEL[tool.state]}</span>
        <code className="shrink-0 font-mono text-xs font-medium">{tool.name}</code>
        <span className={cn("min-w-0 flex-1 truncate text-xs", tool.state === "error" ? "text-danger" : "text-muted")}>
          {preview !== "" ? preview : TOOL_LABEL[tool.state]}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted">{clock(at)}</span>
      </summary>
      <div className="agent-reveal space-y-2 border-t border-line bg-elevated/30 px-3 py-2">
        <ToolBody tool={tool} prNumber={prNumber} />
      </div>
    </details>
  );
});

function ToolGroup({ items, prNumber }: { items: readonly ToolItem[]; prNumber?: number }) {
  const [open, setOpen] = useState(items.length <= 3);
  const running = items.find((item) => item.tool.state === "running");
  const errors = items.filter((item) => item.tool.state === "error").length;
  const composition = toolComposition(items);

  if (items.length === 1) {
    const only = items[0];
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {only !== undefined && <ToolRow item={only} prNumber={prNumber} />}
      </div>
    );
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group overflow-hidden rounded-lg border border-line bg-surface"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-elevated/40">
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", running !== undefined ? "animate-pulse bg-warn" : errors > 0 ? "bg-danger" : "bg-ok")}
        />
        <span className="shrink-0 text-xs font-medium">工具调用 × {items.length}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs", errors > 0 ? "text-danger" : "text-muted")}>
          {running !== undefined ? `运行中 ${running.tool.name}` : composition !== "" ? composition : "全部完成"}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted">{clock(items.at(-1)?.at ?? "")}</span>
      </summary>
      <div className="border-t border-line">
        {items.map((item) => (
          <ToolRow key={item.id} item={item} prNumber={prNumber} />
        ))}
      </div>
    </details>
  );
}

const UserRow = memo(function UserRow({ text, at }: { text: string; at: string }) {
  return (
    <div className="flex justify-end">
      <div
        title={clock(at)}
        className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm leading-relaxed text-brand-fg"
      >
        {text}
      </div>
    </div>
  );
});

function Typing() {
  return (
    <span className="flex items-center gap-1 py-1.5" aria-label="正在生成">
      <span className="size-1.5 animate-bounce rounded-full bg-accent" />
      <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:120ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:240ms]" />
    </span>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <details className="group/think">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-fg">
        <ChevronRight aria-hidden="true" className="size-3 transition-transform group-open/think:rotate-90" />
        思考过程
      </summary>
      <pre className="scroll-thin mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-elevated/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted">
        {text}
      </pre>
    </details>
  );
}

const AssistantRow = memo(function AssistantRow({ item }: { item: AssistantRowItem }) {
  const thinking = item.thinking?.trim() ?? "";
  const streaming = item.streaming === true;
  const empty = item.text.trim() === "";
  return (
    <div className="flex gap-2.5">
      <div aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line bg-elevated text-muted">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {thinking !== "" && <Thinking text={item.thinking ?? ""} />}
        {empty && streaming ? (
          <Typing />
        ) : (
          <div className="group/msg relative">
            <Markdown>{item.text}</Markdown>
            {streaming && <span aria-hidden="true" className="agent-caret ml-0.5 inline-block h-3.5 w-1.5 rounded-[1px] bg-accent align-text-bottom" />}
            {!empty && !streaming && (
              <CopyButton
                text={item.text}
                label="复制消息"
                className="absolute right-0 top-0 bg-surface/90 opacity-0 shadow-[var(--shadow-panel)] backdrop-blur group-hover/msg:opacity-100 focus-visible:opacity-100"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function StepBlock({ step, live, prNumber }: { step: Step; live: boolean; prNumber?: number }) {
  const thinking = step.thinking?.trim() ?? "";
  const hasText = step.text.trim() !== "";
  return (
    <div className="agent-fade space-y-1.5 px-3 py-2">
      {/* 连续工具调用之间的纯思考块不单独占位，只在有正文或正在生成时露出。 */}
      {thinking !== "" && (hasText || live) && <Thinking text={step.thinking ?? ""} />}
      {hasText && <Markdown className="text-[13px]">{step.text}</Markdown>}
      {step.tools.length > 0 && <ToolGroup items={step.tools} prNumber={prNumber} />}
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function UsageChips({ turn, now }: { turn: Turn; now: number }) {
  const { usage } = turn;
  const elapsed = turnElapsed(turn, now);
  const hasTokens = usage.input + usage.output + usage.cacheRead > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums text-muted">
      {hasTokens && (
        <span title="本回合输入 / 输出 token">
          ↑{formatTokens(usage.input)} ↓{formatTokens(usage.output)}
        </span>
      )}
      {usage.cacheRead > 0 && (
        <span title="缓存命中的 prompt token">
          缓存 {formatTokens(usage.cacheRead)} · {Math.round(cacheRatio(usage) * 100)}%
        </span>
      )}
      {usage.cost > 0 && <span title="服务端报告的成本">${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 3)}</span>}
      <span title="本回合耗时">{elapsed === undefined ? "" : turn.running ? `${formatDuration(elapsed)} · 进行中` : formatDuration(elapsed)}</span>
    </div>
  );
}

const TurnRow = memo(function TurnRow({
  turn,
  position,
  prNumber,
  tail,
  onJump,
}: {
  turn: Turn;
  position: number;
  prNumber?: number;
  tail: boolean;
  onJump: (index: number) => void;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? turn.running;
  const now = useNow(turn.running);
  const elapsed = turnElapsed(turn, now);
  const tools = turn.steps.reduce((total, step) => total + step.tools.length, 0);
  const toggle = useCallback(() => setManual(!open), [open]);

  return (
    <article className={cn("group/turn space-y-2.5", tail && "agent-rise")}>
      {turn.user !== undefined && <UserRow text={turn.user.text} at={turn.user.at} />}

      {turn.steps.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-line bg-surface">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="group/process flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated/40"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")}
            />
            <span className="shrink-0 text-xs font-medium">过程</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">
              {turn.steps.length} 步
              {tools > 0 ? ` · ${tools} 次工具` : ""}
              {turn.running ? " · 运行中" : ""}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">
              {elapsed === undefined ? "" : formatDuration(elapsed)}
            </span>
          </button>
          {open && (
            <div className="agent-fade divide-y divide-line border-t border-line">
              {turn.steps.map((step, position) => (
                <StepBlock
                  key={step.key}
                  step={step}
                  live={turn.running && position === turn.steps.length - 1}
                  prNumber={prNumber}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {turn.answer !== undefined ? (
        <AssistantRow item={turn.answer} />
      ) : (
        turn.running && turn.steps.length === 0 && (
          <div className="flex gap-2.5">
            <div aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line bg-elevated text-muted">
              <Bot className="size-3.5" />
            </div>
            <Typing />
          </div>
        )
      )}

      <div className="flex flex-wrap items-center gap-2 pl-1">
        <UsageChips turn={turn} now={now} />
        <div className="ml-auto flex items-center gap-0.5 opacity-60 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100">
          {turn.answer !== undefined && <CopyButton text={turn.answer.text} label="复制回答" />}
          {turn.steps.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              className="rounded px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              {open ? "收起过程" : "展开过程"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onJump(position)}
            className="rounded px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            回到开头
          </button>
        </div>
      </div>
    </article>
  );
});

const ROW_GAP = 16;

export function ChatStream({
  turns,
  scrollRef,
  prNumber,
  onActiveTurn,
  jumpRef,
}: {
  turns: readonly Turn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  prNumber?: number;
  onActiveTurn: (index: number) => void;
  jumpRef: RefObject<((index: number) => void) | null>;
}) {
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 260,
    overscan: 4,
    getItemKey: (index) => turns[index]?.key ?? index,
  });
  const offset = virtualizer.scrollOffset ?? 0;
  const measurements = virtualizer.measurementsCache;
  let active = 0;
  for (let index = 0; index < measurements.length; index += 1) {
    const measurement = measurements[index];
    if (measurement !== undefined && measurement.start <= offset + 80) active = index;
  }
  const handleJump = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "start" }),
    [virtualizer],
  );
  const reportRef = useRef(onActiveTurn);

  useEffect(() => {
    reportRef.current = onActiveTurn;
  }, [onActiveTurn]);

  useEffect(() => {
    jumpRef.current = handleJump;
    return () => {
      jumpRef.current = null;
    };
  }, [handleJump, jumpRef]);

  useEffect(() => {
    reportRef.current(active);
  }, [active]);

  return (
    <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((entry) => {
        const turn = turns[entry.index];
        if (turn === undefined) return null;
        return (
          <div
            key={turn.key}
            data-index={entry.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${entry.start}px)`, paddingBottom: ROW_GAP }}
          >
            <TurnRow
              turn={turn}
              position={entry.index}
              prNumber={prNumber}
              tail={entry.index === turns.length - 1}
              onJump={handleJump}
            />
          </div>
        );
      })}
    </div>
  );
}

export function TurnRail({
  turns,
  active,
  onJump,
}: {
  turns: readonly Turn[];
  active: number;
  onJump: (index: number) => void;
}) {
  const items = useMemo(
    () =>
      turns.map((turn, index) => ({
        key: turn.key,
        index,
        label: `第 ${turn.index} 回合：${turn.user?.text.split("\n")[0]?.slice(0, 80) ?? "（无输入）"}`,
      })),
    [turns],
  );
  if (items.length < 2) return null;
  return (
    <nav
      aria-label="回合导航"
      className="scroll-thin absolute right-0.5 top-1/2 z-10 flex max-h-[60%] -translate-y-1/2 flex-col gap-1.5 overflow-y-auto py-2 pl-2 pr-1"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          title={item.label}
          aria-label={item.label}
          aria-current={item.index === active ? "true" : undefined}
          onClick={() => onJump(item.index)}
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full border transition",
            item.index === active ? "scale-125 border-accent bg-accent" : "border-line bg-transparent hover:border-accent/70 hover:bg-accent/40",
          )}
        />
      ))}
    </nav>
  );
}
