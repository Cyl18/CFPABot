import type { ChatItem, ToolCallView } from "@cfpa/contracts/api";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, ChevronRight } from "lucide-react";
import { memo, useMemo, useState, type RefObject } from "react";
import { Markdown } from "@/components/Markdown.tsx";
import { cn } from "@/lib/cn.ts";
import { CopyButton } from "@/ui/CopyButton.tsx";
import { toolComposition, ToolBody, toolPreview } from "./ToolViews.tsx";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
type UserItem = Extract<ChatItem, { kind: "user" }>;

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
    <details className="group border-t border-line first:border-t-0">
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
      <div className="space-y-2 border-t border-line bg-elevated/30 px-3 py-2">
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

const UserRow = memo(function UserRow({ item }: { item: UserItem }) {
  return (
    <div className="flex justify-end">
      <div
        title={clock(item.at)}
        className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm leading-relaxed text-brand-fg"
      >
        {item.text}
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

const AssistantRow = memo(function AssistantRow({ item }: { item: AssistantItem }) {
  const thinking = item.thinking?.trim() ?? "";
  const streaming = item.streaming === true;
  const empty = item.text.trim() === "";
  return (
    <div className="flex gap-2.5">
      <div aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line bg-elevated text-muted">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {thinking !== "" && (
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-fg">
              <ChevronRight aria-hidden="true" className="size-3 transition-transform group-open:rotate-90" />
              思考过程
            </summary>
            <pre className="scroll-thin mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-elevated/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted">
              {item.thinking}
            </pre>
          </details>
        )}
        {empty && streaming ? (
          <Typing />
        ) : (
          <div className="group/msg relative">
            <Markdown>{item.text}</Markdown>
            {streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[1px] bg-accent align-text-bottom" />}
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

type Row = { key: string; kind: "item"; item: UserItem | AssistantItem } | { key: string; kind: "tools"; items: ToolItem[] };

/** 连续的工具调用合成一组，避免一次审查刷出几十个卡片。 */
function rowsOf(items: readonly ChatItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.kind === "assistant" && item.streaming !== true && item.text.trim() === "" && !item.thinking) continue;
    const last = rows.at(-1);
    if (item.kind === "tool") {
      if (last?.kind === "tools") last.items.push(item);
      else rows.push({ key: item.id, kind: "tools", items: [item] });
    } else {
      rows.push({ key: item.id, kind: "item", item });
    }
  }
  return rows;
}

export function ChatStream({ items, scrollRef, prNumber }: { items: readonly ChatItem[]; scrollRef: RefObject<HTMLDivElement | null>; prNumber?: number }) {
  const rows = useMemo(() => rowsOf(items), [items]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  return (
    <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((entry) => {
        const row = rows[entry.index];
        if (row === undefined) return null;
        return (
          <div
            key={row.key}
            data-index={entry.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full pb-4"
            style={{ transform: `translateY(${entry.start}px)` }}
          >
            {row.kind === "tools" ? (
              <ToolGroup items={row.items} prNumber={prNumber} />
            ) : row.item.kind === "user" ? (
              <UserRow item={row.item} />
            ) : (
              <AssistantRow item={row.item} />
            )}
          </div>
        );
      })}
    </div>
  );
}
