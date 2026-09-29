import type { PrDetail } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CheckReportView } from "@/components/CheckReport.tsx";
import { formatDateTime } from "@/lib/format.ts";
import { workspaceParam } from "@/lib/paths.ts";
import { useChecks } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Card, CardBody, CardHeader, Stat } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";

export function OverviewTab({ pr }: { pr: PrDetail }) {
  const checks = useChecks(pr.number);
  const additions = pr.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = pr.files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="文件" value={pr.files.length} />
        <Stat label="新增行" value={`+${additions}`} tone="ok" />
        <Stat label="删除行" value={`-${deletions}`} tone="danger" />
        <Stat label="工作区" value={pr.workspaces.length} />
      </div>

      <Card>
        <CardHeader title="元信息" />
        <CardBody className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Head SHA" value={<code className="font-mono">{pr.headSha.slice(0, 10)}</code>} />
          <Field label="Base SHA" value={<code className="font-mono">{pr.baseSha.slice(0, 10)}</code>} />
          <Field label="分支" value={<code className="font-mono">{pr.headRepo}:{pr.headRef}</code>} />
          <Field label="创建时间" value={formatDateTime(pr.createdAt)} />
          <Field label="更新时间" value={formatDateTime(pr.updatedAt)} />
          {pr.body.trim() !== "" && (
            <div className="sm:col-span-2 lg:col-span-3">
              <div className="mb-1 text-muted">描述</div>
              <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-elevated p-2 font-sans text-xs">
                {pr.body}
              </pre>
            </div>
          )}
        </CardBody>
      </Card>

      {pr.workspaces.length > 0 && (
        <Card>
          <CardHeader title="工作区" description="点击进入该工作区的翻译比较。" />
          <CardBody className="flex flex-wrap gap-2">
            {pr.workspaces.map((workspace) => (
              <Link
                key={`${workspace.slug}/${workspace.version}/${workspace.namespace}`}
                to="/pr/$n/$tab"
                params={{ n: String(pr.number), tab: "compare" }}
                search={{ ws: workspaceParam(workspace.slug, workspace.version, workspace.namespace) }}
                className="rounded border border-line bg-elevated px-2 py-1 font-mono text-xs hover:border-accent/50 hover:text-accent"
              >
                {workspace.slug} · {workspace.version} / {workspace.namespace} ({workspace.files.length})
              </Link>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="检查报告" description="来自 Bot 的信息评论检查段。" />
        <CardBody>
          {checks.error !== null ? (
            <ErrorState error={checks.error} onRetry={() => void checks.refetch()} />
          ) : checks.isPending ? (
            <SkeletonText lines={5} />
          ) : (
            <CheckReportView report={checks.data ?? null} />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="相关 PR" description="触碰相同模组的其它开放 PR。" />
        <CardBody>
          {pr.related.length === 0 ? (
            <EmptyState title="没有相关 PR" />
          ) : (
            <ul className="flex flex-col gap-2">
              {pr.related.map((related) => (
                <li key={related.number} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link to="/pr/$n" params={{ n: String(related.number) }} className="font-mono text-accent hover:underline">
                    #{related.number}
                  </Link>
                  <span className="min-w-0 flex-1 truncate">{related.title}</span>
                  <code className="font-mono text-xs text-muted">{related.slug}</code>
                  <span className="flex flex-wrap gap-1">
                    {related.versions.map((version) => (
                      <Badge key={version}>{version}</Badge>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  );
}
