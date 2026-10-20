import type { ChatItem, ReviewDraft, SessionEvent, SessionStatus } from "@shared/api.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, Bot, Send, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { SessionStatusBadge } from "@/components/StatusBadges.tsx";
import { useSessionEvents } from "@/hooks/useSessionEvents.ts";
import { api, errorMessage } from "@/lib/api.ts";
import { qk, useSession } from "@/lib/queries.ts";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Textarea } from "@/ui/Input.tsx";
import { SkeletonText, Spinner } from "@/ui/Spinner.tsx";
import { ChatItemView } from "@/routes/agent/ChatItems.tsx";
import { DraftPanel } from "@/routes/agent/DraftPanel.tsx";

export function SessionPage({ id }: { id: string }) {
  const detail = useSession(id);
  const client = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<readonly ChatItem[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");

  useEffect(() => {
    const data = detail.data;
    if (!data) return;
    setItems(data.items);
    setStatus(data.status);
    setDraft(data.draft ?? null);
    setDirty(false);
  }, [detail.data]);

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case "snapshot": {
          setItems(event.session.items);
          setStatus(event.session.status);
          setDraft(event.session.draft ?? null);
          setDirty(false);
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
        case "draft": {
          if (!dirty) setDraft(event.draft);
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
    if (node) node.scrollTop = node.scrollHeight;
  }, [items]);

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

  const saveDraft = useMutation({
    mutationFn: (value: ReviewDraft) => api.saveDraft(id, value),
    onSuccess: (saved) => {
      setDraft(saved);
      setDirty(false);
      setDraftError(undefined);
    },
    onError: (error) => setDraftError(errorMessage(error)),
  });

  const publish = useMutation({
    mutationFn: () => api.publish(id),
    onSuccess: () => {
      setDraftError(undefined);
      void client.invalidateQueries({ queryKey: qk.session(id) });
      void client.invalidateQueries({ queryKey: qk.sessions });
    },
    onError: (error) => setDraftError(errorMessage(error)),
  });

  if (detail.error !== null) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (detail.isPending) {
    return (
      <Card>
        <CardBody>
          <SkeletonText lines={8} />
        </CardBody>
      </Card>
    );
  }

  const meta = detail.data;
  const running = status === "running";

  const submit = () => {
    const value = text.trim();
    if (value === "" || running) return;
    setItems((previous) => [...previous, { id: `local-${Date.now()}`, kind: "user", text: value, at: new Date().toISOString() }]);
    setText("");
    send.mutate(value);
  };

  return (
    <>
      <PageHeader
        back={{ to: "/agent", label: "返回会话列表" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{meta?.title || id}</span>
            <SessionStatusBadge status={status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono">{id}</code>
            {meta?.model !== undefined && <span className="font-mono">{meta.model}</span>}
            {meta?.prNumber !== undefined && (
              <Link to="/pr/$n" params={{ n: String(meta.prNumber) }} className="text-accent hover:underline">
                PR #{meta.prNumber}
              </Link>
            )}
          </span>
        }
        actions={
          running ? (
            <Button variant="danger" loading={abort.isPending} icon={<Ban aria-hidden="true" className="size-3.5" />} onClick={() => abort.mutate()}>
              中止
            </Button>
          ) : undefined
        }
      />

      {(connection !== "connected" || lastError !== undefined) && (
        <p className="mb-3 flex flex-wrap items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {connection === "disconnected" ? (
            <WifiOff aria-hidden="true" className="size-3.5" />
          ) : connection === "connecting" ? (
            <Spinner className="text-warn" />
          ) : null}
          {connection === "disconnected" ? "连接中断，正在重连" : connection === "connecting" ? "正在连接事件流…" : ""}
          {lastError !== undefined && <span className="text-danger">· {lastError}</span>}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="flex h-[calc(100vh-13rem)] min-h-96 flex-col">
          <CardHeader title="对话" description={`${items.length} 条消息`} />
          <div ref={listRef} className="scroll-thin flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            {items.length === 0 ? (
              <EmptyState
                icon={<Bot aria-hidden="true" className="size-6" />}
                title="还没有消息"
                description="在下方输入消息开始与 Agent 对话。"
              />
            ) : (
              items.map((item) => <ChatItemView key={item.id} item={item} />)
            )}
          </div>
          <footer className="border-t border-line px-3 py-2">
            <Textarea
              aria-label="消息输入"
              className="min-h-16"
              placeholder={running ? "Agent 正在处理，请稍候…" : "输入消息，Enter 发送，Shift+Enter 换行"}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Enter 发送 · Shift+Enter 换行</span>
              {send.isError && <span className="text-xs text-danger">{errorMessage(send.error)}</span>}
              <Button
                className="ml-auto"
                variant="primary"
                loading={send.isPending}
                disabled={running || text.trim() === ""}
                icon={<Send aria-hidden="true" className="size-3.5" />}
                onClick={submit}
              >
                发送
              </Button>
            </div>
          </footer>
        </Card>

        <DraftPanel
          draft={draft}
          saving={saveDraft.isPending}
          publishing={publish.isPending}
          error={draftError}
          onChange={(next) => {
            setDraft(next);
            setDirty(true);
          }}
          onSave={() => {
            if (draft) saveDraft.mutate(draft);
          }}
          onPublish={() => publish.mutate()}
        />
      </div>
    </>
  );
}
