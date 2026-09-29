import type { PrDetail } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { CheckReportView } from "@/components/CheckReport.tsx";
import { formatDateTime } from "@/lib/format.ts";
import { groupWorkspaces, workspaceParam } from "@/lib/paths.ts";
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
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="文件" value={pr.files.length} />
        <Stat label="新增行" value={`+${additions}`} tone="ok" />
        <Stat label="删除行" value={`-${deletions}`} tone="danger" />
        <Stat label="工作区" value={pr.workspaces.length} />
      </div>

      <Card>
        <CardHeader title="元信息" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Head SHA" value={<code className="font-mono">{pr.headSha.slice(0, 10)}</code>} />
            <Field label="Base SHA" value={<code className="font-mono">{pr.baseSha.slice(0, 10)}</code>} />
            <Field label="分支" title={`${pr.headRepo}:${pr.headRef}`} value={<code className="font-mono">{pr.headRepo}:{pr.headRef}</code>} />
            <Field label="创建时间" value={formatDateTime(pr.createdAt)} />
            <Field label="更新时间" value={formatDateTime(pr.updatedAt)} />
          </dl>
        </CardBody>
      </Card>

      {pr.workspaces.length > 0 && (
        <Card>
          <CardHeader title="工作区" description="按模组、命名空间分组，点版本号进入该工作区的翻译比较。" />
          <CardBody className="flex flex-col gap-4">
            {groupWorkspaces(pr.workspaces).map((mod) => (
              <section key={mod.slug} aria-label={mod.slug} className="flex flex-col gap-2">
                <h3 className="font-mono text-xs font-semibold">{mod.slug}</h3>
                <div className="grid grid-cols-[max-content_1fr] items-start gap-x-3 gap-y-2 border-l border-line pl-3">
                  {mod.namespaces.map((group) => (
                    <Fragment key={group.namespace}>
                      <span className="pt-1 font-mono text-xs text-muted">{group.namespace}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {group.workspaces.map((workspace) => (
                          <Link
                            key={workspace.version}
                            to="/pr/$n/$tab"
                            params={{ n: String(pr.number), tab: "compare" }}
                            search={{ ws: workspaceParam(workspace.slug, workspace.version, workspace.namespace) }}
                            title={workspace.files.join("\n")}
                            className="inline-flex h-6 items-center rounded-md border border-line bg-elevated px-2 font-mono text-xs hover:border-accent/50 hover:text-accent"
                          >
                            {workspace.version}
                          </Link>
                        ))}
                      </div>
                    </Fragment>
                  ))}
                </div>
              </section>
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
            <EmptyState compact title="没有相关 PR" />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {pr.related.map((related) => (
                <li key={related.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0">
                  <Link to="/pr/$n" params={{ n: String(related.number) }} className="font-mono text-accent hover:underline">
                    #{related.number}
                  </Link>
                  <span className="min-w-0 flex-1 truncate" title={related.title}>
                    {related.title}
                  </span>
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

function Field({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="whitespace-nowrap text-xs text-muted">{label}</dt>
      <dd className="truncate text-sm" title={title}>
        {value}
      </dd>
    </div>
  );
}
