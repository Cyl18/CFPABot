import type { ChatItem } from "@cfpa/contracts/api";
import { Bot, CheckCircle2, ChevronRight, Circle, CircleAlert, CircleMinus, Files, ListTodo, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { usePr } from "@/lib/queries.ts";
import { CopyButton } from "@/ui/CopyButton.tsx";
import {
  delegateItems,
  fileProgress,
  parsePlan,
  planStats,
  stringArg,
  subagentModel,
  type FileEntry,
  type TaskStatus,
  type TodoPhase,
  type ToolItem,
} from "./sessionInsights.ts";

const TASK_ICON: Record<TaskStatus, ReactNode> = {
  completed: <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-ok" />,
  in_progress: <Circle aria-hidden="true" className="size-3.5 shrink-0 animate-pulse text-accent" />,
  pending: <Circle aria-hidden="true" className="size-3.5 shrink-0 text-muted" />,
  blocked: <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />,
  abandoned: <CircleMinus aria-hidden="true" className="size-3.5 shrink-0 text-muted" />,
};

const SUBAGENT_STATE: Record<"pending" | "running" | "done" | "error", { label: string; className: string }> = {
  pending: { label: "等待", className: "text-muted" },
  running: { label: "运行中", className: "text-accent" },
  done: { label: "完成", className: "text-ok" },
  error: { label: "失败", className: "text-danger" },
};

function SectionCard({ icon, title, meta, children }: { icon: ReactNode; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-muted">{icon}</span>
        <span className="text-xs font-semibold">{title}</span>
        {meta !== undefined && <div className="ml-auto text-[11px] text-muted">{meta}</div>}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

function Meter({ value, total }: { value: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
  );
}

function FileRow({ entry }: { entry: FileEntry }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-[11px]">
      {entry.reviewed ? (
        <CheckCircle2 aria-hidden="true" className="size-3 shrink-0 text-ok" />
      ) : entry.reads > 0 ? (
        <Circle aria-hidden="true" className="size-3 shrink-0 fill-current text-accent" />
      ) : (
        <Circle aria-hidden="true" className="size-3 shrink-0 text-muted/40" />
      )}
      <span className={cn("min-w-0 flex-1 truncate", entry.reads === 0 && !entry.reviewed && "text-muted")} title={entry.path}>
        {entry.path.split("/").at(-1)}
      </span>
      {entry.reads > 0 && <span className="shrink-0 tabular-nums text-[10px] text-muted">{entry.reads}×</span>}
    </div>
  );
}

function FileProgressCard({ entries, read, reviewed, total, totalReads }: { entries: readonly FileEntry[]; read: number; reviewed: number; total: number; totalReads: number }) {
  const [showAll, setShowAll] = useState(false);
  const touched = entries.filter((entry) => entry.reads > 0 || entry.reviewed);
  const collapsed = !showAll && entries.length > 20;
  const visible = collapsed ? (touched.length > 0 ? touched : entries.slice(0, 8)) : entries;
  return (
    <SectionCard icon={<Files aria-hidden="true" className="size-3.5" />} title="文件进度">
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums">{total > 0 ? `${read}/${total}` : read}</span>
          <span className="text-[11px] text-muted">已读</span>
          {reviewed > 0 && <span className="ml-auto text-[11px] text-ok">已审 {reviewed}</span>}
          {reviewed === 0 && totalReads > 0 && <span className="ml-auto text-[11px] text-muted">{totalReads} 次读取</span>}
        </div>
        <Meter value={read} total={total > 0 ? total : read} />
        {total === 0 && (
          <p className="text-[11px] text-muted">{read === 0 ? "还没有读取文件。" : "未关联 PR 或文件列表不可用，只统计已读到的路径。"}</p>
        )}
        {visible.length > 0 && (
          <div className="scroll-thin max-h-64 overflow-y-auto pt-0.5">
            {visible.map((entry) => (
              <FileRow key={entry.path} entry={entry} />
            ))}
          </div>
        )}
        {collapsed && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11px] text-accent hover:underline"
          >
            显示全部 {entries.length} 个文件
          </button>
        )}
        {showAll && entries.length > 20 && (
          <button type="button" onClick={() => setShowAll(false)} className="text-[11px] text-muted hover:text-fg">
            只看已读
          </button>
        )}
      </div>
    </SectionCard>
  );
}

