import type { PrState, PrSummary } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { PrStateBadge } from "@/components/StatusBadges.tsx";
import { cn } from "@/lib/cn.ts";
import { formatRelative } from "@/lib/format.ts";
import { qk, usePrs } from "@/lib/queries.ts";
import { Badge, LabelChip } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

type StateTab = PrState | "all";

const TABS: readonly TabItem<StateTab>[] = [
  { id: "open", label: "审核中" },
  { id: "merged", label: "已合并" },
  { id: "closed", label: "已关闭" },
  { id: "all", label: "全部" },
];

export function PrListPage() {
  const [state, setState] = useState<StateTab>("open");
  const [query, setQuery] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<readonly string[]>([]);
  const client = useQueryClient();
  const { data, isPending, error, refetch, isFetching } = usePrs(state);

  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pr of data ?? []) {
      for (const label of pr.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data ?? []).filter((pr) => {
      if (selectedLabels.length > 0 && !selectedLabels.every((label) => pr.labels.includes(label))) return false;
      if (needle === "") return true;
      return (
        pr.title.toLowerCase().includes(needle) ||
        String(pr.number).includes(needle) ||
        pr.author.toLowerCase().includes(needle) ||
        pr.slugs.some((slug) => slug.toLowerCase().includes(needle))
      );
    });
  }, [data, query, selectedLabels]);

  const columns: readonly Column<PrSummary>[] = [
    {
      id: "number",
      header: "#",
      width: 90,
      cell: (row) => (
        <Link to="/pr/$n" params={{ n: String(row.number) }} className="font-mono text-accent hover:underline">
          #{row.number}
        </Link>
      ),
    },
    {
      id: "title",
      header: "标题",
      cell: (row) => (
        <Link to="/pr/$n" params={{ n: String(row.number) }} className="line-clamp-2 hover:underline">
          {row.title}
        </Link>
      ),
    },
    { id: "author", header: "作者", width: 140, cell: (row) => <span className="text-muted">{row.author}</span> },
    {
      id: "state",
      header: "状态",
      width: 110,
      cell: (row) => <PrStateBadge state={row.state} draft={row.draft} />,
    },
    {
      id: "slugs",
      header: "模组",
      width: 240,
      cell: (row) =>
        row.slugs.length === 0 ? (
          <span className="text-muted">-</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.slugs.slice(0, 3).map((slug) => (
              <LabelChip key={slug} label={slug} />
            ))}
            {row.slugs.length > 3 && <Badge>+{row.slugs.length - 3}</Badge>}
          </span>
        ),
    },
    {
      id: "labels",
      header: "标签",
      width: 220,
      cell: (row) =>
        row.labels.length === 0 ? (
          <span className="text-muted">-</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.labels.map((label) => (
              <LabelChip key={label} label={label} />
            ))}
          </span>
        ),
    },
    {
      id: "updated",
      header: "更新",
      width: 110,
      cell: (row) => (
        <span className="text-muted" title={row.updatedAt}>
          {formatRelative(row.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="PR 列表"
        description={`共 ${data?.length ?? 0} 个 PR${rows.length !== (data?.length ?? 0) ? `，筛选后 ${rows.length} 个` : ""}`}
        actions={
          <Button
            icon={<RefreshCw aria-hidden="true" className={cn("size-3.5", isFetching && "animate-spin")} />}
            onClick={() => {
              void client.invalidateQueries({ queryKey: qk.prs(state) });
            }}
          >
            刷新
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs items={TABS} value={state} onChange={setState} ariaLabel="PR 状态筛选" />
        <div className="w-full sm:w-72">
          <Input
            aria-label="搜索 PR"
            placeholder="搜索标题 / 编号 / 作者 / 模组 slug"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Search aria-hidden="true" className="hidden size-4 text-muted sm:block" />
      </div>

      {labels.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">标签：</span>
          {labels.slice(0, 14).map(([label, count]) => {
            const active = selectedLabels.includes(label);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setSelectedLabels((previous) => (previous.includes(label) ? previous.filter((item) => item !== label) : [...previous, label]))
                }
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                  active ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-elevated text-muted hover:text-fg",
                )}
              >
                {label} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
          {selectedLabels.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelectedLabels([])}>
              清除
            </Button>
          )}
        </div>
      )}

      {error !== null ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <SkeletonTable rows={8} columns={6} />
      ) : rows.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={<GitPullRequest aria-hidden="true" className="size-6" />}
              title={data && data.length > 0 ? "没有匹配的 PR" : "暂无 PR"}
              description={data && data.length > 0 ? "试试调整搜索条件或标签筛选。" : "当前状态下没有 PR 数据。"}
            />
          </CardBody>
        </Card>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => String(row.number)} ariaLabel="PR 列表" />
      )}
    </>
  );
}
