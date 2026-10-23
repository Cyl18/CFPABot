import type { ReviewComment, ReviewEvent, ReviewThread } from "@cfpa/contracts/api";
import { AlertTriangle, CheckCheck, CornerDownRight, Diff, ExternalLink, LoaderCircle, MessageSquare, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown, MarkdownHtml } from "@/components/Markdown.tsx";
import { useReview, useThreadHtml, type OutgoingComment } from "@/hooks/useReview.tsx";
import { errorMessage, loginUrl } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { useStoredFlag } from "@/lib/storedFlag.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button, buttonClass } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { Textarea } from "@/ui/Input.tsx";
import { Popover } from "@/ui/Popover.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const EVENTS: readonly { id: ReviewEvent; label: string; hint: string }[] = [
  { id: "COMMENT", label: "仅评论", hint: "只发出评论，不表态" },
  { id: "APPROVE", label: "批准", hint: "同意合并" },
  { id: "REQUEST_CHANGES", label: "要求修改", hint: "需要改完才能合并" },
];

export const CARDS_KEY = "cfpa-review-cards";

export function CommentsToggle() {
  const [on, setOn] = useStoredFlag(CARDS_KEY);
  return (
    <ToggleChip pressed={on} onClick={() => setOn(!on)} title="显示或隐藏行内的评论卡片；key 旁的气泡不受影响">
      评论卡片
    </ToggleChip>
  );
}

function Avatar({ url }: { url: string }) {
  if (url === "") return <span aria-hidden="true" className="size-5 shrink-0 rounded-full bg-elevated" />;
  return <img src={url} alt="" className="size-5 shrink-0 rounded-full" loading="lazy" />;
}

