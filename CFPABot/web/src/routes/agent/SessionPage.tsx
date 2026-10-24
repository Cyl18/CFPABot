import type {
  ChatItem,
  EvalScope,
  ReviewDraft,
  SessionEvent,
  SessionStatus,
  SetSessionConfigRequest,
  ThinkingLevel,
  WriteScope,
} from "@cfpa/contracts/api";
import { parseModelSelector } from "@cfpa/contracts/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Ban, Bot, Brain, Cpu, CornerDownRight, GitPullRequest, PanelLeft, PanelRight, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionStatusBadge } from "@/components/StatusBadges.tsx";
import { useModelsDevIndex } from "@/hooks/useModelsDev.ts";
import { useSessionEvents } from "@/hooks/useSessionEvents.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatRelative } from "@/lib/format.ts";
import { thinkingOptionsFor, withCurrentThinking } from "@/lib/models-dev.ts";
import { qk, useLlmConfig, usePrs, useSession } from "@/lib/queries.ts";
import { ChatStream, TurnRail } from "@/routes/agent/ChatItems.tsx";
import { buildTurns, formatTokens } from "@/routes/agent/turns.ts";
import { useAgentSidebar } from "@/routes/agent/AgentLayout.tsx";
import { Composer } from "@/routes/agent/Composer.tsx";
import { ArtifactPanel } from "@/routes/agent/ArtifactPanel.tsx";
import { DraftPanel } from "@/routes/agent/DraftPanel.tsx";
import { OptionPicker, type PickerOption } from "@/routes/agent/OptionPicker.tsx";
import { ReviewSidebar } from "@/routes/agent/ReviewSidebar.tsx";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText, Spinner } from "@/ui/Spinner.tsx";
import { Tabs } from "@/ui/Tabs.tsx";
import type { TabItem } from "@/ui/Tabs.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const BOTTOM_SLACK = 64;

type AsideTab = "files" | "status" | "draft";

function isReviewDraft(value: unknown): value is ReviewDraft {
  if (typeof value !== "object" || value === null) return false;
  return "verdict" in value && "comments" in value && Array.isArray(value.comments);
}

interface PendingSteer {
  id: string;
  text: string;
}

const STEER_KEY = "cfpa-agent-steer";

function readPending(id: string): PendingSteer[] {
  try {
    const raw = localStorage.getItem(`${STEER_KEY}:${id}`);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingSteer =>
        typeof item === "object" && item !== null && typeof (item as PendingSteer).id === "string" && typeof (item as PendingSteer).text === "string",
    );
  } catch {
    return [];
  }
}

function writePending(id: string, items: readonly PendingSteer[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(`${STEER_KEY}:${id}`);
    else localStorage.setItem(`${STEER_KEY}:${id}`, JSON.stringify(items));
  } catch {}
}

