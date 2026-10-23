import type { PrState, SessionStatus, Severity, Verdict } from "@cfpa/contracts/api";
import { Badge } from "@/ui/Badge.tsx";

const PR_STATE: Record<PrState, { label: string; tone: "ok" | "info" | "neutral" }> = {
  open: { label: "审核中", tone: "ok" },
  merged: { label: "已合并", tone: "info" },
  closed: { label: "已关闭", tone: "neutral" },
};

export function PrStateBadge({ state, draft }: { state: PrState; draft?: boolean }) {
  const meta = PR_STATE[state];
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

const VERDICT: Record<Verdict, { label: string; tone: "ok" | "warn" | "danger" }> = {
  approve: { label: "通过", tone: "ok" },
  changes: { label: "需要修改", tone: "warn" },
  reject: { label: "拒绝", tone: "danger" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const meta = VERDICT[verdict];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export const VERDICT_OPTIONS = [
  { value: "approve", label: "通过（approve）" },
  { value: "changes", label: "需要修改（changes）" },
  { value: "reject", label: "拒绝（reject）" },
] as const;

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return status === "running" ? <Badge tone="warn">运行中</Badge> : <Badge tone="info">空闲</Badge>;
}
