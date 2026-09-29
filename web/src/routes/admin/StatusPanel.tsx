import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { useStatus } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Card, CardBody, CardHeader, Stat } from "@/ui/Card.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";

export function StatusPanel() {
  const status = useStatus();

  if (status.error !== null) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  if (status.isPending || !status.data) return <SkeletonText lines={6} />;

  const data = status.data;
  const rate = data.github.rateLimit;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="GitHub 模式" value={data.github.mode} tone={data.github.mode === "anonymous" ? "warn" : "ok"} />
        <Stat label="PR 缓存" value={data.prCache.openCount} />
        <Stat label="模组数量" value={data.modList.count} />
        <Stat label="映射数量" value={data.mappings.count} />
      </div>

      <Card>
        <CardHeader title="集成状态" />
        <CardBody className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <Row label="Webhook 密钥" ok={data.webhook} />
          <Row label="CurseForge API" ok={data.curseforge} />
          <Row label="术语工具（GLOSSARY_BIN）" ok={data.glossary} />
          <Row label="Agent 主模型" ok={data.llm.agent !== undefined} text={data.llm.agent ?? "未配置"} />
          <Row label="审查模型集" ok={data.llm.reviewers.length >= 2} text={data.llm.reviewers.join("、") || "未配置"} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="GitHub 配额" description={rate ? `重置于 ${formatDateTime(rate.resetAt)}` : "未获取到配额信息"} />
        <CardBody>
          {rate ? (
            <>
              <div className="text-lg font-semibold tabular-nums">
                {rate.remaining} / {rate.limit}
              </div>
              <div
                role="meter"
                aria-valuemin={0}
                aria-valuemax={rate.limit}
                aria-valuenow={rate.remaining}
                aria-label="GitHub 剩余配额"
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${rate.limit > 0 ? (rate.remaining / rate.limit) * 100 : 0}%` }}
                />
              </div>
            </>
          ) : (
            <span className="text-sm text-muted">-</span>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="缓存时间" />
        <CardBody>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">PR 索引刷新</dt>
              <dd className="mt-0.5 text-sm">{formatRelative(data.prCache.refreshedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">模组列表更新</dt>
              <dd className="mt-0.5 text-sm">{formatRelative(data.modList.updatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">映射更新</dt>
              <dd className="mt-0.5 text-sm">{formatRelative(data.mappings.updatedAt)}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, ok, text }: { label: string; ok: boolean; text?: string }) {
  const badge = ok ? "可用" : "未配置";
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1.5 text-sm">
      <span className="truncate text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        {text !== undefined && text !== badge && (
          <code title={text} className="truncate font-mono text-xs text-muted">
            {text}
          </code>
        )}
        <Badge tone={ok ? "ok" : "warn"}>{badge}</Badge>
      </span>
    </div>
  );
}