function PendingSteers({
  items,
  onChange,
  onRemove,
}: {
  items: readonly PendingSteer[];
  onChange: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-warn/40 bg-warn/5">
      <div className="flex items-center gap-1.5 border-b border-warn/30 px-2.5 py-1 text-[11px] text-warn">
        <CornerDownRight aria-hidden="true" className="size-3" />
        待插话 · {items.length} · 每步结束后注入一条
      </div>
      {items.map((item) => (
        <div key={item.id} className="flex items-start gap-1 border-t border-warn/15 px-1.5 py-1 first:border-t-0">
          <textarea
            value={item.text}
            rows={2}
            aria-label="待插话内容"
            onChange={(event) => onChange(item.id, event.target.value)}
            className="scroll-thin min-h-10 flex-1 resize-none rounded bg-transparent px-1 py-0.5 text-xs leading-relaxed text-fg focus:outline-none"
          />
          <button
            type="button"
            aria-label="删除这条插话"
            title="删除"
            onClick={() => onRemove(item.id)}
            className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-elevated hover:text-danger"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function latestContextTokens(items: readonly ChatItem[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "assistant" && item.usage !== undefined) return item.usage.contextTokens;
  }
  return undefined;
}

export function SessionPage({ id }: { id: string }) {
  const detail = useSession(id);
  const client = useQueryClient();
  const agentSidebar = useAgentSidebar();
  const listRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [items, setItems] = useState<readonly ChatItem[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [pane, setPane] = useState<"chat" | "aside">("chat");
  const [asideTab, setAsideTab] = useState<AsideTab>("files");
  const [asideOpen, setAsideOpen] = useState(true);
  const draftSeen = useRef(false);
  const [confirmEval, setConfirmEval] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [pending, setPending] = useState<readonly PendingSteer[]>(() => readPending(id));
  const [activeTurn, setActiveTurn] = useState(0);
  const jumpRef = useRef<((index: number) => void) | null>(null);
  const sawRunning = useRef(false);
  const llm = useLlmConfig(true);
  const modelsDev = useModelsDevIndex();
  const modelsDevIndex = modelsDev.index;
  const prs = usePrs("open");

  useEffect(() => {
    setPane("chat");
    setAsideTab("files");
    draftSeen.current = false;
    setText("");
    setPending(readPending(id));
    sawRunning.current = false;
  }, [id]);

  useEffect(() => {
    if (draft === null || draftSeen.current) return;
    draftSeen.current = true;
    setAsideTab("draft");
  }, [draft]);

  useEffect(() => {
    const data = detail.data;
    if (!data) return;
    setItems(data.items);
    setStatus(data.status);
    setDraft(isReviewDraft(data.artifact) ? data.artifact : null);
    setDirty(false);
    setLastError(data.lastError);
    atBottomRef.current = true;
    setAtBottom(true);
  }, [detail.data]);

  const pendingRef = useRef<readonly PendingSteer[]>(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const applyPending = useCallback(
    (next: PendingSteer[]) => {
      setPending(next);
      writePending(id, next);
    },
    [id],
  );

  const releasing = useRef(false);

  /** 步边界放行一条待插话：服务端会把它 steer 到下一次模型调用之前。 */
  const releasePending = useCallback(() => {
    const next = pendingRef.current[0];
    if (next === undefined || releasing.current) return;
    releasing.current = true;
    api
      .sendMessage(id, next.text)
      .then(() => applyPending(pendingRef.current.filter((item) => item.id !== next.id)))
      .catch((error: unknown) => setActionError(errorMessage(error)))
      .finally(() => {
        releasing.current = false;
      });
  }, [applyPending, id]);

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case "snapshot": {
          setItems(event.session.items);
          setStatus(event.session.status);
          if (!dirty) setDraft(isReviewDraft(event.session.artifact) ? event.session.artifact : null);
          setLastError(event.session.lastError);
          break;
        }
        case "item": {
          const incoming = event.item;
          setItems((previous) => {
            const kept =
              incoming.kind === "user"
                ? previous.filter((item) => !(item.id.startsWith("local-") && item.kind === "user" && item.text === incoming.text))
                : previous;
            const index = kept.findIndex((item) => item.id === incoming.id);
            if (index < 0) return [...kept, incoming];
            const next = [...kept];
            next[index] = incoming;
            return next;
          });
          break;
        }
        case "status": {
          setStatus(event.status);
          setLastError(event.lastError);
          break;
        }
        case "step": {
          releasePending();
          break;
        }
        case "artifact": {
          if (!dirty && isReviewDraft(event.artifact)) setDraft(event.artifact);
          break;
        }
        default:
          break;
      }
    },
    [dirty, releasePending],
  );

  const connection = useSessionEvents(id, handleEvent);
  const turns = useMemo(() => buildTurns(items, status === "running"), [items, status]);
  const asideTabs: readonly TabItem<AsideTab>[] =
    draft === null
      ? [
          { id: "files", label: "产物" },
          { id: "status", label: "状态" },
        ]
      : [
          { id: "files", label: "产物" },
          { id: "status", label: "状态" },
          { id: "draft", label: `草稿（${draft.comments.length}）` },
        ];

  // 只在本页确实见过运行后，回合结束才补发漏掉的待插话；避免刷新后直接把旧残留发给模型。
  useEffect(() => {
    if (status === "running") sawRunning.current = true;
    if (status !== "idle" || !sawRunning.current || detail.data === undefined || detail.data.archived) return;
    releasePending();
  }, [status, detail.data, releasePending]);

  useEffect(() => {
    const node = listRef.current;
    if (!node || !atBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);

  const scrollToBottom = () => {
    const node = listRef.current;
    if (!node) return;
    atBottomRef.current = true;
    setAtBottom(true);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  const send = useMutation({
    mutationFn: (value: string) => api.sendMessage(id, value),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.sessions });
    },
  });

  const abort = useMutation({
    mutationFn: () => api.abortSession(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.sessions });
    },
  });

  useEffect(() => {
    if (status !== "running" || confirmEval) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      abort.mutate();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [abort, confirmEval, status]);

  const archive = useMutation({
    mutationFn: () => api.archiveSession(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.sessions });
      void client.invalidateQueries({ queryKey: qk.session(id) });
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const saveDraft = useMutation({
    mutationFn: (value: ReviewDraft) => api.saveArtifact(id, value),
    onSuccess: (saved) => {
      setDraft(isReviewDraft(saved) ? saved : null);
      setDirty(false);
      setDraftError(undefined);
    },
    onError: (error) => setDraftError(errorMessage(error)),
  });

  const publish = useMutation({
    mutationFn: () => api.publishArtifact(id),
    onSuccess: () => {
      setDraftError(undefined);
      void client.invalidateQueries({ queryKey: qk.session(id) });
      void client.invalidateQueries({ queryKey: qk.sessions });
    },
    onError: (error) => setDraftError(errorMessage(error)),
  });

  const refreshSession = () => {
    void client.invalidateQueries({ queryKey: qk.session(id) });
    void client.invalidateQueries({ queryKey: qk.sessions });
  };

  const setEval = useMutation({
    mutationFn: (evalScope: EvalScope) => api.setSessionEvalScope(id, { evalScope }),
    onSuccess: () => {
      setActionError(undefined);
      refreshSession();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const setWrite = useMutation({
    mutationFn: (writeScope: WriteScope) => api.setSessionWriteScope(id, { writeScope }),
    onSuccess: () => {
      setActionError(undefined);
      refreshSession();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const config = useMutation({
    mutationFn: (patch: SetSessionConfigRequest) => api.setSessionConfig(id, patch),
    onSuccess: () => {
      setActionError(undefined);
      refreshSession();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  if (detail.error !== null) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (detail.isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="px-4 py-3">
          <SkeletonText lines={1} />
        </div>
        <div className="p-4">
          <SkeletonText lines={6} />
        </div>
      </div>
    );
  }

  const meta = detail.data;
  const running = status === "running";
  const archived = meta.archived;
  const evalOn = meta.evalScope === "run";
  const writeOn = meta.writeScope === "on";

  const modelOptions: PickerOption[] = [
    { value: "", label: "默认模型" },
    ...(llm.data?.endpoints ?? []).map((endpoint) => ({ value: endpoint.id, label: endpoint.id })),
  ];
  const sessionModelId =
    meta.model || parseModelSelector(llm.data?.roles.default ?? "").endpoint || llm.data?.endpoints[0]?.id || "";
  const sessionEndpoint = llm.data?.endpoints.find((endpoint) => endpoint.id === sessionModelId);
  const contextTokens = latestContextTokens(items);
  const contextWindow = sessionEndpoint?.contextWindow ?? 128_000;
  const contextRatio = contextTokens === undefined ? 0 : contextTokens / contextWindow;
  const thinkingOptions: readonly PickerOption[] = withCurrentThinking(
    thinkingOptionsFor(modelsDevIndex, sessionEndpoint?.model ?? "", sessionEndpoint?.provider),
    meta.thinking,
  );
  const prOptions: PickerOption[] = [
    { value: "", label: "不关联 PR" },
    ...(prs.data ?? []).map((pr) => ({ value: String(pr.number), label: `#${pr.number} ${pr.title}`, hint: pr.author })),
  ];

  const submit = () => {
    const value = text.trim();
    if (value === "" || archived) return;
    if (running) {
      applyPending([...pendingRef.current, { id: `steer-${Date.now()}`, text: value }]);
      setText("");
      return;
    }
    const localId = `local-${Date.now()}`;
    setItems((previous) => [...previous, { id: localId, kind: "user", text: value, at: new Date().toISOString() }]);
    setText("");
    scrollToBottom();
    send.mutate(value, {
      onError: () => {
        setItems((previous) => previous.filter((item) => item.id !== localId));
        setText(value);
      },
    });
  };

  const editPending = (key: string, value: string) => {
    applyPending(pendingRef.current.map((item) => (item.id === key ? { ...item, text: value } : item)));
  };

  const removePending = (key: string) => {
    applyPending(pendingRef.current.filter((item) => item.id !== key));
  };

  const hint = archived
    ? "会话已归档，不能再发送消息"
    : running
      ? `运行中 · 待插话 ${pending.length} 条 · 每步结束后注入 · Esc 中止`
      : "Enter 发送 · Shift+Enter 换行";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <header className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            title={agentSidebar.open ? "隐藏会话列表" : "显示会话列表"}
            aria-label={agentSidebar.open ? "隐藏会话列表" : "显示会话列表"}
            aria-pressed={agentSidebar.open}
            onClick={agentSidebar.toggle}
          >
            <PanelLeft aria-hidden="true" className="size-4" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" title={meta.title || id}>
            {meta.title || id}
          </h1>
          <SessionStatusBadge status={status} />
          <div className="flex shrink-0 items-center gap-1.5">
            {running && (
              <Button variant="danger" size="sm" loading={abort.isPending} icon={<Ban aria-hidden="true" className="size-3.5" />} onClick={() => abort.mutate()}>
                中止
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              title={asideOpen ? "隐藏审查状态" : "显示审查状态"}
              aria-label={asideOpen ? "隐藏审查状态" : "显示审查状态"}
              aria-pressed={asideOpen}
              onClick={() => {
                const next = !asideOpen;
                setAsideOpen(next);
                setPane(next ? "aside" : "chat");
              }}
            >
              <PanelRight aria-hidden="true" className="size-4" />
            </Button>
            {!archived && (
              <Button
                variant="ghost"
                size="icon"
                title="归档会话"
                aria-label="归档会话"
                loading={archive.isPending}
                onClick={() => archive.mutate()}
              >
                <Archive aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <span>{meta.createdBy}</span>
          <span title={meta.createdAt}>{formatRelative(meta.createdAt)}</span>
          {archived && <Badge>已归档</Badge>}
          {contextTokens !== undefined && (
            <span
              title={`上下文占用 ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}
              className={cn(
                "inline-flex items-center gap-1 tabular-nums",
                contextRatio >= 0.9 ? "text-danger" : contextRatio >= 0.7 ? "text-warn" : "text-muted",
              )}
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              上下文 {formatTokens(contextTokens)} / {formatTokens(contextWindow)}（{Math.round(contextRatio * 100)}%）
            </span>
          )}
        </div>
      </header>

      {connection !== "connected" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn">
          {connection === "disconnected" ? <WifiOff aria-hidden="true" className="size-3.5" /> : <Spinner className="text-warn" />}
          {connection === "disconnected" ? "事件流已断开，正在重连" : "正在连接事件流…"}
        </div>
      )}

      {(lastError !== undefined || actionError !== undefined) && (
        <div className="shrink-0 border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-xs text-danger">
          {lastError !== undefined && <p>{lastError}</p>}
          {actionError !== undefined && <p>{actionError}</p>}
        </div>
      )}

      {asideOpen && (
        <div className="shrink-0 border-b border-line px-3 py-2 xl:hidden">
          <Tabs
            items={[{ id: "chat", label: "对话" } as const, ...asideTabs]}
            value={pane === "chat" ? "chat" : asideTab}
            onChange={(next) => {
              if (next === "chat") {
                setPane("chat");
                return;
              }
              setAsideTab(next);
              setPane("aside");
            }}
            ariaLabel="会话视图"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", asideOpen && pane === "aside" && "hidden xl:flex")}>
          <div ref={listRef} onScroll={() => {
            const node = listRef.current;
            if (!node) return;
            const near = node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK;
            atBottomRef.current = near;
            setAtBottom(near);
          }} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6">
            <div className="mx-auto w-full max-w-4xl">
              {turns.length === 0 ? (
                <EmptyState
                  icon={<Bot aria-hidden="true" className="size-6" />}
                  title="还没有消息"
                  description="在下面输入消息，开始与 Agent 对话。"
                />
              ) : (
                <ChatStream
                  turns={turns}
                  scrollRef={listRef}
                  prNumber={meta.prNumber}
                  onActiveTurn={setActiveTurn}
                  jumpRef={jumpRef}
                />
              )}
            </div>
          </div>

          <TurnRail turns={turns} active={activeTurn} onJump={(index) => jumpRef.current?.(index)} />

          <div className="shrink-0 px-3 pb-3 pt-2 lg:px-6">
            <div className="relative mx-auto w-full max-w-4xl">
              {!atBottom && items.length > 0 && (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="absolute -top-9 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted shadow-[var(--shadow-panel)] hover:text-fg"
                >
                  ↓ 回到最新
                </button>
              )}
              <PendingSteers items={pending} onChange={editPending} onRemove={removePending} />
              <Composer
                value={text}
                onChange={setText}
                onSubmit={submit}
                placeholder={archived ? "会话已归档" : running ? "运行中：消息会暂存为待插话，本步结束后注入…" : "输入消息…"}
                submitLabel={running ? "插话" : "发送"}
                disabled={archived}
                hint={hint}
                error={send.isError ? errorMessage(send.error) : undefined}
                top={
                  <>
                    <OptionPicker
                      label="模型"
                      value={meta.model}
                      options={modelOptions}
                      onChange={(value) => config.mutate({ model: value })}
                      icon={<Cpu aria-hidden="true" className="size-3 text-muted" />}
                      disabled={config.isPending}
                    />
                    <OptionPicker
                      label="思考"
                      value={meta.thinking ?? ""}
                      options={thinkingOptions}
                      onChange={(value) => config.mutate({ thinking: value === "" ? null : (value as ThinkingLevel) })}
                      icon={<Brain aria-hidden="true" className="size-3 text-muted" />}
                      disabled={config.isPending || modelsDev.status === "loading"}
                    />
                    <OptionPicker
                      label="关联 PR"
                      value={meta.prNumber === undefined ? "" : String(meta.prNumber)}
                      options={prOptions}
                      onChange={(value) => config.mutate({ prNumber: value === "" ? null : Number(value) })}
                      icon={<GitPullRequest aria-hidden="true" className="size-3 text-muted" />}
                      searchable
                      disabled={config.isPending}
                    />
                  </>
                }
                leading={
                  <>
                    <ToggleChip pressed={evalOn} onClick={() => (evalOn ? setEval.mutate("off") : setConfirmEval(true))} title="允许 Agent 执行 bash 与 eval">
                      执行 {evalOn ? "开" : "关"}
                    </ToggleChip>
                    <ToggleChip pressed={writeOn} onClick={() => setWrite.mutate(writeOn ? "off" : "on")} title="允许 Agent 向 GitHub 写入">
                      GitHub 写 {writeOn ? "开" : "关"}
                    </ToggleChip>
                  </>
                }
              />
            </div>
          </div>
        </section>

        {asideOpen && (
          <aside
            className={cn(
              "agent-slide-in flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden xl:w-[380px] xl:flex-none xl:border-l xl:border-line",
              pane === "chat" && "hidden xl:flex",
            )}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
              <Tabs items={asideTabs} value={asideTab} onChange={setAsideTab} ariaLabel="右栏视图" className="min-w-0" />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {asideTab === "draft" && draft !== null ? (
                <DraftPanel
                  draft={draft}
                  dirty={dirty}
                  saving={saveDraft.isPending}
                  publishing={publish.isPending}
                  error={draftError}
                  onChange={(next) => {
                    setDraft(next);
                    setDirty(true);
                  }}
                  onSave={() => saveDraft.mutate(draft)}
                  onPublish={() => publish.mutate()}
                />
              ) : asideTab === "files" ? (
                <ArtifactPanel id={id} />
              ) : (
                <ReviewSidebar items={items} prNumber={meta.prNumber} />
              )}
            </div>
          </aside>
        )}
      </div>

      <Dialog
        open={confirmEval}
        onClose={() => setConfirmEval(false)}
        title="开启执行权限"
        description="开启后 Agent 可以在这台服务器上执行任意 shell 命令和脚本。"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmEval(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmEval(false);
                setEval.mutate("run");
              }}
            >
              确认开启
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">只在明确需要跑命令或脚本时开启；关闭后新的 bash / eval 调用会被拒绝。</p>
      </Dialog>
    </div>
  );
}