export function CommentButton({ path, line, label, peek = false }: { path: string; line: number; label?: string; peek?: boolean }) {
  const review = useReview();
  const count = review.threadsAt(path, line).length + review.outgoingAt(path, line).length;
  const open = review.isOpen(path, line);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${label ?? ""}${count > 0 ? `这一行有 ${count} 条评论，点开评论` : "评论这一行"}`}
      title={count > 0 ? `${count} 条评论` : "评论这一行（进入你的待提交审查）"}
      onClick={() => review.setOpen(path, line, !open)}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-xs transition-colors",
        open || count > 0 ? "bg-accent-soft text-accent" : "text-muted hover:bg-elevated hover:text-fg",
        peek && !open && count === 0 && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
      )}
    >
      <MessageSquarePlus aria-hidden="true" className="size-3.5" />
      {count > 0 && <span className="tabular-nums">{count}</span>}
    </button>
  );
}

export function LineComments({ path, line }: { path: string; line: number }) {
  const review = useReview();
  const threads = review.threadsAt(path, line);
  const outgoing = review.outgoingAt(path, line);
  if (threads.length === 0 && outgoing.length === 0) return null;
  const open = threads.filter((thread) => !thread.resolved);
  const done = threads.filter((thread) => thread.resolved);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const count = threads.length + outgoing.length;
  return (
    <Popover
      label={`${name} 第 ${line} 行的评论`}
      panelClassName="max-h-[min(70vh,34rem)] w-96 max-w-[calc(100vw-2rem)]"
      trigger={
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-xs transition-colors",
            open.length > 0 ? "bg-danger/10 text-danger" : "bg-elevated text-muted hover:text-fg",
          )}
        >
          {open.length > 0 ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />
          ) : (
            <CheckCheck aria-hidden="true" className="size-3" />
          )}
          <MessageSquare aria-hidden="true" className="size-3.5" />
          <span className="tabular-nums">{count}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <code className="break-all font-mono">
            {name}:{line}
          </code>
          {open.length > 0 && <span className="text-danger">未解决 {open.length}</span>}
          {done.length > 0 && <span>已解决 {done.length}</span>}
        </p>
        {open.length > 0 && <ThreadGroup title="未解决" tone="danger" threads={open} />}
        {done.length > 0 && <ThreadGroup title="已解决" threads={done} />}
        {outgoing.length > 0 && (
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-muted">还没发出去</h4>
            {outgoing.map((item) => (
              <OutgoingCard key={item.id} item={item} />
            ))}
          </section>
        )}
      </div>
    </Popover>
  );
}

export function CommentAnchor({ path, line, label, active }: { path: string; line: number; label: string; active: boolean }) {
  const review = useReview();
  const threads = review.threadsAt(path, line);
  const open = threads.filter((thread) => !thread.resolved).length;
  const count = open > 0 ? open : threads.length;
  const opened = review.isOpen(path, line);
  const [hover, setHover] = useState(false);
  const [peek, setPeek] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = (el: HTMLElement) => {
    setHover(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const width = 320;
      setPeek({
        left: Math.max(12, Math.min(rect.right + 10, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(rect.top - 4, window.innerHeight - 220)),
      });
    }, 180);
  };
  const hide = () => {
    setHover(false);
    window.clearTimeout(timer.current);
    setPeek(null);
  };
  const title = count === 0 ? `评论${label}这一行` : open > 0 ? `${label}有 ${open} 条未解决对话` : `${label}的对话都已解决`;
  return (
    <>
      <button
        type="button"
        aria-expanded={opened}
        aria-label={title}
        title={title}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={hide}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={hide}
        onClick={() => {
          hide();
          review.setOpen(path, line, !opened);
        }}
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] tabular-nums transition-colors",
          count === 0 && "border-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          count > 0 && open > 0 && "border-danger/40 bg-danger/10 text-danger",
          count > 0 && open === 0 && "border-line bg-elevated text-muted",
          hover && "border-accent/50 bg-accent-soft text-accent opacity-100",
          active && "ring-1 ring-accent/50",
        )}
      >
        {hover ? <MessageSquarePlus aria-hidden="true" className="size-3" /> : <MessageSquare aria-hidden="true" className="size-3" />}
        {count > 0 && <span>{count}</span>}
      </button>
      {peek !== null && createPortal(<ThreadPeek path={path} line={line} left={peek.left} top={peek.top} />, document.body)}
    </>
  );
}

function ThreadPeek({ path, line, left, top }: { path: string; line: number; left: number; top: number }) {
  const review = useReview();
  const threads = review.threadsAt(path, line);
  const open = threads.filter((thread) => !thread.resolved);
  const done = threads.filter((thread) => thread.resolved);
  const first = open[0] ?? done[0];
  if (first === undefined) return null;
  const more: string[] = [];
  if (open.length > 1) more.push(`${open.length - 1} 条未解决`);
  if (done.length > 0) more.push(`${done.length} 条已解决`);
  return (
    <div
      style={{ left, top, width: 320 }}
      className="pointer-events-none fixed z-50 flex flex-col gap-2 rounded-lg border border-line bg-elevated p-3 text-xs shadow-xl"
    >
      <p className={cn("font-medium", open.length > 0 ? "text-danger" : "text-muted")}>
        {open.length > 0 ? "未解决" : "已解决"} · {first.comments[0]?.author ?? "—"}
        {first.comments.length > 1 ? ` · ${first.comments.length} 条` : ""}
      </p>
      {first.comments.slice(0, 2).map((comment) => (
        <div key={comment.id} className="flex flex-col gap-0.5">
          <span className="font-medium text-fg">{comment.author}</span>
          <span className="line-clamp-2 text-fg/90">{comment.body}</span>
        </div>
      ))}
      {more.length > 0 && <p className="text-muted">另有 {more.join("、")}</p>}
      <p className="border-t border-line pt-1.5 text-muted">点击展开 · 回复或新开一条</p>
    </div>
  );
}

function ThreadGroup({ title, tone, threads }: { title: string; tone?: "danger"; threads: readonly ReviewThread[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className={cn("flex items-center gap-1.5 text-xs font-medium", tone === "danger" ? "text-danger" : "text-muted")}>
        {tone === "danger" && <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />}
        {title}
        <span className="tabular-nums">{threads.length}</span>
      </h4>
      {threads.map((thread) => (
        <PeekThread key={thread.id} thread={thread} />
      ))}
    </section>
  );
}

function PeekThread({ thread, raw }: { thread: ReviewThread; raw?: string }) {
  const review = useReview();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const ready = review.access === "ready";
  const html = useThreadHtml(thread.id, thread.comments.map((comment) => comment.id), true);
  const send = () => {
    const body = text.trim();
    if (body === "") return;
    setBusy(true);
    review.replyToThread(thread.id, body).then(
      () => {
        setBusy(false);
        setReplying(false);
        setText("");
      },
      () => setBusy(false),
    );
  };
  return (
    <div className={cn("overflow-hidden rounded-md border", thread.resolved ? "border-line/70 bg-elevated/30" : "border-line bg-surface")}>
      <ul className={cn("flex flex-col divide-y divide-line/60", thread.resolved && "opacity-70")}>
        {thread.comments.map((comment) => (
          <CommentItem key={comment.id} comment={comment} html={html[comment.id]} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line/60 px-2.5 py-1.5 text-xs">
        {thread.outdated && <Badge tone="warn">已过时</Badge>}
        {thread.comments.some((comment) => comment.pending) && <Badge tone="accent">待提交</Badge>}
        <span className="ml-auto flex items-center gap-1">
          {ready && !replying && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              icon={<CornerDownRight aria-hidden="true" className="size-3.5" />}
              onClick={() => setReplying(true)}
            >
              回复
            </Button>
          )}
          <ResolveButton thread={thread} />
        </span>
      </div>
      {ready && replying && (
        <div className="flex flex-col gap-2 border-t border-line/60 p-2">
          <Textarea
            autoGrow
            aria-label="回复这条评论"
            autoFocus
            value={text}
            placeholder="回复会追加到这条对话"
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            {raw !== undefined && (
              <Button
                size="sm"
                variant="primary"
                aria-label="插入修改建议"
                title="插入修改建议"
                icon={<Diff aria-hidden="true" className="size-3.5" />}
                onClick={() => setText((current) => `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}\`\`\`suggestion\n${raw}\n\`\`\`\n`)}
              />
            )}
            <span className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setReplying(false);
                  setText("");
                }}
              >
                取消
              </Button>
              <Button size="sm" variant="primary" loading={busy} disabled={text.trim() === ""} onClick={send}>
                发送
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function ResolveButton({ thread }: { thread: ReviewThread }) {
  const review = useReview();
  const ready = review.access === "ready";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-1.5"
      disabled={!ready}
      title={ready ? undefined : "登录 GitHub 后才能解决评论"}
      icon={
        thread.resolved ? (
          <RotateCcw aria-hidden="true" className="size-3.5" />
        ) : (
          <CheckCheck aria-hidden="true" className="size-3.5" />
        )
      }
      onClick={() => review.resolveThread(thread.id, !thread.resolved)}
    >
      {thread.resolved ? "重新打开" : "解决"}
    </Button>
  );
}

