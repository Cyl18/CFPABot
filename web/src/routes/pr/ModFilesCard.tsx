import type { CheckReport, ModFileCheck } from "@shared/api.ts";
import { RefreshCw } from "lucide-react";
import { errorMessage } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { useMe, useRefreshPr } from "@/lib/queries.ts";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";

const GRID = "grid modfiles-grid items-center gap-x-3";

const STATUS_META: Record<ModFileCheck["status"], { tone: BadgeTone; label: string }> = {
  ok: { tone: "ok", label: "一致" },
  mismatch: { tone: "danger", label: "不一致" },
  extra: { tone: "neutral", label: "多出" },
  unavailable: { tone: "neutral", label: "无法获取" },
};

interface KeyGroup {
  label: string;
  tone: "danger" | "muted";
  keys: string[];
}

function groupsOf(row: ModFileCheck): KeyGroup[] {
  const groups: KeyGroup[] = [];
  if (row.missing.length > 0) groups.push({ label: `比模组 jar 缺少（${row.missing.length}）`, tone: "danger", keys: row.missing });
  if (row.changed.length > 0) groups.push({ label: `值不同（${row.changed.length}）`, tone: "danger", keys: row.changed });
  if (row.extra.length > 0) groups.push({ label: `比模组 jar 多（${row.extra.length}）`, tone: "muted", keys: row.extra });
  return groups;
}

function summaryOf(row: ModFileCheck): string {
  if (row.status === "extra") return `比模组 jar 多 ${row.extra.length} 个 key`;
  const parts: string[] = [];
  if (row.missing.length > 0) parts.push(`比模组 jar 缺少 ${row.missing.length} 个 key`);
  if (row.changed.length > 0) parts.push(`值不同 ${row.changed.length} 个`);
  return parts.join(" · ");
}

function ModFileRow({ row }: { row: ModFileCheck }) {
  const meta = STATUS_META[row.status];
  const detailed = row.status === "mismatch" || row.status === "extra";
  return (
    <li className="border-b border-line last:border-b-0">
      <div className={cn(GRID, "px-3 py-2")}>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <code className="truncate font-mono text-xs" title={row.slug}>
          {row.slug}
        </code>
        <code className="truncate font-mono text-xs text-muted" title={row.namespace}>
          {row.namespace}
        </code>
        <span className="whitespace-nowrap font-mono text-xs text-muted">{row.version}</span>
        <span className="truncate font-mono text-xs text-muted" title={row.fileName}>
          {row.fileName ?? "—"}
        </span>
        <span className="whitespace-nowrap text-xs text-muted" title={row.fetchedAt === undefined ? undefined : formatDateTime(row.fetchedAt)}>
          {row.fetchedAt === undefined ? "—" : formatRelative(row.fetchedAt)}
        </span>
      </div>
      {detailed && (
        <div className="flex flex-col gap-1 px-3 pb-2.5">
          <p className={cn("text-xs", row.status === "mismatch" ? "text-danger" : "text-muted")}>{summaryOf(row)}</p>
          <details>
            <summary className="w-fit cursor-pointer select-none text-xs text-muted hover:text-fg">详细报告</summary>
            <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-auto rounded-md border border-line bg-elevated/40 p-2 font-mono text-[11px] leading-relaxed">
              {groupsOf(row).map((group) => (
                <li key={group.label} className="flex gap-1.5">
                  <span className={cn("shrink-0", group.tone === "danger" ? "text-danger" : "text-muted")}>{group.label}：</span>
                  <span className="min-w-0 break-all text-muted">{group.keys.join("、")}</span>
                </li>
              ))}
            </ul>
          </details>
          {row.status === "mismatch" && (
            <p className="text-xs text-muted">
              如确认需要同步：
              <code className="rounded bg-elevated px-1 py-0.5 font-mono">{`/update-en ${row.slug} ${row.version}`}</code>
            </p>
          )}
        </div>
      )}
      {row.status === "unavailable" && row.note !== undefined && <p className="px-3 pb-2.5 text-xs text-muted">{row.note}</p>}
    </li>
  );
}

export function ModFilesCard({ n, report, pending = false }: { n: number; report: CheckReport | null; pending?: boolean }) {
  const { data: me } = useMe();
  const refresh = useRefreshPr(n);
  const rows = report?.modFiles ?? [];
  return (
    <Card>
      <CardHeader
        title="模组文件"
        description="各工作区的 en_us 与已发布模组 jar 逐 key 对照；缺少 key 或值不同标红。"
        actions={
          me?.isAdmin === true ? (
            <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-3.5" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
              重新拉取
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3">
        {refresh.isError && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            刷新失败：{errorMessage(refresh.error)}
          </p>
        )}
        {pending ? (
          <SkeletonText lines={3} />
        ) : report === null ? (
          <EmptyState compact title="还没有检查结果" description="等下一次检查生成，或由协作者点「重新拉取」。" />
        ) : rows.length === 0 ? (
          <EmptyState compact title="没有模组文件数据" description="这份检查结果里没有模组文件对照，点「重新拉取」重新检查。" />
        ) : (
          <>
            <p className="text-xs text-muted">
              数据来自最近一次检查 · 检查提交 <code className="font-mono">{report.headSha.slice(0, 7)}</code> · {formatDateTime(report.generatedAt)} ·{" "}
              {formatRelative(report.generatedAt)}
            </p>
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className={cn(GRID, "border-b border-line bg-elevated/40 px-3 py-1.5 text-xs text-muted")}>
                <span>状态</span>
                <span>模组</span>
                <span>命名空间</span>
                <span>版本</span>
                <span>jar 文件</span>
                <span>拉取时间</span>
              </div>
              <ul>
                {rows.map((row) => (
                  <ModFileRow key={`${row.slug}-${row.version}-${row.namespace}`} row={row} />
                ))}
              </ul>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
