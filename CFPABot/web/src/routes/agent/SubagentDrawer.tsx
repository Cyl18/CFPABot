import type { ChatItem, SubagentInfo, SubagentTranscript } from "@cfpa/contracts/api";
import { useMutation } from "@tanstack/react-query";
import { Ban, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { Button } from "@/ui/Button.tsx";
import { ChatStream } from "./ChatItems.tsx";
import { buildTurns, formatDuration, formatTokens } from "./turns.ts";

const POLL_MS = 1_200;

const FLOW_QUIET_MS = 4_000;

const IDLE_POLLS_BEFORE_STOP = 4;

const STATUS_TEXT: Record<SubagentInfo["status"], string> = {
  queued: "等待",
  running: "运行中",
  done: "完成",
  error: "失败",
};

const STATUS_TONE: Record<SubagentInfo["status"], string> = {
  queued: "text-muted",
  running: "text-accent",
  done: "text-ok",
  error: "text-danger",
};

export function SubagentDrawer({
  sessionId,
  info,
  live,
  prNumber,
  onClose,
}: {
  sessionId: string;
  info: SubagentInfo;
  live: boolean;
  prNumber?: number;
  onClose(): void;
}) {
  const [items, setItems] = useState<readonly ChatItem[]>([]);
  const [status, setStatus] = useState<SubagentInfo["status"] | undefined>();
  const [activity, setActivity] = useState<string | undefined>();
  const [estimate, setEstimate] = useState<{ percent?: number; stage?: string; watch?: string }>({});
  const [counters, setCounters] = useState<{ tokens?: number; toolCount?: number; durationMs?: number; startedAt?: number }>({});
  const [flow, setFlow] = useState<{ chars: number; since: number } | undefined>();
  const flowRef = useRef<{ chars: number; since: number } | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const offset = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const jumpRef = useRef<((index: number) => void) | null>(null);
  const stop = useMutation({ mutationFn: () => api.abortSubagent(sessionId, info.agentId) });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    flowRef.current = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let quiet = 0;
    const tick = async () => {
      try {
        const page: SubagentTranscript = await api.subagent(sessionId, info.agentId, offset.current);
        if (!alive) return;
        if (page.total < offset.current) {
          offset.current = page.total;
          setItems(page.items);
        } else if (page.items.length > 0) {
          quiet = 0;
          offset.current = page.total;
          setItems((previous) => [...previous, ...page.items]);
        } else {
          quiet += 1;
        }
        setStatus(page.status);
        setActivity(page.activity);
        setEstimate({ percent: page.percent, stage: page.stage, watch: page.watch });
        setCounters({
          tokens: page.tokens,
          toolCount: page.toolCount,
          durationMs: page.durationMs,
          startedAt: page.startedAt,
        });
        // 字符增长才算有流；收尾归零、换下一条时不刷新 since。
        const chars = page.streamChars ?? 0;
        const previous = flowRef.current;
        const since = previous !== undefined && chars > previous.chars ? Date.now() : (previous?.since ?? Date.now());
        flowRef.current = { chars, since };
        setFlow(flowRef.current);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      if (!alive) return;
      if (!live && quiet >= IDLE_POLLS_BEFORE_STOP) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sessionId, info.agentId, live]);

  const jump = useCallback(() => undefined, []);
  const shown = status ?? info.status;
  const shownActivity = activity ?? info.activity;
  const turns = buildTurns(items, live);
  const percent = estimate.percent ?? info.percent;
  const stage = estimate.stage ?? info.stage;
  const watch = estimate.watch ?? info.watch;
  const tokens = counters.tokens ?? info.tokens;
  const toolCount = counters.toolCount ?? info.toolCount;
  const durationMs =
    shown === "running" && counters.startedAt !== undefined
      ? Math.max(counters.durationMs ?? 0, Date.now() - counters.startedAt)
      : (counters.durationMs ?? info.durationMs);
  const stalledMs = flow === undefined ? 0 : Date.now() - flow.since;
  const flowing = stalledMs < FLOW_QUIET_MS && (flow?.chars ?? 0) > 0;

  return createPortal(
    <>
      <div className="agent-fade fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label={`子代理 ${info.agent}`}
        className="agent-drawer-in fixed inset-y-0 right-0 z-40 flex w-[min(560px,100vw)] flex-col border-l border-line bg-surface shadow-[var(--shadow-panel)]"
      >
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className={cn("size-1.5 shrink-0 rounded-full", live ? "animate-pulse bg-warn" : "bg-muted")} />
          <code className="shrink-0 font-mono text-xs">{info.model !== undefined ? `@${info.model}` : info.agent}</code>
          <span className={cn("shrink-0 text-[11px]", STATUS_TONE[shown])}>{STATUS_TEXT[shown]}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {live && (
              <Button
                variant="danger"
                size="sm"
                loading={stop.isPending}
                icon={<Ban aria-hidden="true" className="size-3.5" />}
                onClick={() => stop.mutate()}
              >
                停止
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-[11px] tabular-nums text-muted">
          <span>{formatTokens(tokens)} tok</span>
          <span>{toolCount} 次工具</span>
          <span>{formatDuration(durationMs)}</span>
          {info.cost > 0 && <span>${info.cost.toFixed(4)}</span>}
          {shown === "running" && flow !== undefined && (
            <span
              className={flowing ? "text-ok" : "text-warn"}
              title={flowing ? "正在接收上游输出" : "这段时间没有收到新的输出字符"}
            >
              {flowing ? "有流" : stalledMs === 0 ? "等上游" : `无新输出 ${formatDuration(stalledMs)}`}
            </span>
          )}
          {percent !== undefined && (
            <span className="flex items-center gap-1">
              <span className="h-1 w-12 overflow-hidden rounded-full bg-elevated">
                <span
                  className={cn("block h-full", percent >= 100 ? "bg-ok" : "bg-accent")}
                  style={{ width: `${percent}%` }}
                />
              </span>
              完成 {percent}%
            </span>
          )}
        </div>
        {stage !== undefined && (
          <p className="line-clamp-1 break-words border-b border-line px-3 py-1 text-[11px] text-muted">
            阶段 {stage}
          </p>
        )}
        {watch !== undefined && (
          <p className="line-clamp-2 break-words border-b border-line px-3 py-1 text-[11px] text-muted">
            观察 {watch}
          </p>
        )}
        {shownActivity !== undefined && (
          <p className="line-clamp-2 break-words border-b border-line px-3 py-1.5 text-[11px] text-accent">
            {shownActivity}
          </p>
        )}
        <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {items.length === 0 ? (
            <p className={cn("px-1 py-2 text-[11px]", error === null ? "text-muted" : "text-danger")}>
              {error ?? (live ? "等待子代理输出…" : "没有留下可显示的记录。")}
            </p>
          ) : (
            <ChatStream
              turns={turns}
              scrollRef={scrollRef}
              prNumber={prNumber}
              onActiveTurn={jump}
              jumpRef={jumpRef}
            />
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
