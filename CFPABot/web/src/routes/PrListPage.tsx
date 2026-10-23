import type { PrState, PrSummary } from "@cfpa/contracts/api";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { PrStateBadge } from "@/components/StatusBadges.tsx";
import { cn } from "@/lib/cn.ts";
import { formatRelative } from "@/lib/format.ts";
import { qk, usePrs, usePublicEnv } from "@/lib/queries.ts";
import type { PrListSearch, SearchPatch } from "@/lib/search.ts";
import { TagList } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

type StateTab = PrState | "all";

const TABS: readonly TabItem<StateTab>[] = [
  { id: "open", label: "审核中" },
  { id: "merged", label: "已合并" },
  { id: "closed", label: "已关闭" },
  { id: "all", label: "全部" },
];

const LABEL_FILTER_LIMIT = 10;

export function PrListPage({ search, onSearchChange }: { search: PrListSearch; onSearchChange: (patch: SearchPatch) => void }) {
  const state: StateTab = TABS.some((item) => item.id === search.state) ? (search.state as StateTab) : "open";
  const query = search.q ?? "";
  const selectedLabels = useMemo(() => search.labels?.split(",").filter((item) => item !== "") ?? [], [search.labels]);
  const [allLabels, setAllLabels] = useState(false);
  const anonymous = usePublicEnv().data?.github === "anonymous";
  const [searchNotice, setSearchNotice] = useState(false);
  const client = useQueryClient();
  const { data, isPending, error, refetch, isFetching } = usePrs(state);

  useEffect(() => {
    if (!searchNotice) return;
    const timer = setTimeout(() => setSearchNotice(false), 4000);
    return () => clearTimeout(timer);
  }, [searchNotice]);

  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pr of data ?? []) {
      for (const label of pr.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data]);

  const visibleLabels = allLabels
    ? labels
    : labels.filter(([label], index) => index < LABEL_FILTER_LIMIT || selectedLabels.includes(label));
  const hiddenLabelCount = labels.length - visibleLabels.length;

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
      width: 76,
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
        <Link to="/pr/$n" params={{ n: String(row.number) }} className="line-clamp-2 font-medium text-fg/85 hover:underline" title={row.title}>
          {row.title}
        </Link>
      ),
    },
    { id: "author", header: "作者", width: 128, hideBelow: "xl", cell: (row) => <span className="block truncate text-muted">{row.author}</span> },
    { id: "state", header: "状态", width: 116, cell: (row) => <PrStateBadge state={row.state} draft={row.draft} /> },
    { id: "slugs", header: "模组", width: 200, hideBelow: "xl", cell: (row) => <TagList items={row.slugs} label={`#${row.number} 的模组`} /> },
    { id: "labels", header: "标签", width: 200, cell: (row) => <TagList items={row.labels} label={`#${row.number} 的标签`} /> },
    {
      id: "updated",
      header: "更新",
      width: 96,
      cell: (row) => (
        <span className="whitespace-nowrap text-muted" title={row.updatedAt}>
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
        <Tabs items={TABS} value={state} onChange={(next) => onSearchChange({ state: next === "open" ? undefined : next })} ariaLabel="PR 状态筛选" />
        {anonymous ? (
          <button
            type="button"
            onClick={() => setSearchNotice(true)}
            className="relative flex h-9 w-full items-center rounded-md border border-line bg-surface pr-2.5 pl-8 text-left text-sm text-muted/70 sm:ml-auto sm:w-80"
          >
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            匿名模式：搜索不可用
          </button>
        ) : (
          <Input
            wrapperClassName="w-full sm:ml-auto sm:w-80"
            icon={<Search />}
            aria-label="搜索 PR"
            placeholder="搜索标题 / 编号 / 作者 / 模组 slug"
            value={query}
            onChange={(event) => onSearchChange({ q: event.target.value === "" ? undefined : event.target.value })}
          />
        )}
      </div>

      {searchNotice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-warn/50 bg-surface px-3 py-2 text-xs text-fg shadow-lg"
        >
          搜索需要 GitHub 凭据：配置 GITHUB_PAT 或 DEV_GITHUB_TOKEN 后重启服务。
        </div>
      )}

      {labels.length > 0 && (
        <div role="group" aria-label="按标签筛选" className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted">标签</span>
          {visibleLabels.map(([label, count]) => (
            <ToggleChip
              key={label}
              pressed={selectedLabels.includes(label)}
              onClick={() => {
                const next = selectedLabels.includes(label) ? selectedLabels.filter((item) => item !== label) : [...selectedLabels, label];
                onSearchChange({ labels: next.length === 0 ? undefined : next.join(",") });
              }}
            >
              {label}
              <span className="tabular-nums opacity-60">{count}</span>
            </ToggleChip>
          ))}
          {(hiddenLabelCount > 0 || allLabels) && (
            <Button size="sm" variant="ghost" aria-expanded={allLabels} onClick={() => setAllLabels((value) => !value)}>
              {allLabels ? "收起" : `+${hiddenLabelCount} 个标签`}
            </Button>
          )}
          {selectedLabels.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onSearchChange({ labels: undefined })}>
              清除筛选
            </Button>
          )}
        </div>
      )}

      {error !== null ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <SkeletonTable rows={8} columns={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<GitPullRequest aria-hidden="true" className="size-6" />}
          title={data && data.length > 0 ? "没有匹配的 PR" : "暂无 PR"}
          description={data && data.length > 0 ? "试试调整搜索条件或标签筛选。" : "当前状态下没有 PR 数据。"}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => String(row.number)} ariaLabel="PR 列表" valign="middle" rowHeight={45} />
      )}
    </>
  );
}
