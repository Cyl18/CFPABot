import { FileText } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "@/components/CodeBlock.tsx";
import { cn } from "@/lib/cn.ts";
import { useSessionFile, useSessionFiles } from "@/lib/queries.ts";
import { CopyButton } from "@/ui/CopyButton.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";

/** 单文件预览上限：再大的产物在浏览器里高亮会卡。 */
const PREVIEW_LIMIT = 100_000;

const LANG: Record<string, string> = { json: "json", md: "markdown" };

function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 预览用文本：JSON 展开缩进，超长截断，避免高亮卡死。 */
function previewText(content: string, name: string): string {
  let text = content;
  if (name.endsWith(".json")) {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {}
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n…（已截断，共 ${text.length} 字符）` : text;
}

export function ArtifactPanel({ id, live = false }: { id: string; live?: boolean }) {
  const interval = live ? 3_000 : false;
  const files = useSessionFiles(id, true, interval);
  const [picked, setPicked] = useState<string | null>(null);
  const list = files.data ?? [];
  const active = picked !== null && list.some((entry) => entry.name === picked)
    ? picked
    : list.find((file) => file.name === "draft.json")?.name ?? list[0]?.name ?? null;
  const file = useSessionFile(id, active, files.isSuccess, interval);

  if (files.isError) return <ErrorState error={files.error} onRetry={() => void files.refetch()} />;
  if (list.length === 0) {
    return (
      <EmptyState
        icon={<FileText aria-hidden="true" className="size-6" />}
        title={files.isPending ? "正在读取产物…" : "还没有产物"}
        description={files.isPending ? undefined : "Agent 写进 local:// 的文件会出现在这里。"}
        compact
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul className="scroll-thin max-h-44 shrink-0 overflow-y-auto border-b border-line py-1">
        {list.map((entry) => (
          <li key={entry.name}>
            <button
              type="button"
              onClick={() => setPicked(entry.name)}
              title={entry.name}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-elevated",
                entry.name === active ? "bg-accent-soft text-accent" : "text-fg",
              )}
            >
              <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted">{sizeOf(entry.size)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1 text-[11px] text-muted">
          <span className="min-w-0 flex-1 truncate font-mono">{active}</span>
          {file.data !== undefined && <CopyButton text={file.data.content} />}
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-2 text-[11px]">
          {file.isPending ? (
            <SkeletonText lines={8} />
          ) : file.isError ? (
            <ErrorState error={file.error} onRetry={() => void file.refetch()} title="读取失败" />
          ) : (
            <CodeBlock
              code={previewText(file.data.content, file.data.name)}
              lang={LANG[file.data.name.split(".").pop()?.toLowerCase() ?? ""]}
            />
          )}
        </div>
      </div>
    </div>
  );
}
