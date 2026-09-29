import type { CompareRow, ModSourceResult, RowStatus, Workspace } from "@shared/api.ts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight, Layers, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { InlineTextDiff } from "@/components/InlineTextDiff.tsx";
import { cn } from "@/lib/cn.ts";
import { workspaceParam } from "@/lib/paths.ts";
import { useCompare, useModSource } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody, Stat } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Checkbox, Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";
import { parseWorkspaceKey } from "@/lib/api.ts";

type FilterMode = "changed" | "all" | "zh-only" | "untranslated";

const FILTERS: readonly { id: FilterMode; label: string }[] = [
  { id: "changed", label: "有变更" },
  { id: "all", label: "全部" },
  { id: "zh-only", label: "仅中文变更" },
  { id: "untranslated", label: "未翻译" },
];

const BORDER: Record<RowStatus, string> = {
  add: "border-l-ok",
  remove: "border-l-danger",
  modify: "border-l-warn",
  same: "border-l-transparent",
};

const STATUS_LABEL: Record<RowStatus, string> = { add: "新增", remove: "删除", modify: "修改", same: "未变" };

function isChanged(row: CompareRow): boolean {
  return row.enStatus !== "same" || row.zhStatus !== "same";
}

function isUntranslated(row: CompareRow): boolean {
  const en = row.headEn ?? row.baseEn ?? "";
  const zh = row.headZh ?? row.baseZh ?? "";
  return en.trim() !== "" && zh.trim() === "";
}

export interface CompareTabProps {
  n: number;
  workspaces: Workspace[];
  ws?: string;
}

