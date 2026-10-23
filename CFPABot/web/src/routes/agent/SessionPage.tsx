import type {
  ChatItem,
  EvalScope,
  ReviewDraft,
  SessionEvent,
  SessionStatus,
  SetSessionConfigRequest,
  ThinkingLevel,
  WriteScope,
} from "@shared/api.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Ban, Bot, Brain, Cpu, GitPullRequest, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { SessionStatusBadge } from "@/components/StatusBadges.tsx";
import { useModelsDevIndex } from "@/hooks/useModelsDev.ts";
import { useSessionEvents } from "@/hooks/useSessionEvents.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatRelative } from "@/lib/format.ts";
import { thinkingOptionsFor, withCurrentThinking } from "@/lib/models-dev.ts";
import { qk, useLlmConfig, usePrs, useSession } from "@/lib/queries.ts";
import { ChatStream } from "@/routes/agent/ChatItems.tsx";
import { Composer } from "@/routes/agent/Composer.tsx";
import { DraftPanel } from "@/routes/agent/DraftPanel.tsx";
import { OptionPicker, type PickerOption } from "@/routes/agent/OptionPicker.tsx";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText, Spinner } from "@/ui/Spinner.tsx";
import { Tabs } from "@/ui/Tabs.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const BOTTOM_SLACK = 64;
const CHAT_WIDTH_KEY = "cfpa-agent-chat-width";
const MIN_CHAT_WIDTH = 520;

function initialChatWidth(): number {
  try {
    const stored = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_CHAT_WIDTH ? stored : 1024;
  } catch {
    return 1024;
  }
}

function isReviewDraft(value: unknown): value is ReviewDraft {
  if (typeof value !== "object" || value === null) return false;
  return "verdict" in value && "comments" in value && Array.isArray(value.comments);
}

export function SessionPage({ id }: { id: string }) {
  const detail = useSession(id);
  const client = useQueryClient();
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
  const [pane, setPane] = useState<"chat" | "draft">("chat");
  const [confirmEval, setConfirmEval] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [chatWidth, setChatWidth] = useState(initialChatWidth);
  const sectionRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ center: number; max: number } | null>(null);
  const llm = useLlmConfig(true);
  const modelsDev = useModelsDevIndex();
  const modelsDevIndex = modelsDev.index;
  const prs = usePrs("open");

  useEffect(() => {
    setPane("chat");
    setText("");
  }, [id]);

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
        case "artifact": {
          if (!dirty && isReviewDraft(event.artifact)) setDraft(event.artifact);
          break;
        }
        default:
          break;
      }
    },
    [dirty],
  );

  const connection = useSessionEvents(id, handleEvent);

  useEffect(() => {
    const node = listRef.current;
    if (node && atBottomRef.current) node.scrollTop = node.scrollHeight;
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
  const sessionModelId = meta.model || llm.data?.agent || llm.data?.endpoints[0]?.id || "";
  const sessionEndpoint = llm.data?.endpoints.find((endpoint) => endpoint.id === sessionModelId);
  const thinkingOptions: readonly PickerOption[] = withCurrentThinking(
    thinkingOptionsFor(modelsDevIndex, sessionEndpoint?.model ?? "", sessionEndpoint?.provider),
    meta.thinking,
  );
  const prOptions: PickerOption[] = [
    { value: "", label: "不关联 PR" },
    ...(prs.data ?? []).map((pr) => ({ value: String(pr.number), label: `#${pr.number} ${pr.title}`, hint: pr.author })),
  ];

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = sectionRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { center: rect.left + rect.width / 2, max: Math.max(MIN_CHAT_WIDTH, rect.width - 24) };
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.round(Math.min(Math.max((event.clientX - drag.center) * 2, MIN_CHAT_WIDTH), drag.max));
    setChatWidth(next);
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
    } catch {}
  };

  const submit = () => {
    const value = text.trim();
    if (value === "" || archived) return;
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

  const hint = archived
    ? "会话已归档，不能再发送消息"
    : running
      ? "Agent 运行中，发送会插入当前回合"
      : "Enter 发送 · Shift+Enter 换行";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 px-4 pb-1 pt-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" title={meta.title || id}>
            {meta.title || id}
          </h1>
          <SessionStatusBadge status={status} />
          <div className="ml-auto flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
            {running && (
              <Button variant="danger" size="sm" loading={abort.isPending} icon={<Ban aria-hidden="true" className="size-3.5" />} onClick={() => abort.mutate()}>
                中止
              </Button>
            )}
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
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{meta.createdBy}</span>
          <span title={meta.createdAt}>{formatRelative(meta.createdAt)}</span>
          {archived && <Badge>已归档</Badge>}
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

      {draft !== null && (
        <div className="shrink-0 border-b border-line px-3 py-2 xl:hidden">
          <Tabs
            items={[
              { id: "chat", label: "对话" },
              { id: "draft", label: `草稿（${draft.comments.length}）` },
            ]}
            value={pane}
            onChange={setPane}
            ariaLabel="会话视图"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section
          ref={sectionRef}
          className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", draft !== null && pane === "draft" && "hidden xl:flex")}
        >
          <div className="relative mx-auto flex min-h-0 w-full flex-1 flex-col" style={{ maxWidth: chatWidth }}>
            <div ref={listRef} onScroll={() => {
              const node = listRef.current;
              if (!node) return;
              const near = node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_SLACK;
              atBottomRef.current = near;
              setAtBottom(near);
            }} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
              {items.length === 0 ? (
                <EmptyState
                  icon={<Bot aria-hidden="true" className="size-6" />}
                  title="还没有消息"
                  description="在下面输入消息，开始与 Agent 对话。"
                />
              ) : (
                <ChatStream items={items} />
              )}
            </div>

            <div className="relative shrink-0 px-3 pb-3 pt-2 lg:px-6">
              {!atBottom && items.length > 0 && (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="absolute -top-9 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted shadow-[var(--shadow-panel)] hover:text-fg"
                >
                  ↓ 回到最新
                </button>
              )}
              <Composer
                value={text}
                onChange={setText}
                onSubmit={submit}
                placeholder={archived ? "会话已归档" : running ? "Agent 正在处理，发送会插入当前回合…" : "输入消息…"}
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
                    <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
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

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整对话宽度"
              title="拖动调整宽度"
              onPointerDown={startResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="group absolute inset-y-2 -right-1 hidden w-2 cursor-col-resize touch-none items-center justify-center lg:flex"
            >
              <span aria-hidden="true" className="h-full w-px rounded bg-line/60 transition-colors group-hover:bg-accent/70" />
            </div>
          </div>
        </section>

        {draft !== null && (
          <aside
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-hidden border-line xl:w-[380px] xl:flex-none xl:border-l",
              pane === "chat" && "hidden xl:block",
            )}
          >
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
