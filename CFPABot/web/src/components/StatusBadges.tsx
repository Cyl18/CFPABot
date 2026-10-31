import type { PrState, ReviewEvent, SessionStatus, Severity } from "@cfpa/contracts/api";
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

const SEVERITY: Record<Severity, { label: string; tone: "danger" | "warn" | "info" | "neutral" }> = {
  critical: { label: "严重", tone: "danger" },
  major: { label: "主要", tone: "warn" },
  minor: { label: "次要", tone: "info" },
  neutral: { label: "中性", tone: "neutral" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = SEVERITY[severity];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

const EVENT: Record<ReviewEvent, { label: string; tone: "ok" | "info" | "warn" }> = {
  APPROVE: { label: "可以合", tone: "ok" },
  COMMENT: { label: "要改", tone: "info" },
  REQUEST_CHANGES: { label: "大改", tone: "warn" },
};

export function EventBadge({ event }: { event: ReviewEvent }) {
  const meta = EVENT[event];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export const EVENT_OPTIONS = [
  { value: "APPROVE", label: "可以合（APPROVE）" },
  { value: "COMMENT", label: "不能合，按评论改（COMMENT）" },
  { value: "REQUEST_CHANGES", label: "不能合，问题太大（REQUEST_CHANGES）" },
] as const;

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return status === "running" ? <Badge tone="warn">运行中</Badge> : <Badge tone="info">空闲</Badge>;
}
