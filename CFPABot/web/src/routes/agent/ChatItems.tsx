import type { ChatItem, ToolCallView } from "@cfpa/contracts/api";
import { Bot, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/Markdown.tsx";
import { cn } from "@/lib/cn.ts";
import { formatJson } from "@/lib/format.ts";

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

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      {children}
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const { tool, at } = item;
  return (
    <details className="group border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-elevated/40">
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TOOL_DOT[tool.state])} />
        <span className="sr-only">{TOOL_LABEL[tool.state]}</span>
        <code className="shrink-0 font-mono text-xs font-medium">{tool.name}</code>
        <span className={cn("min-w-0 flex-1 truncate text-xs", tool.state === "error" ? "text-danger" : "text-muted")}>
          {tool.progress ?? TOOL_LABEL[tool.state]}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted">{clock(at)}</span>
      </summary>
      <div className="space-y-2 border-t border-line bg-elevated/30 px-3 py-2">
        <Section label="参数">
          <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed">
            {formatJson(tool.args)}
          </pre>
        </Section>
        {tool.result !== undefined && (
          <Section label="结果">
            <pre
              className={cn(
                "scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed",
                tool.state === "error" && "border-danger/40 bg-danger/5 text-danger",
              )}
            >
              {tool.result}
            </pre>
          </Section>
        )}
      </div>
    </details>
  );
}

function ToolGroup({ items }: { items: readonly ToolItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {items.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function UserRow({ item }: { item: UserItem }) {
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
}

function Typing() {
  return (
    <span className="flex items-center gap-1 py-1.5" aria-label="正在生成">
      <span className="size-1.5 animate-bounce rounded-full bg-accent" />
      <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:120ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:240ms]" />
    </span>
  );
}

function AssistantRow({ item }: { item: AssistantItem }) {
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
          <div>
            <Markdown>{item.text}</Markdown>
            {streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[1px] bg-accent align-text-bottom" />}
          </div>
        )}
      </div>
    </div>
  );
}

type Row = { key: string; kind: "item"; item: UserItem | AssistantItem } | { key: string; kind: "tools"; items: ToolItem[] };

/** 连续的工具调用合成一组，避免一次审查刷出几十个卡片。 */
export function ChatStream({ items }: { items: readonly ChatItem[] }) {
  const rows: Row[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (item.kind === "tool") {
      if (last?.kind === "tools") last.items.push(item);
      else rows.push({ key: item.id, kind: "tools", items: [item] });
    } else {
      rows.push({ key: item.id, kind: "item", item });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) =>
        row.kind === "tools" ? (
          <ToolGroup key={row.key} items={row.items} />
        ) : row.item.kind === "user" ? (
          <UserRow key={row.key} item={row.item} />
        ) : (
          <AssistantRow key={row.key} item={row.item} />
        ),
      )}
    </div>
  );
}