export function LineThreads({ path, line, raw, className }: { path: string; line: number; raw?: string; className?: string }) {
  const review = useReview();
  const threads = review.threadsAt(path, line);
  const outgoing = review.outgoingAt(path, line);
  const open = review.isOpen(path, line);
  const [showDone, setShowDone] = useState(false);
  if (threads.length === 0 && outgoing.length === 0 && !open) return null;
  const pending = threads.filter((thread) => !thread.resolved);
  const done = threads.filter((thread) => thread.resolved);
  return (
    <div className={cn("flex flex-col gap-2 font-sans text-sm", className)}>
      {pending.map((thread) => (
        <ThreadBlock key={thread.id} thread={thread} raw={raw} />
      ))}
      {done.length > 0 &&
        (showDone ? (
          <div className="flex flex-col gap-2">
            {done.map((thread) => (
              <ThreadBlock key={thread.id} thread={thread} raw={raw} />
            ))}
            <button type="button" className="w-fit text-xs text-muted hover:text-fg hover:underline" onClick={() => setShowDone(false)}>
              收起已解决
            </button>
          </div>
        ) : (
          <button type="button" className="w-fit text-xs text-muted hover:text-fg hover:underline" onClick={() => setShowDone(true)}>
            已解决 {done.length} 条 · 展开
          </button>
        ))}
      {outgoing.map((item) => (
        <OutgoingCard key={item.id} item={item} />
      ))}
      {open && <Composer path={path} line={line} raw={raw} divided={pending.length + done.length + outgoing.length > 0} />}
    </div>
  );
}

