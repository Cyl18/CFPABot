import type { CheckReport, ModFileCheck, ModFileStatus } from "@shared/api.ts";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { useMe, useRefreshPr, useRefreshStatus } from "@/lib/queries.ts";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, CardHeader } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const GRID = "grid modfiles-grid items-center gap-x-3";

const STATUS_META: Record<ModFileStatus, { tone: BadgeTone; label: string }> = {
  mismatch: { tone: "danger", label: "不一致" },
  extra: { tone: "neutral", label: "多出" },
  unavailable: { tone: "neutral", label: "无法获取" },
  ok: { tone: "ok", label: "一致" },
};

type Filter = ModFileStatus | "all";

const FILTER_ORDER: readonly Filter[] = ["mismatch", "extra", "unavailable", "ok", "all"];

function summaryOf(row: ModFileCheck): string {
  const parts: string[] = [];
  if (row.missing.length > 0) parts.push(`缺少 ${row.missing.length} 个 key`);
  if (row.changed.length > 0) parts.push(`值不同 ${row.changed.length} 个`);
  if (row.extra.length > 0) parts.push(`多出 ${row.extra.length} 个 key`);
  return parts.join(" · ");
}

function KeyList({ title, keys, danger }: { title: string; keys: readonly string[]; danger: boolean }) {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className={cn("text-xs font-medium", danger ? "text-danger" : "text-muted")}>
        {title} <span className="tabular-nums">{keys.length}</span>
      </p>
      <ul className="scroll-thin max-h-40 overflow-auto rounded-md border border-line bg-elevated/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
        {keys.map((key) => (
          <li key={key} className="break-all">
            {key}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModFileRow({ row }: { row: ModFileCheck }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[row.status];
  const expandable = row.missing.length + row.changed.length + row.extra.length > 0;
  const cells = (
    <>
      <ChevronRight aria-hidden="true" className={cn("size-3.5 text-muted transition-transform", !expandable && "invisible", expanded && "rotate-90")} />
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
    </>
  );
  const note = expandable ? summaryOf(row) : row.status === "unavailable" ? row.note : undefined;
  return (
    <li>
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={cn(GRID, "w-full px-3 py-2 text-left transition-colors hover:bg-elevated/40")}
        >
          {cells}
        </button>
      ) : (
        <div className={cn(GRID, "px-3 py-2")}>{cells}</div>
      )}
      {note !== undefined && note !== "" && (
        <p className={cn("-mt-1 pb-2 pl-9 pr-3 text-xs", row.status === "mismatch" ? "text-danger" : "text-muted")}>{note}</p>
      )}
      {expanded && (
        <div className="flex flex-col gap-2.5 pb-3 pl-9 pr-3">
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <KeyList title="比模组 jar 缺少" keys={row.missing} danger />
            <KeyList title="值不同" keys={row.changed} danger />
            <KeyList title="比模组 jar 多" keys={row.extra} danger={false} />
          </div>
          {row.status === "mismatch" && (
            <p className="text-xs text-muted">
              如确认需要同步：
              <code className="select-all rounded bg-elevated px-1 py-0.5 font-mono">{`/update-en ${row.slug} ${row.version}`}</code>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ModFilesCard({ n, report, pending = false }: { n: number; report: CheckReport | null; pending?: boolean }) {
  const { data: me } = useMe();
  const refresh = useRefreshPr(n);
  const status = useRefreshStatus(n, me?.isAdmin === true);
  const running = status.data?.running === true;
  const rows = report?.modFiles ?? [];
  const [filter, setFilter] = useState<Filter | null>(null);
  const counts = FILTER_ORDER.map((id) => ({ id, count: id === "all" ? rows.length : rows.filter((row) => row.status === id).length }));
  const preferred = filter ?? (rows.some((row) => row.status === "mismatch") ? "mismatch" : "all");
  const active = counts.find((option) => option.id === preferred && option.count > 0)?.id ?? "all";
  const shown = active === "all" ? rows : rows.filter((row) => row.status === active);

  return (
    <Card>
      <CardHeader
        title="模组文件"
        description="各工作区的 en_us 与已发布模组 jar 逐 key 对照；缺少 key 或值不同标红。"
        actions={
          me?.isAdmin === true ? (
            <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-3.5" />} loading={refresh.isPending || running} onClick={() => refresh.mutate()}>
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
        {running && (
          <p role="status" className="text-xs text-muted">
            正在重新检查，完成后自动刷新…
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
            <div role="group" aria-label="按状态筛选" className="flex flex-wrap items-center gap-1.5">
              {counts
                .filter((option) => option.count > 0 || option.id === "all")
                .map((option) => (
                  <ToggleChip key={option.id} pressed={option.id === active} onClick={() => setFilter(option.id)}>
                    {option.id === "all" ? "全部" : STATUS_META[option.id].label}
                    <span className="tabular-nums opacity-60">{option.count}</span>
                  </ToggleChip>
                ))}
            </div>
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className={cn(GRID, "border-b border-line bg-elevated/40 px-3 py-1.5 text-xs text-muted")}>
                <span />
                <span>状态</span>
                <span>模组</span>
                <span>命名空间</span>
                <span>版本</span>
                <span>jar 文件</span>
                <span>拉取时间</span>
              </div>
              <ul className="divide-y divide-line">
                {shown.map((row) => (
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