export function CompareTab({ n, workspaces, ws }: CompareTabProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<FilterMode>("changed");
  const [query, setQuery] = useState("");
  const [overlay, setOverlay] = useState(false);

  const selected = useMemo(() => {
    const parsed = ws !== undefined ? parseWorkspaceKey(ws) : null;
    const match =
      parsed !== null
        ? workspaces.find((item) => item.slug === parsed.slug && item.version === parsed.version && item.namespace === parsed.namespace)
        : undefined;
    return match ?? workspaces[0] ?? null;
  }, [ws, workspaces]);

  const key = selected === null ? null : { slug: selected.slug, version: selected.version, namespace: selected.namespace };
  const compare = useCompare(n, key);
  const modSource = useModSource(n, key, overlay);

  const rows = useMemo(() => {
    const all = compare.data?.rows ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter((row) => {
      if (mode === "changed" && !isChanged(row)) return false;
      if (mode === "zh-only" && row.zhStatus === "same") return false;
      if (mode === "untranslated" && !isUntranslated(row)) return false;
      if (needle === "") return true;
      return (
        row.key.toLowerCase().includes(needle) ||
        (row.baseEn ?? "").toLowerCase().includes(needle) ||
        (row.headEn ?? "").toLowerCase().includes(needle) ||
        (row.baseZh ?? "").toLowerCase().includes(needle) ||
        (row.headZh ?? "").toLowerCase().includes(needle)
      );
    });
  }, [compare.data, mode, query]);

  const stats = useMemo(() => {
    const all = compare.data?.rows ?? [];
    const count = (status: RowStatus, side: "en" | "zh") =>
      all.filter((row) => (side === "en" ? row.enStatus : row.zhStatus) === status).length;
    return {
      total: all.length,
      enAdd: count("add", "en"),
      enRemove: count("remove", "en"),
      enModify: count("modify", "en"),
      zhAdd: count("add", "zh"),
      zhRemove: count("remove", "zh"),
      zhModify: count("modify", "zh"),
      untranslated: all.filter(isUntranslated).length,
    };
  }, [compare.data]);

  const modByKey = useMemo(() => {
    const map = new Map<string, ModSourceResult["rows"][number]>();
    for (const row of modSource.data?.rows ?? []) map.set(row.key, row);
    return map;
  }, [modSource.data]);

  const columns = useMemo(() => {
    const list: Column<CompareRow>[] = [
      {
        id: "key",
        header: "Key",
        width: 300,
        cell: (row) => (
          <code className="block max-w-[300px] truncate font-mono text-xs" title={row.key}>
            {row.key}
          </code>
        ),
      },
      {
        id: "en",
        header: "英文",
        cell: (row) => (
          <div className={cn("border-l-2 pl-2", BORDER[row.enStatus])}>
            <InlineTextDiff before={row.baseEn} after={row.headEn} />
          </div>
        ),
      },
      {
        id: "zh",
        header: "中文",
        cell: (row) => (
          <div className={cn("border-l-2 pl-2", BORDER[row.zhStatus])}>
            <InlineTextDiff before={row.baseZh} after={row.headZh} />
          </div>
        ),
      },
    ];
    if (overlay) {
      list.push({
        id: "mod",
        header: "模组 en_us",
        width: 320,
        cell: (row) => {
          const hit = modByKey.get(row.key);
          if (!hit) return <span className="text-muted">-</span>;
          return (
            <div className={cn("flex flex-col gap-1 border-l-2 pl-2", BORDER[hit.status])}>
              <Badge tone={hit.status === "same" ? "neutral" : "warn"}>{STATUS_LABEL[hit.status]}</Badge>
              <InlineTextDiff before={hit.mod} after={hit.pr} />
            </div>
          );
        },
      });
    }
    return list;
  }, [overlay, modByKey]);

  if (workspaces.length === 0) {
    return <EmptyState title="没有可比较的工作区" description="此 PR 没有检测到可比较的语言文件工作区。" />;
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">工作区</span>
            {workspaces.map((workspace) => (
              <button
                key={workspaceParam(workspace.slug, workspace.version, workspace.namespace)}
                type="button"
                aria-pressed={selected?.slug === workspace.slug && selected.version === workspace.version && selected.namespace === workspace.namespace}
                onClick={() =>
                  void navigate({
                    to: "/pr/$n/$tab",
                    params: { n: String(n), tab: "compare" },
                    search: { ws: workspaceParam(workspace.slug, workspace.version, workspace.namespace) },
                  })
                }
                className={cn(
                  "rounded border px-2 py-1 font-mono text-xs",
                  selected?.slug === workspace.slug && selected.version === workspace.version && selected.namespace === workspace.namespace
                    ? "border-accent/50 bg-accent/15 text-accent"
                    : "border-line bg-elevated text-muted hover:text-fg",
                )}
              >
                {workspace.slug} · {workspace.version}/{workspace.namespace}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="差异筛选" className="flex flex-wrap gap-1">
              {FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={mode === filter.id}
                  onClick={() => setMode(filter.id)}
                  className={
                    mode === filter.id
                      ? "rounded border border-accent/50 bg-accent/15 px-2 py-0.5 text-xs text-accent"
                      : "rounded border border-line bg-elevated px-2 py-0.5 text-xs text-muted hover:text-fg"
                  }
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="w-full sm:w-72">
              <Input
                aria-label="搜索 key 或文本"
                placeholder="搜索 key / 英文 / 中文"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                wrapperClassName="gap-0"
              />
            </div>
            <Checkbox label="叠加模组 en_us" checked={overlay} onChange={(event) => setOverlay(event.target.checked)} />
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Key 总数" value={stats.total} />
            <Stat label="EN 新增 / 删除 / 修改" value={`${stats.enAdd} / ${stats.enRemove} / ${stats.enModify}`} tone="info" />
            <Stat label="ZH 新增 / 删除 / 修改" value={`${stats.zhAdd} / ${stats.zhRemove} / ${stats.zhModify}`} tone="warn" />
            <Stat label="未翻译" value={stats.untranslated} tone="danger" />
          </div>

          {compare.data && compare.data.missing.length > 0 && (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
              缺失文件：{compare.data.missing.join("、")}
            </p>
          )}
          {overlay && modSource.data?.note !== undefined && <p className="text-xs text-muted">模组来源：{modSource.data.note}</p>}
          {overlay && modSource.data?.source !== null && modSource.data !== undefined && (
            <p className="text-xs text-muted">
              对比来源：{modSource.data.source?.provider} · {modSource.data.source?.fileName}
            </p>
          )}
        </CardBody>
      </Card>

      {compare.error !== null ? (
        <ErrorState error={compare.error} onRetry={() => void compare.refetch()} />
      ) : compare.isPending ? (
        <SkeletonTable rows={10} columns={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Search aria-hidden="true" className="size-5" />}
          title="没有匹配的行"
          description="当前筛选条件下没有差异行。"
          action={
            <Button size="sm" onClick={() => setMode("all")} icon={<Layers aria-hidden="true" className="size-3.5" />}>
              查看全部
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.key}
          ariaLabel="工作区翻译差异"
          virtualize
          height="65vh"
          rowHeight={40}
        />
      )}

      {overlay && modSource.error !== null && <ErrorState error={modSource.error} onRetry={() => void modSource.refetch()} />}

      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ArrowLeftRight aria-hidden="true" className="size-3.5" />
        行内差异在浏览器本地计算，仅针对当前可见行。
      </p>
    </div>
  );
}