function ThreadBlock({ thread, raw }: { thread: ReviewThread; raw?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className={cn("text-xs font-medium", thread.resolved ? "text-muted" : "text-danger")}>
        {thread.resolved ? "已解决" : "未解决"} · {thread.comments[0]?.author ?? "—"}
        {thread.comments.length > 1 ? ` · ${thread.comments.length} 条` : ""}
      </p>
      <PeekThread thread={thread} raw={raw} />
    </div>
  );
}

export function ThreadCard({ thread, location }: { thread: ReviewThread; location?: string }) {
  const [open, setOpen] = useState(() => !thread.resolved);
  const html = useThreadHtml(thread.id, thread.comments.map((comment) => comment.id), open);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group rounded-md border border-line bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 border-b border-line/60 px-2.5 py-1.5 text-xs text-muted group-[:not([open])]:border-b-0">
        <span className="font-medium text-fg">{thread.comments[0]?.author ?? "—"}</span>
        <span>{thread.comments.length > 1 ? `等 ${thread.comments.length} 条` : "的评论"}</span>
        {location !== undefined && <code className="break-all font-mono">{location}</code>}
        {thread.resolved && <Badge tone="ok">已解决</Badge>}
        {thread.outdated && <Badge tone="warn" title="评论之后这一行又被改过">已过时</Badge>}
        {thread.comments.some((comment) => comment.pending) && <Badge tone="accent">待提交</Badge>}
      </summary>
      <ul className="flex flex-col divide-y divide-line/60">
        {thread.comments.map((comment) => (
          <CommentItem key={comment.id} comment={comment} html={html[comment.id]} />
        ))}
      </ul>
    </details>
  );
}

function CommentItem({ comment, html }: { comment: ReviewComment; html?: string }) {
  const review = useReview();
  return (
    <li className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Avatar url={comment.avatarUrl} />
        <span className="font-medium text-fg">{comment.author}</span>
        <span title={formatDateTime(comment.createdAt)}>{formatRelative(comment.createdAt)}</span>
        <span className="ml-auto flex items-center gap-1">
          {comment.pending ? (
            comment.mine && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                icon={<Trash2 aria-hidden="true" className="size-3.5" />}
                onClick={() => review.deleteComment(comment.id)}
              >
                删除
              </Button>
            )
          ) : (
            <a href={comment.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-fg" aria-label="在 GitHub 上查看这条评论">
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          )}
        </span>
      </div>
      {html === undefined ? <Markdown>{comment.body}</Markdown> : <MarkdownHtml html={html} />}
    </li>
  );
}

function OutgoingCard({ item }: { item: OutgoingComment }) {
  const review = useReview();
  const failed = item.error !== null;
  return (
    <div className={cn("flex flex-col gap-1 rounded-md border px-2.5 py-2", failed ? "border-danger/40 bg-danger/5" : "border-line bg-surface opacity-80")}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {failed ? (
          <>
            <AlertTriangle aria-hidden="true" className="size-3.5 text-danger" />
            <span className="text-danger">没发出去：{item.error}</span>
            <span className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-1.5" icon={<RotateCcw aria-hidden="true" className="size-3.5" />} onClick={() => review.retryComment(item.id)}>
                重试
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" icon={<X aria-hidden="true" className="size-3.5" />} onClick={() => review.discardComment(item.id)}>
                丢弃
              </Button>
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
            正在存进 GitHub 的待提交审查…
          </span>
        )}
      </div>
      <Markdown>{item.body}</Markdown>
    </div>
  );
}

