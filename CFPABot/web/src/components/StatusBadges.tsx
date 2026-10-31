import type { PrState, ReviewEvent, SessionStatus, Severity } from "@cfpa/contracts/api";
import { REVIEW_EVENT_META, SEVERITY_META } from "@cfpa/contracts/api";
import { Badge } from "@/ui/Badge.tsx";

export const MERGE_SOON_LABEL = "即将合并";

const PR_STATE: Record<PrState, { label: string; tone: "ok" | "info" | "neutral" }> = {
  open: { label: "审核中", tone: "ok" },
  merged: { label: "已合并", tone: "info" },
  closed: { label: "已关闭", tone: "neutral" },
};

const MERGE_SOON = { label: MERGE_SOON_LABEL, tone: "warn" } as const;

export function hasMergeSoonLabel(labels: readonly string[]): boolean {
  return labels.includes(MERGE_SOON_LABEL);
}

export function PrStateBadge({ state, draft, labels }: { state: PrState; draft?: boolean; labels?: readonly string[] }) {
  const meta = state === "open" && labels !== undefined && hasMergeSoonLabel(labels) ? MERGE_SOON : PR_STATE[state];
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {draft === true && <Badge>草稿</Badge>}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function EventBadge({ event }: { event: ReviewEvent }) {
  const meta = REVIEW_EVENT_META[event];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return status === "running" ? <Badge tone="warn">运行中</Badge> : <Badge tone="info">空闲</Badge>;
}
