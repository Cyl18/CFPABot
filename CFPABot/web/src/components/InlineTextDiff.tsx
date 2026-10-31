import { useMemo } from "react";
import { cn } from "@/lib/cn.ts";
import { inlineDiff, type DiffSegment } from "@/lib/diff.ts";
import { useDiffMode } from "@/lib/diffMode.ts";
import { expandNewlines } from "@/lib/format.ts";

export const INSERT = "rounded-sm bg-ok/20 px-0.5 text-ok no-underline";
export const DELETE = "rounded-sm bg-danger/20 px-0.5 text-danger line-through decoration-danger/60";
export const CHANGE = "rounded-sm bg-warn/20 px-0.5 text-warn";

export function InlineRuns({ segments }: { segments: readonly DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "insert" ? (
          <ins key={index} className={INSERT}>
            {segment.text}
          </ins>
        ) : segment.type === "delete" ? (
          <del key={index} className={DELETE}>
            {segment.text}
          </del>
        ) : segment.type === "change" ? (
          <span key={index} className={CHANGE}>
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export interface InlineTextDiffProps {
  /** undefined 表示没有可比来源，原样显示 after；null 表示这一侧是空的。 */
  before?: string | null;
  after?: string | null;
  className?: string;
}

export function InlineTextDiff({ before, after, className }: InlineTextDiffProps) {
  const [mode] = useDiffMode();
  const left = expandNewlines(before ?? "");
  const right = expandNewlines(after ?? "");
  const segments = useMemo(() => inlineDiff(left, right, mode), [left, right, mode]);

  if (before === undefined) return <span className={className}>{right}</span>;
  if (left === "" && right === "") return <span className="text-muted">—</span>;
  if (mode === "off" || left === right) return <span className={className}>{right === "" ? left : right}</span>;
  if (left === "") return <ins className={cn(INSERT, className)}>{right}</ins>;
  if (right === "") return <del className={cn(DELETE, className)}>{left}</del>;
  return (
    <span className={className}>
      <InlineRuns segments={segments} />
    </span>
  );
}