function Composer({ path, line, raw, divided = false }: { path: string; line: number; raw?: string; divided?: boolean }) {
  const review = useReview();
  const [text, setText] = useState(() => review.draftOf(path, line));
  const update = (next: string) => {
    setText(next);
    review.setDraft(path, line, next);
  };
  const close = () => review.setOpen(path, line, false);
  const commit = () => {
    if (text.trim() === "") return;
    review.addComment(path, line, text);
    update("");
    close();
  };

  if (review.access === "anonymous" || review.access === "reauth") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-muted">
        {review.access === "anonymous" ? "登录 GitHub 后才能评论。" : "需要重新授权，面板才能用你的身份发评论。"}
        <a href={loginUrl()} className={buttonClass("primary", "sm")}>
          {review.access === "anonymous" ? "登录" : "重新登录"}
        </a>
        <Button variant="ghost" size="sm" onClick={close}>
          取消
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", divided && "border-t border-line/60 pt-2")}>
      <div className="flex flex-col gap-2 px-2">
        <Textarea
          autoGrow
          aria-label={`评论 ${path} 第 ${line} 行`}
          autoFocus
          value={text}
          placeholder="写下评论，支持 Markdown"
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            aria-label="插入修改建议"
            title="插入修改建议"
            icon={<Diff aria-hidden="true" className="size-3.5" />}
            onClick={() => update(`${text}${text === "" || text.endsWith("\n") ? "" : "\n"}\`\`\`suggestion\n${raw}\n\`\`\`\n`)}
          />
          <span className="text-xs text-muted">先存进待提交审查，点页面顶部「完成审查」才会公开</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={close}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={text.trim() === ""} onClick={commit} title="Ctrl+Enter">
              加入审查
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function LooseThreads({ title, threads, locate }: { title: string; threads: readonly ReviewThread[]; locate: (thread: ReviewThread) => string }) {
  if (threads.length === 0) return null;
  return (
    <details className="rounded-lg border border-line bg-elevated/40 px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted">
        {title} <span className="tabular-nums text-fg">{threads.length}</span> 条
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-sm">
        {threads.map((thread) => (
          <ThreadCard key={thread.id} thread={thread} location={locate(thread)} />
        ))}
      </div>
    </details>
  );
}

export function ViewedToggle({ path, compact = false }: { path: string; compact?: boolean }) {
  const review = useReview();
  const state = review.viewedOf(path);
  const viewed = state === "VIEWED";
  const ready = review.access === "ready";
  const title = !ready
    ? "登录后可标记已看（同步到 GitHub）"
    : state === "DISMISSED"
      ? "标记过已看，但之后文件又改了"
      : viewed
        ? "已在 GitHub 上标记为已看，点一下取消"
        : "在 GitHub 上标记为已看";
  return (
    <label
      title={title}
      className={cn(
        "inline-flex shrink-0 select-none items-center gap-1.5 whitespace-nowrap text-xs",
        compact ? "" : "h-7 rounded-md border px-2",
        !compact && (viewed ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-elevated text-muted"),
        ready ? "cursor-pointer" : "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="checkbox"
        className="size-3.5 accent-[var(--brand)]"
        checked={viewed}
        disabled={!ready}
        aria-label={compact ? `${path} 已看` : undefined}
        onChange={(event) => review.setViewed(path, event.target.checked)}
      />
      {!compact && (state === "DISMISSED" ? "已看（有新改动）" : "已看")}
    </label>
  );
}

interface PendingItem {
  key: string;
  path: string;
  line: number | null;
  body: string;
  saving: boolean;
}

function PendingList() {
  const review = useReview();
  const items: PendingItem[] = [];
  for (const thread of review.state?.threads ?? []) {
    for (const comment of thread.comments) {
      if (!comment.pending || !comment.mine || review.deleting.has(comment.id)) continue;
      items.push({ key: comment.id, path: thread.path, line: thread.line, body: comment.body, saving: false });
    }
  }
  for (const item of review.outgoing) {
    if (item.error === null) items.push({ key: item.id, path: item.path, line: item.line, body: item.body, saving: true });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line bg-elevated/40 p-2">
      <h3 className="text-xs font-medium text-muted">
        待提交的评论 <span className="tabular-nums text-fg">{items.length}</span>
      </h3>
      <ul className="scroll-thin flex max-h-56 flex-col gap-2 overflow-y-auto">
        {items.map((item) => (
          <li key={item.key} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <code className="break-all font-mono">
                {item.path}
                {item.line !== null && `:${item.line}`}
              </code>
              {item.saving && (
                <span className="ml-auto inline-flex items-center gap-1">
                  <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
                  正在同步
                </span>
              )}
            </div>
            <Markdown>{item.body}</Markdown>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReviewFailure() {
  const review = useReview();
  if (review.failure === null) return null;
  return (
    <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2.5 text-xs text-danger">
      <span className="min-w-0 flex-1">{review.failure}</span>
      {review.access === "reauth" && (
        <a href={loginUrl()} className="underline">
          重新登录
        </a>
      )}
      <button type="button" aria-label="关闭提示" onClick={review.dismissFailure}>
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

export function ReviewSubmit({ author }: { author: string }) {
  const review = useReview();
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (review.access === "anonymous" || review.access === "reauth") {
    return (
      <a href={loginUrl()} className={buttonClass()} title={review.access === "anonymous" ? "登录后可以行内评论、标记已看、提交审查" : "当前登录没有评论权限，需要重新授权"}>
        <MessageSquarePlus aria-hidden="true" className="size-4" />
        {review.access === "anonymous" ? "登录以审查" : "重新授权以审查"}
      </a>
    );
  }

  const own = review.state?.viewer === author;
  const empty = review.pendingCount === 0 && body.trim() === "" && event === "COMMENT";
  const close = () => {
    setOpen(false);
    setError(null);
    if (done !== null) {
      setDone(null);
      setBody("");
      setEvent("COMMENT");
    }
  };
  const submit = () => {
    setBusy(true);
    setError(null);
    review.submit(event, body).then(
      (result) => {
        setBusy(false);
        setDone(result.url);
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorMessage(err));
      },
    );
  };

  return (
    <>
      <Button
        variant={review.pendingCount > 0 ? "primary" : "secondary"}
        icon={review.syncing ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <CheckCheck aria-hidden="true" className="size-4" />}
        title={review.syncing ? "正在和 GitHub 同步" : "提交你在 GitHub 上的待提交审查"}
        onClick={() => setOpen(true)}
      >
        完成审查
        {review.pendingCount > 0 && <span className="rounded-full bg-black/15 px-1.5 text-xs tabular-nums">{review.pendingCount}</span>}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="完成审查"
        description={done === null ? `待提交的行内评论 ${review.pendingCount} 条，会和下面的总结一起发到 GitHub。` : undefined}
        footer={
          done === null ? (
            <>
              <Button variant="ghost" onClick={close}>
                取消
              </Button>
              <Button variant="primary" loading={busy} disabled={empty} onClick={submit} title={empty ? "没有待提交的评论，至少写一句总结" : undefined}>
                提交审查
              </Button>
            </>
          ) : (
            <Button onClick={close}>关闭</Button>
          )
        }
      >
        {done !== null ? (
          <p className="text-sm">
            已提交。
            <a href={done} target="_blank" rel="noreferrer noopener" className="ml-1 text-accent underline">
              在 GitHub 上查看
            </a>
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {review.failedCount > 0 && (
              <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">有 {review.failedCount} 条评论没发出去，不会包含在这次审查里。可以先回到对应行重试。</p>
            )}
            {review.syncing && <p className="text-xs text-muted">还有改动在同步，提交会排在它们后面。</p>}
            <PendingList />
            <Textarea label="总结（可选）" value={body} onChange={(e) => setBody(e.target.value)} placeholder="支持 Markdown" />
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs font-medium text-muted">结论</legend>
              {EVENTS.map((item) => {
                const blocked = own && item.id !== "COMMENT";
                return (
                  <label key={item.id} className={cn("flex items-center gap-2 text-sm", blocked && "opacity-50")} title={blocked ? "GitHub 不允许批准或驳回自己的 PR" : undefined}>
                    <input type="radio" name="review-event" className="accent-[var(--brand)]" checked={event === item.id} disabled={blocked} onChange={() => setEvent(item.id)} />
                    {item.label}
                    <span className="text-xs text-muted">{item.hint}</span>
                  </label>
                );
              })}
            </fieldset>
            {error !== null && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
