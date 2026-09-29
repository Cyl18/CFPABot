import { FileDiff } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { lineDiff, toSideBySide, type DiffKind, type LineDiffRow } from "@/lib/diff.ts";
import { useSpecial } from "@/lib/queries.ts";
import { FileStatusBadge } from "@/ui/Badge.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";

const ROW_BG: Record<DiffKind, string> = {
  equal: "",
  insert: "bg-ok/10",
  delete: "bg-danger/10",
};

const TEXT_COLOR: Record<DiffKind, string> = {
  equal: "text-fg",
  insert: "text-ok",
  delete: "text-danger",
};

const GUTTER = "select-none border-r border-line px-2 text-right text-[11px] text-muted";

export function SpecialTab({ n, paths }: { n: number; paths: string[] }) {
  const special = useSpecial(n);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"unified" | "side">("unified");

  const files = special.data ?? [];
  const file = files[active] ?? files[0] ?? null;
  const rows = useMemo(() => (file ? lineDiff(file.base ?? "", file.head ?? "") : []), [file]);
  const paired = useMemo(() => (mode === "side" ? toSideBySide(rows) : []), [mode, rows]);

  if (special.error !== null) return <ErrorState error={special.error} onRetry={() => void special.refetch()} />;
  if (special.isPending) return <SkeletonText lines={6} />;
  if (files.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff aria-hidden="true" className="size-5" />}
        title="没有特殊文件变更"
        description={paths.length > 0 ? "特殊文件内容为空或超出大小限制。" : "本次 PR 没有手册 / 文档等非语言文件变更。"}
      />
    );
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {files.map((item, index) => (
            <button
              key={item.path}
              type="button"
              aria-pressed={index === active}
              onClick={() => setActive(index)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs",
                index === active ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-elevated text-muted hover:text-fg",
              )}
              title={item.path}
            >
              {item.path.split("/").pop()}
              <FileStatusBadge status={item.status} />
            </button>
          ))}
          <div role="group" aria-label="差异视图模式" className="ml-auto flex gap-1">
            {(["unified", "side"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
                className={cn(
                  "rounded border px-2 py-1 text-xs",
                  mode === option ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-elevated text-muted hover:text-fg",
                )}
              >
                {option === "unified" ? "统一" : "并排"}
              </button>
            ))}
          </div>
        </div>

        {file && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <code className="font-mono">{file.path}</code>
              <FileStatusBadge status={file.status} />
              {file.truncated && <span className="text-warn">内容过大，已截断</span>}
            </div>

            <div className="scroll-thin max-h-[65vh] overflow-auto rounded border border-line bg-surface">
              {mode === "unified" ? (
                <table className="w-full border-collapse font-mono text-xs">
                  <caption className="sr-only">统一差异视图</caption>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index} className={ROW_BG[row.type]}>
                        <td className={GUTTER}>{row.leftLine ?? ""}</td>
                        <td className={GUTTER}>{row.rightLine ?? ""}</td>
                        <td className={cn("whitespace-pre-wrap break-all px-2", TEXT_COLOR[row.type])}>
                          {row.type === "insert" ? "+" : row.type === "delete" ? "-" : " "}
                          {row.text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full table-fixed border-collapse font-mono text-xs">
                  <caption className="sr-only">并排差异视图</caption>
                  <tbody>
                    {paired.map((pair, index) => (
                      <tr key={index}>
                        <td className={GUTTER}>{pair.left?.leftLine ?? ""}</td>
                        <td className={cn("w-1/2 whitespace-pre-wrap break-all border-r border-line px-2", pair.left ? TEXT_COLOR[pair.left.type] : "", pair.left ? ROW_BG[pair.left.type] : "bg-elevated/40")}>
                          {pair.left?.text ?? ""}
                        </td>
                        <td className={GUTTER}>{pair.right?.rightLine ?? ""}</td>
                        <td className={cn("w-1/2 whitespace-pre-wrap break-all px-2", pair.right ? TEXT_COLOR[pair.right.type] : "", pair.right ? ROW_BG[pair.right.type] : "bg-elevated/40")}>
                          {pair.right?.text ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <DiffSummary rows={rows} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function DiffSummary({ rows }: { rows: readonly LineDiffRow[] }) {
  const added = rows.filter((row) => row.type === "insert").length;
  const removed = rows.filter((row) => row.type === "delete").length;
  return (
    <p className="text-xs text-muted">
      共 {rows.length} 行 · <span className="text-ok">+{added}</span> · <span className="text-danger">-{removed}</span>
    </p>
  );
}
