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

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="GitHub 模式" value={data.github.mode} tone={data.github.mode === "anonymous" ? "warn" : "ok"} />
        <Stat label="PR 缓存" value={data.prCache.openCount} />
        <Stat label="模组数量" value={data.modList.count} />
        <Stat label="映射数量" value={data.mappings.count} />
      </div>

      <Card>
        <CardHeader title="集成状态" />
        <CardBody className="grid gap-2 sm:grid-cols-2">
          <Row label="Webhook 密钥" ok={data.webhook} />
          <Row label="CurseForge API" ok={data.curseforge} />
          <Row label="术语工具（GLOSSARY_BIN）" ok={data.glossary} />
          <Row label="Agent 主模型" ok={data.llm.agent !== undefined} text={data.llm.agent ?? "未配置"} />
          <Row label="审查模型集" ok={data.llm.reviewers.length >= 2} text={data.llm.reviewers.join("、") || "未配置"} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="GitHub 配额" description={data.github.rateLimit ? `重置于 ${formatDateTime(data.github.rateLimit.resetAt)}` : "未获取到配额信息"} />
        <CardBody className="text-sm">
          {data.github.rateLimit ? (
            <span className="tabular-nums">
              {data.github.rateLimit.remaining} / {data.github.rateLimit.limit}
            </span>
          ) : (
            <span className="text-muted">-</span>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="缓存时间" />
        <CardBody className="grid gap-2 text-xs sm:grid-cols-3">
          <div>
            <div className="text-muted">PR 索引刷新</div>
            <div>{formatRelative(data.prCache.refreshedAt)}</div>
          </div>
          <div>
            <div className="text-muted">模组列表更新</div>
            <div>{formatRelative(data.modList.updatedAt)}</div>
          </div>
          <div>
            <div className="text-muted">映射更新</div>
            <div>{formatRelative(data.mappings.updatedAt)}</div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, ok, text }: { label: string; ok: boolean; text?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <Badge tone={ok ? "ok" : "warn"}>{ok ? "可用" : "未配置"}</Badge>
      {text !== undefined && <code className="truncate font-mono text-xs text-muted">{text}</code>}
    </div>
  );
}