function PlanCard({ phases }: { phases: readonly TodoPhase[] | undefined }) {
  const stats = planStats(phases);
  return (
    <SectionCard icon={<ListTodo aria-hidden="true" className="size-3.5" />} title="计划" meta={phases !== undefined ? `${stats.completed}/${stats.total}` : undefined}>
      {phases === undefined ? (
        <p className="text-[11px] text-muted">Agent 还没建计划。开始审查时让它用 todo 列出文件或分片。</p>
      ) : (
        <div className="space-y-2">
          <Meter value={stats.completed} total={stats.total} />
          <div className="scroll-thin max-h-64 space-y-2 overflow-y-auto">
            {phases.map((phase) => (
              <div key={phase.name} className="space-y-0.5">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{phase.name}</div>
                {phase.tasks.map((task) => (
                  <div key={`${phase.name}:${task.content}`} className="flex items-start gap-1.5 py-0.5 text-[11px]">
                    {TASK_ICON[task.status]}
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        task.status === "completed" && "text-muted",
                        task.status === "abandoned" && "text-muted line-through",
                        task.status === "blocked" && "text-danger",
                      )}
                    >
                      {task.content}
                      {task.blocker !== undefined && <span className="text-danger"> · {task.blocker}</span>}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function SubagentCard({ items }: { items: readonly ToolItem[] }) {
  return (
    <SectionCard icon={<Bot aria-hidden="true" className="size-3.5" />} title="子代理" meta={items.length > 0 ? String(items.length) : undefined}>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted">还没有派发子代理。</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const state = SUBAGENT_STATE[item.tool.state];
            const model = subagentModel(item.tool);
            const task = stringArg(item.tool, "task");
            return (
              <div key={item.id} className="rounded border border-line bg-elevated/30 p-2">
                <div className="flex items-center gap-1.5 text-[11px]">
                  {item.tool.state === "running" ? (
                    <LoaderCircle aria-hidden="true" className="size-3 animate-spin text-accent" />
                  ) : (
                    <Bot aria-hidden="true" className="size-3 text-muted" />
                  )}
                  <code className="font-mono">{model !== undefined ? `@${model}` : "子代理"}</code>
                  <span className={cn("ml-auto", state.className)}>{state.label}</span>
                </div>
                {task !== undefined && <p className="mt-1 line-clamp-2 break-words text-[11px] text-muted">{task}</p>}
                {item.tool.result !== undefined && (
                  <details className="group mt-1">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-fg">
                      <ChevronRight aria-hidden="true" className="size-3 transition-transform group-open:rotate-90" />
                      结果
                    </summary>
                    <div className="relative mt-1">
                      <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface p-2 pr-8 font-mono text-[11px] leading-relaxed">
                        {item.tool.result}
                      </pre>
                      <CopyButton text={item.tool.result} label="复制结果" className="absolute right-1 top-1 bg-surface/90" />
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

export function ReviewSidebar({ items, prNumber }: { items: readonly ChatItem[]; prNumber?: number }) {
  const pr = usePr(prNumber ?? 0);
  const files = pr.data?.files ?? [];
  const progress = fileProgress(items, files, prNumber);
  const plan = parsePlan(items);
  const subagents = delegateItems(items);
  return (
    <div className="scroll-thin h-full min-h-0 space-y-3 overflow-y-auto p-3">
      <FileProgressCard
        entries={progress.entries}
        read={progress.read}
        reviewed={progress.reviewed}
        total={progress.total}
        totalReads={progress.totalReads}
      />
      <PlanCard phases={plan} />
      <SubagentCard items={subagents} />
    </div>
  );
}
