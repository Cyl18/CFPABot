import type { TodoStatus, ToolCallView } from "@cfpa/contracts/api";
import { ArrowUpRight, Bot, CheckCircle2, Circle, CircleAlert, CircleMinus, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { formatJson } from "@/lib/format.ts";
import { isRecord } from "@/lib/guards.ts";
import { CopyButton } from "@/ui/CopyButton.tsx";
import { planStats, resolveFilePath, stringArg, subagentModel, todoPhases } from "./sessionInsights.ts";

const TASK_ICON: Record<TodoStatus, ReactNode> = {
  completed: <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-ok" />,
  in_progress: <Circle aria-hidden="true" className="size-3.5 shrink-0 animate-pulse text-accent" />,
  pending: <Circle aria-hidden="true" className="size-3.5 shrink-0 text-muted" />,
  blocked: <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />,
  abandoned: <CircleMinus aria-hidden="true" className="size-3.5 shrink-0 text-muted" />,
};

function Field({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
        {action !== undefined && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function Pre({ text, label, danger = false, max = "max-h-80" }: { text: string; label: string; danger?: boolean; max?: string }) {
  return (
    <div className="relative">
      <pre
        className={cn(
          "scroll-thin overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface p-2 pr-8 font-mono text-[11px] leading-relaxed",
          max,
          danger && "border-danger/40 bg-danger/5 text-danger",
        )}
      >
        {text}
      </pre>
      <CopyButton text={text} label={label} className="absolute right-1 top-1 bg-surface/90" />
    </div>
  );
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split("\n").find((part) => part.trim() !== "")?.trim();
  return line;
}

function basename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.at(-1) ?? path;
}

export function toolPreview(tool: ToolCallView): string {
  const path = stringArg(tool, "path");
  if (tool.name === "read") return path ?? "读取文件";
  if (tool.name === "bash") return firstLine(stringArg(tool, "command")) ?? "bash";
  if (tool.name === "eval") return firstLine(stringArg(tool, "code")) ?? "eval";
  if (tool.name === "grep") {
    const pattern = stringArg(tool, "pattern") ?? stringArg(tool, "query");
    return [pattern, path].filter((part) => part !== undefined && part !== "").join(" · ") || "grep";
  }
  if (tool.name === "write" || tool.name === "edit") return path ?? tool.name;
  if (tool.name === "todo") {
    const stats = planStats(todoPhases(tool.details));
    return stats.total > 0 ? `计划 ${stats.completed}/${stats.total}` : "计划";
  }
  if (tool.name === "delegate") {
    const model = subagentModel(tool);
    const task = firstLine(stringArg(tool, "task"));
    return [model !== undefined ? `@${model}` : "子代理", task].filter((part) => part !== undefined).join(" · ");
  }
  return tool.progress ?? "";
}

/** 折叠组的一行摘要：先给工具构成，再给最近一次 read 的文件。 */
export function toolComposition(items: readonly { tool: ToolCallView }[]): string {
  const counts = new Map<string, number>();
  let errors = 0;
  for (const item of items) {
    counts.set(item.tool.name, (counts.get(item.tool.name) ?? 0) + 1);
    if (item.tool.state === "error") errors += 1;
  }
  const parts = [...counts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([name, count]) => `${name} × ${count}`);
  if (errors > 0) parts.push(`${errors} 失败`);
  const lastRead = [...items].reverse().find((item) => {
    if (item.tool.name !== "read") return false;
    const path = stringArg(item.tool, "path");
    return path !== undefined && !path.startsWith("skill://") && !path.startsWith("local://");
  });
  if (lastRead !== undefined) {
    const path = stringArg(lastRead.tool, "path");
    if (path !== undefined) parts.push(`最近 ${basename(path)}`);
  }
  return parts.join(" · ");
}

function prFileLink(path: string, prNumber: number | undefined): string | null {
  if (prNumber === undefined) return null;
  const clean = path.split("?")[0] ?? "";
  const marker = `/runtime/work/pr/${prNumber}/`;
  if (!clean.startsWith(`pr://${prNumber}/files/`) && !clean.includes(marker)) return null;
  return resolveFilePath(path, prNumber);
}

function ReadBody({ tool, prNumber }: { tool: ToolCallView; prNumber?: number }) {
  const path = stringArg(tool, "path") ?? "";
  const link = prFileLink(path, prNumber);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5">
        <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted" />
        <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg">{path}</code>
        {link !== null && (
          <a
            href={`/pr/${prNumber}/files?file=${encodeURIComponent(link)}`}
            target="_blank"
            rel="noreferrer"
            title="在 PR 文件页打开"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-elevated hover:text-fg"
          >
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        )}
        <CopyButton text={path} label="复制路径" />
      </div>
      {tool.result !== undefined && <Pre text={tool.result} label="复制内容" max="max-h-96" />}
    </div>
  );
}

function EvalBody({ tool }: { tool: ToolCallView }) {
  const code = stringArg(tool, "code") ?? "";
  const language = stringArg(tool, "language");
  return (
    <div className="space-y-2">
      {code !== "" && (
        <Field label={language !== undefined ? `代码 · ${language}` : "代码"} action={<CopyButton text={code} label="复制代码" />}>
          <Pre text={code} label="复制代码" max="max-h-64" />
        </Field>
      )}
      {tool.result !== undefined && (
        <Field label="输出" action={<CopyButton text={tool.result} label="复制输出" />}>
          <Pre text={tool.result} label="复制输出" danger={tool.state === "error"} max="max-h-80" />
        </Field>
      )}
    </div>
  );
}

function BashBody({ tool }: { tool: ToolCallView }) {
  const command = stringArg(tool, "command") ?? "";
  const exitCode = isRecord(tool.details) && typeof tool.details.exitCode === "number" ? tool.details.exitCode : undefined;
  return (
    <div className="space-y-2">
      <Field
        label="命令"
        action={
          <div className="flex items-center gap-1">
            {exitCode !== undefined && <span className={cn("font-mono text-[10px]", exitCode === 0 ? "text-ok" : "text-danger")}>exit {exitCode}</span>}
            <CopyButton text={command} label="复制命令" />
          </div>
        }
      >
        <Pre text={`$ ${command}`} label="复制命令" max="max-h-40" />
      </Field>
      {tool.result !== undefined && (
        <Field label="输出" action={<CopyButton text={tool.result} label="复制输出" />}>
          <Pre text={tool.result} label="复制输出" danger={tool.state === "error"} max="max-h-80" />
        </Field>
      )}
    </div>
  );
}

function GrepBody({ tool }: { tool: ToolCallView }) {
  const pattern = stringArg(tool, "pattern") ?? stringArg(tool, "query") ?? "";
  const path = stringArg(tool, "path");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <code className="rounded bg-elevated px-1.5 py-0.5">{pattern}</code>
        {path !== undefined && <span className="break-all text-muted">{path}</span>}
      </div>
      {tool.result !== undefined && (
        <Field label="命中" action={<CopyButton text={tool.result} label="复制命中" />}>
          <Pre text={tool.result} label="复制命中" max="max-h-80" />
        </Field>
      )}
    </div>
  );
}

function TodoBody({ tool }: { tool: ToolCallView }) {
  const phases = todoPhases(tool.details);
  const stats = planStats(phases);
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted">
        计划 {stats.completed}/{stats.total} 完成
        {stats.active > 0 ? ` · ${stats.active} 进行中` : ""}
        {stats.blocked > 0 ? ` · ${stats.blocked} 受阻` : ""}
      </div>
      {phases?.map((phase) => (
        <div key={phase.name} className="space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{phase.name}</div>
          {phase.tasks.map((task) => (
            <div key={`${phase.name}:${task.content}`} className="flex items-start gap-1.5 text-[11px]">
              {TASK_ICON[task.status]}
              <span className={cn("min-w-0 break-words", task.status === "completed" && "text-muted", task.status === "abandoned" && "text-muted line-through")}>
                {task.content}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DelegateBody({ tool }: { tool: ToolCallView }) {
  const model = subagentModel(tool);
  const task = stringArg(tool, "task") ?? "";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px]">
        <Bot aria-hidden="true" className="size-3.5 text-muted" />
        <code className="font-mono">{model !== undefined ? `@${model}` : "子代理"}</code>
        <span className="text-muted">只返回最终文本</span>
      </div>
      {task !== "" && (
        <Field label="任务" action={<CopyButton text={task} label="复制任务" />}>
          <Pre text={task} label="复制任务" max="max-h-40" />
        </Field>
      )}
      {tool.result !== undefined && (
        <Field label="结果" action={<CopyButton text={tool.result} label="复制结果" />}>
          <Pre text={tool.result} label="复制结果" danger={tool.state === "error"} max="max-h-80" />
        </Field>
      )}
    </div>
  );
}

function GenericBody({ tool }: { tool: ToolCallView }) {
  return (
    <div className="space-y-2">
      <Field label="参数" action={<CopyButton text={formatJson(tool.args)} label="复制参数" />}>
        <Pre text={formatJson(tool.args)} label="复制参数" max="max-h-48" />
      </Field>
      {tool.result !== undefined && (
        <Field label="结果" action={<CopyButton text={tool.result} label="复制结果" />}>
          <Pre text={tool.result} label="复制结果" danger={tool.state === "error"} max="max-h-64" />
        </Field>
      )}
    </div>
  );
}

export function ToolBody({ tool, prNumber }: { tool: ToolCallView; prNumber?: number }) {
  switch (tool.name) {
    case "read":
      return <ReadBody tool={tool} prNumber={prNumber} />;
    case "eval":
      return <EvalBody tool={tool} />;
    case "bash":
      return <BashBody tool={tool} />;
    case "grep":
      return <GrepBody tool={tool} />;
    case "todo":
      return <TodoBody tool={tool} />;
    case "delegate":
      return <DelegateBody tool={tool} />;
    default:
      return <GenericBody tool={tool} />;
  }
}
