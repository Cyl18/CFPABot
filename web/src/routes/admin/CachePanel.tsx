import { RefreshCw } from "lucide-react";
import { errorMessage } from "@/lib/api.ts";
import { useRefreshCache, useStatus } from "@/lib/queries.ts";
import { formatRelative } from "@/lib/format.ts";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";

const TARGETS = [
  { id: "prs", label: "PR 缓存", description: "重新拉取开放 PR 列表并刷新文件缓存。" },
  { id: "mirror", label: "镜像仓库", description: "同步 main 分支镜像，用于跨版本与模组列表。" },
  { id: "mappings", label: "映射扫描", description: "扫描 CurseForge 补全 slug 映射（需要 API Key）。" },
] as const;

export function CachePanel() {
  const refresh = useRefreshCache();
  const status = useStatus();

  return (
    <div className="flex flex-col gap-3">
      {TARGETS.map((target) => (
        <Card key={target.id}>
          <CardHeader
            title={target.label}
            description={target.description}
            actions={
              <Button
                icon={<RefreshCw aria-hidden="true" className="size-3.5" />}
                loading={refresh.isPending && refresh.variables === target.id}
                onClick={() => refresh.mutate(target.id)}
              >
                刷新
              </Button>
            }
          />
          <CardBody className="text-xs text-muted">
            {target.id === "prs" && `开放 PR：${status.data?.prCache.openCount ?? "-"} · 上次刷新 ${formatRelative(status.data?.prCache.refreshedAt)}`}
            {target.id === "mirror" && `模组索引：${status.data?.modList.count ?? "-"} 个 · 更新于 ${formatRelative(status.data?.modList.updatedAt)}`}
            {target.id === "mappings" && `映射：${status.data?.mappings.count ?? "-"} 条 · 更新于 ${formatRelative(status.data?.mappings.updatedAt)}`}
          </CardBody>
        </Card>
      ))}
      {refresh.isError && <p className="text-xs text-danger">刷新失败：{errorMessage(refresh.error)}</p>}
      {refresh.isSuccess && <p className="text-xs text-ok">已触发刷新</p>}
    </div>
  );
}
