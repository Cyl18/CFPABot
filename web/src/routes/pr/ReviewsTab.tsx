import type { SessionSummary } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { formatRelative } from "@/lib/format.ts";
import { useSessions } from "@/lib/queries.ts";
import { RequireAdmin } from "@/components/RequireAdmin.tsx";
import { SessionStatusBadge } from "@/components/StatusBadges.tsx";
import { Badge } from "@/ui/Badge.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

export function ReviewsTab({ n }: { n: number }) {
  return (
    <RequireAdmin>
      <SessionsTable n={n} />
    </RequireAdmin>
  );
}

function SessionsTable({ n }: { n: number }) {
  const sessions = useSessions();
  const rows = (sessions.data ?? []).filter((session) => session.prNumber === n);

  const columns: readonly Column<SessionSummary>[] = [
    {
      id: "title",
      header: "会话",
      cell: (row) => (
        <Link to="/agent/$id" params={{ id: row.id }} className="hover:underline">
          {row.title || row.id}
        </Link>
      ),
    },
    { id: "status", header: "状态", width: 100, cell: (row) => <SessionStatusBadge status={row.status} /> },
    { id: "draft", header: "草稿", width: 100, cell: (row) => (row.hasDraft ? <Badge tone="ok">有</Badge> : <Badge>无</Badge>) },
    { id: "model", header: "模型", width: 200, cell: (row) => <code className="font-mono text-xs text-muted">{row.model}</code> },
    { id: "by", header: "创建者", width: 140, cell: (row) => row.createdBy },
    { id: "updated", header: "更新", width: 110, cell: (row) => <span className="text-muted">{formatRelative(row.updatedAt)}</span> },
  ];

  if (sessions.error !== null) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  if (sessions.isPending) return <SkeletonTable rows={3} columns={5} />;

  if (rows.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={<Bot aria-hidden="true" className="size-6" />}
            title="该 PR 还没有审查会话"
            description="在 PR 评论中发送 /agent-review，或在「概览」标签点击「开始审查」。"
            action={
              <Link to="/agent" className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg hover:brightness-110">
                打开 Agent 页面
              </Link>
            }
          />
        </CardBody>
      </Card>
    );
  }

  return <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} ariaLabel="该 PR 的审查会话" />;
}
