import type { SessionSummary } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { formatRelative } from "@/lib/format.ts";
import { usePack, useSessions } from "@/lib/queries.ts";
import { RequireAdmin } from "@/components/RequireAdmin.tsx";
import { SessionStatusBadge, VerdictBadge } from "@/components/StatusBadges.tsx";
import { Badge } from "@/ui/Badge.tsx";
import { buttonClass } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

export function ReviewsTab({ n }: { n: number }) {
  return (
    <RequireAdmin>
      <div className="flex flex-col gap-4">
        <PackCard n={n} />
        <SessionsTable n={n} />
      </div>
    </RequireAdmin>
  );
}

function PackCard({ n }: { n: number }) {
  const pack = usePack(n);
  if (pack.error !== null) return <ErrorState error={pack.error} onRetry={() => void pack.refetch()} />;
  if (pack.isPending) return <SkeletonTable rows={3} columns={3} />;
  const data = pack.data;
  return (
    <Card>
      <CardHeader
        title="机械预审"
        description={`head ${data.headSha.slice(0, 7)} · ${formatRelative(data.generatedAt)}生成 · ${data.counts.rows} 行`}
        actions={<Badge tone={data.counts.flagged > 0 ? "warn" : "ok"}>{data.counts.flagged} 行有提示</Badge>}
      />
      <CardBody className="flex flex-col gap-3">
        {data.workspaces.length === 0 ? (
          <EmptyState compact title="没有可审查的语言文件" description="该 PR 的变更里没有 en_us / zh_cn 文件。" />
        ) : (
          data.workspaces.map((workspace) => (
            <div key={workspace.workspace} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="font-mono text-xs text-fg">{workspace.workspace}</code>
                <span className="text-xs text-muted tabular-nums">
                  变更 {workspace.counts.changed} · 标记 {workspace.counts.flagged}
                </span>
              </div>
              {Object.keys(workspace.histogram).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(workspace.histogram).map(([code, count]) => (
                    <Badge key={code}>
                      {code} × {count}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

function SessionsTable({ n }: { n: number }) {
  const sessions = useSessions();
  const rows = (sessions.data ?? []).filter((session) => session.draft?.prNumber === n);

  const columns: readonly Column<SessionSummary>[] = [
    {
      id: "title",
      header: "会话",
      cell: (row) => (
        <Link to="/agent/$id" params={{ id: row.id }} className="block truncate hover:underline" title={row.title || row.id}>
          {row.title || row.id}
        </Link>
      ),
    },
    {
      id: "draft",
      header: "草稿",
      width: 160,
      cell: (row) =>
        row.draft ? (
          <span className="flex items-center gap-1.5">
            <VerdictBadge verdict={row.draft.verdict} />
            <span className="text-xs text-muted">{row.draft.comments} 条</span>
          </span>
        ) : (
          <Badge>无</Badge>
        ),
    },
    { id: "status", header: "状态", width: 100, cell: (row) => <SessionStatusBadge status={row.status} /> },
    {
      id: "model",
      header: "模型",
      width: 200,
      hideBelow: "lg",
      cell: (row) => (
        <code className="block truncate font-mono text-xs text-muted" title={row.model}>
          {row.model}
        </code>
      ),
    },
    { id: "updated", header: "更新", width: 110, cell: (row) => <span className="text-muted">{formatRelative(row.updatedAt)}</span> },
    {
      id: "open",
      header: "",
      width: 110,
      cell: (row) => (
        <Link to="/agent/$id" params={{ id: row.id }} className={buttonClass("ghost")}>
          打开会话
        </Link>
      ),
    },
  ];

  if (sessions.error !== null) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  if (sessions.isPending) return <SkeletonTable rows={3} columns={5} />;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Bot aria-hidden="true" className="size-6" />}
        title="该 PR 还没有审查会话"
        description="在 PR 评论中发送 /agent-review，或在「概览」标签点击「开始审查」。"
        action={
          <Link to="/agent" className={buttonClass("primary")}>
            打开 Agent 页面
          </Link>
        }
      />
    );
  }

  return <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} ariaLabel="该 PR 的审查会话" valign="middle" />;
}
