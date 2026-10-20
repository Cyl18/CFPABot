import type { SessionSummary } from "@shared/api.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, Bot, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { SessionStatusBadge } from "@/components/StatusBadges.tsx";
import { api, errorMessage } from "@/lib/api.ts";
import { formatRelative } from "@/lib/format.ts";
import { qk, useSessions } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Dialog } from "@/ui/Dialog.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";
import { NewSessionDialog } from "@/routes/agent/NewSessionDialog.tsx";

type ScopeTab = "active" | "archived" | "all";

const TABS: readonly TabItem<ScopeTab>[] = [
  { id: "active", label: "活跃" },
  { id: "archived", label: "已归档" },
  { id: "all", label: "全部" },
];

export function SessionListPage() {
  const sessions = useSessions();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [scope, setScope] = useState<ScopeTab>("active");
  const [newOpen, setNewOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<SessionSummary | null>(null);

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveSession(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.sessions });
      setPendingArchive(null);
    },
  });

  const rows = useMemo(() => {
    const all = sessions.data ?? [];
    if (scope === "active") return all.filter((session) => !session.archived);
    if (scope === "archived") return all.filter((session) => session.archived);
    return all;
  }, [sessions.data, scope]);

  const columns: readonly Column<SessionSummary>[] = [
    {
      id: "title",
      header: "会话",
      cell: (row) => (
        <Link to="/agent/$id" params={{ id: row.id }} className="flex min-w-0 flex-col hover:underline" title={row.title || row.id}>
          <span className="block truncate">{row.title || row.id}</span>
          <code className="block truncate font-mono text-xs text-muted">{row.id}</code>
        </Link>
      ),
    },
    {
      id: "pr",
      header: "PR",
      width: 90,
      cell: (row) =>
        row.prNumber === undefined ? (
          <span className="text-muted">-</span>
        ) : (
          <Link to="/pr/$n" params={{ n: String(row.prNumber) }} className="font-mono text-accent hover:underline">
            #{row.prNumber}
          </Link>
        ),
    },
    { id: "status", header: "状态", width: 100, cell: (row) => <SessionStatusBadge status={row.status} /> },
    { id: "draft", header: "草稿", width: 90, cell: (row) => (row.hasDraft ? <Badge tone="ok">有</Badge> : <Badge>无</Badge>) },
    { id: "model", header: "模型", width: 200, hideBelow: "lg", cell: (row) => <code className="block truncate font-mono text-xs text-muted">{row.model}</code> },
    { id: "by", header: "创建者", width: 120, hideBelow: "xl", cell: (row) => row.createdBy },
    { id: "updated", header: "更新", width: 110, cell: (row) => <span className="text-muted">{formatRelative(row.updatedAt)}</span> },
    {
      id: "actions",
      header: "操作",
      width: 90,
      cell: (row) =>
        row.archived ? (
          <span className="text-xs text-muted">已归档</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            title="归档会话"
            aria-label="归档会话"
            onClick={() => setPendingArchive(row)}
            icon={<Archive aria-hidden="true" className="size-3.5" />}
          />
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Agent 会话"
        description={`${sessions.data?.length ?? 0} 个会话`}
        actions={
          <Button variant="primary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setNewOpen(true)}>
            新建会话
          </Button>
        }
      />

      <div className="mb-3">
        <Tabs items={TABS} value={scope} onChange={setScope} ariaLabel="会话范围筛选" />
      </div>

      {sessions.error !== null ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : sessions.isPending ? (
        <SkeletonTable rows={6} columns={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Bot aria-hidden="true" className="size-6" />}
          title="没有会话"
          description="新建一个会话，或在 PR 评论中发送 /agent 或 /agent-review。"
          action={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              新建会话
            </Button>
          }
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} ariaLabel="Agent 会话列表" valign="middle" />
      )}

      <NewSessionDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => void navigate({ to: "/agent/$id", params: { id } })}
      />

      <Dialog
        open={pendingArchive !== null}
        onClose={() => setPendingArchive(null)}
        title="归档会话"
        description={`确认归档「${pendingArchive?.title ?? pendingArchive?.id ?? ""}」？归档后仍可在「已归档」中查看。`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setPendingArchive(null)}>取消</Button>
            <Button
              variant="danger"
              loading={archive.isPending}
              onClick={() => {
                if (pendingArchive) archive.mutate(pendingArchive.id);
              }}
            >
              归档
            </Button>
          </>
        }
      >
        {archive.isError && <p className="text-xs text-danger">{errorMessage(archive.error)}</p>}
      </Dialog>
    </>
  );
}
