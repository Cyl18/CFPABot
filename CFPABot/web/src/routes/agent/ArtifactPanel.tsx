import { FileText } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { useSessionFiles } from "@/lib/queries.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { ArtifactDrawer } from "./ArtifactDrawer.tsx";
import type { DraftPanelProps } from "./DraftPanel.tsx";

const DRAFT_FILE = "draft.json";

function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function ArtifactPanel({
  id,
  live = false,
  draft,
}: {
  id: string;
  live?: boolean;
  draft?: Omit<DraftPanelProps, "onClose">;
}) {
  const interval = live ? 3_000 : false;
  const files = useSessionFiles(id, true, interval);
  const [open, setOpen] = useState<string | null>(null);
  const list = files.data ?? [];

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
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto py-1">
        {list.map((entry) => {
          const isDraft = entry.name === DRAFT_FILE;
          const active = entry.name === open;
          return (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => setOpen(entry.name)}
                title={entry.name}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                  isDraft
                    ? active
                      ? "bg-warn/20 text-warn"
                      : "bg-warn/10 text-warn hover:bg-warn/20"
                    : active
                      ? "bg-accent-soft text-accent"
                      : "text-fg hover:bg-elevated",
                )}
              >
                <FileText aria-hidden="true" className={cn("size-3.5 shrink-0", isDraft ? "text-warn" : "text-muted")} />
                <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted">{sizeOf(entry.size)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {open !== null && (
        <ArtifactDrawer
          sessionId={id}
          name={open}
          live={live}
          onClose={() => setOpen(null)}
          {...(draft === undefined ? {} : { draft })}
        />
      )}
    </div>
  );
}
