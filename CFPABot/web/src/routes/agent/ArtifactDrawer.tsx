import { FileText, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CodeBlock } from "@/components/CodeBlock.tsx";
import { Markdown } from "@/components/Markdown.tsx";
import { useSessionFile } from "@/lib/queries.ts";
import { Button } from "@/ui/Button.tsx";
import { CopyButton } from "@/ui/CopyButton.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { DraftPanel, type DraftPanelProps } from "./DraftPanel.tsx";

/** 代码预览上限：再大的产物在浏览器里高亮会卡。 */
const PREVIEW_LIMIT = 100_000;

/** TSV 预览行数上限：术语表可能上千行，抽屉里只当作预览看。 */
const TSV_ROWS = 500;

function previewText(content: string, extension: string): string {
  let text = content;
  if (extension === "json") {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {}
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n…（已截断，共 ${text.length} 字符）` : text;
}

// shortcut: 不处理 RFC4180 引号转义，术语表按纯制表符切分；出现带引号字段再补解析。
function TsvTable({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  const header = lines[0]?.split("\t") ?? [];
  const rows = lines.slice(1, TSV_ROWS + 1).map((line) => line.split("\t"));
  if (header.length === 0) return <p className="text-xs text-muted">空表格。</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="scroll-thin overflow-auto rounded-md border border-line">
        <table className="w-full border-separate border-spacing-0 text-[11px]">
          <thead>
            <tr>
              {header.map((cell, column) => (
                <th
                  key={column}
                  className="sticky top-0 z-10 whitespace-nowrap border-b border-line bg-elevated px-2 py-1 text-left font-medium text-muted"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, row) => (
              <tr key={row} className="align-top">
                {header.map((_, column) => (
                  <td key={column} className="border-b border-line px-2 py-1 break-words last:border-r-0">
                    {cells[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length - 1 > TSV_ROWS && (
        <p className="text-[11px] text-muted">
          只显示前 {TSV_ROWS} 行，共 {lines.length - 1} 行。
        </p>
      )}
    </div>
  );
}

export function ArtifactDrawer({
  sessionId,
  name,
  live,
  draft,
  onClose,
}: {
  sessionId: string;
  name: string;
  live: boolean;
  draft?: Omit<DraftPanelProps, "onClose">;
  onClose(): void;
}) {
  const interval = live ? 3_000 : false;
  const file = useSessionFile(sessionId, name, true, interval);
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const content = file.data?.content;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <>
      <div className="agent-fade fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label={name}
        className="agent-drawer-in fixed inset-y-0 right-0 z-40 flex w-[min(720px,100vw)] flex-col border-l border-line bg-surface shadow-[var(--shadow-panel)]"
      >
        {name === "draft.json" && draft !== undefined ? (
          <DraftPanel {...draft} onClose={onClose} />
        ) : (
          <>
            <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
              <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
              {content !== undefined && <CopyButton text={content} />}
              <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
                <X aria-hidden="true" className="size-4" />
              </Button>
            </header>
            <div className="scroll-thin min-h-0 flex-1 overflow-auto p-3">
              {file.isPending ? (
                <SkeletonText lines={10} />
              ) : file.isError ? (
                <ErrorState error={file.error} onRetry={() => void file.refetch()} title="读取失败" />
              ) : extension === "md" ? (
                <Markdown>{content ?? ""}</Markdown>
              ) : extension === "tsv" ? (
                <TsvTable text={content ?? ""} />
              ) : (
                <CodeBlock code={previewText(content ?? "", extension)} lang={extension === "json" ? "json" : undefined} />
              )}
            </div>
          </>
        )}
      </aside>
    </>,
    document.body,
  );
}
