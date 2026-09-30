import { useMemo } from "react";
import { cn } from "@/lib/cn.ts";
import { inlineDiff } from "@/lib/diff.ts";
import { useDiffMode } from "@/lib/diffMode.ts";
import { expandNewlines } from "@/lib/format.ts";

export interface InlineTextDiffProps {
  before?: string;
  after?: string;
  className?: string;
}

export function InlineTextDiff({ before, after, className }: InlineTextDiffProps) {
  const [mode] = useDiffMode();
  const left = expandNewlines(before ?? "");
  const right = expandNewlines(after ?? "");
  const segments = useMemo(() => inlineDiff(left, right, mode), [left, right, mode]);

  if (left === "" && right === "") return <span className="text-muted">-</span>;

  if (mode === "off") {
    return <span className={cn("whitespace-pre-wrap break-words", className)}>{right === "" ? left : right}</span>;
  }

  if (left === "") {
    return <span className={cn("whitespace-pre-wrap break-words rounded-sm bg-ok/20 px-0.5 text-ok", className)}>{right}</span>;
  }

  if (right === "") {
    return <span className={cn("whitespace-pre-wrap break-words rounded-sm bg-danger/20 px-0.5 text-danger", className)}>{left}</span>;
  }

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {segments.map((segment, index) => {
        if (segment.type === "equal") return <span key={index}>{segment.text}</span>;
        return (
          <span
            key={index}
            className={cn(
              "rounded-sm px-0.5",
              segment.type === "delete" ? "bg-danger/20 text-danger" : "bg-ok/20 text-ok",
              segment.block && "mr-0.5 inline-block",
            )}
          >
            {segment.text}
          </span>
        );
      })}
    </span>
  );
}
