import type { ChatItem, ToolCallView } from "@shared/api.ts";
import { ChevronRight, Wrench } from "lucide-react";
import { Markdown } from "@/components/Markdown.tsx";
import { cn } from "@/lib/cn.ts";
import { formatJson } from "@/lib/format.ts";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";

const TOOL_STATE: Record<ToolCallView["state"], { label: string; tone: BadgeTone }> = {
  pending: { label: "等待", tone: "neutral" },
  running: { label: "运行中", tone: "warn" },
  done: { label: "完成", tone: "ok" },
  error: { label: "失败", tone: "danger" },
};

function ToolCard({ tool, at }: { tool: ToolCallView; at: string }) {
  const meta = TOOL_STATE[tool.state];
  return (
    <div className="rounded-md border border-line bg-surface">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <ChevronRight aria-hidden="true" className="size-3.5 text-muted transition-transform group-open:rotate-90" />
          <Wrench aria-hidden="true" className="size-3.5 text-muted" />
          <code className="font-mono text-xs font-medium">{tool.name}</code>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {tool.progress !== undefined && tool.state === "running" && <span className="truncate text-xs text-muted">{tool.progress}</span>}
          <span className="ml-auto text-[11px] text-muted">{new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
        </summary>
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">参数</div>
            <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line bg-elevated p-2 font-mono text-[11px]">
              {formatJson(tool.args)}
            </pre>
          </div>
          {tool.result !== undefined && (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">结果</div>
              <pre
                className={cn(
                  "scroll-thin max-h-64 overflow-auto whitespace-pre-wrap rounded border border-line p-2 font-mono text-[11px]",
                  tool.state === "error" ? "bg-danger/10 text-danger" : "bg-elevated",
                )}
              >
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

export function ChatItemView({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px] text-muted">你</span>
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-accent-fg">
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    return <ToolCard tool={item.tool} at={item.at} />;
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">Agent</span>
      {item.thinking !== undefined && item.thinking.trim() !== "" && (
        <details className="rounded-md border border-line bg-elevated/60">
          <summary className="cursor-pointer list-none px-3 py-1.5 text-xs text-muted">思考过程</summary>
          <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11px] text-muted">
            {item.thinking}
          </pre>
        </details>
      )}
      {item.text.trim() === "" && item.streaming === true ? (
        <span className="flex items-center gap-1 px-1 py-1" aria-label="正在生成">
          <span className="size-1.5 animate-bounce rounded-full bg-accent" />
          <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:120ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:240ms]" />
        </span>
      ) : (
        <Markdown>{item.text}</Markdown>
      )}
    </div>
  );
}
