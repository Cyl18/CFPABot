import type { CrossVersionCell, CrossVersionRow } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { cn } from "@/lib/cn.ts";
import { useVersions } from "@/lib/queries.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Card, CardBody, Stat } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

type FilterId = "en" | "zh" | "strong";

const FILTERS: readonly { id: FilterId; label: string }[] = [
  { id: "en", label: "EN 不一致" },
  { id: "zh", label: "ZH 不一致" },
  { id: "strong", label: "EN 同 ZH 异" },
];

function isStrongSignal(row: CrossVersionRow): boolean {
  return row.enConsistent && !row.zhConsistent;
}

function VersionCell({ cell }: { cell: CrossVersionCell | undefined }) {
  if (!cell) return <span className="text-xs text-muted">—</span>;
  const en = cell.en ?? "";
  const zh = cell.zh ?? "";
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className={cn("truncate", en === "" && "text-muted")} title={en}>
        {en === "" ? "(空)" : en}
      </span>
      <span className={cn("truncate border-t border-line pt-0.5 text-muted", zh === "" && "italic")} title={zh}>
        {zh === "" ? "(空)" : zh}
      </span>
    </div>
  );
}

export function VersionsPage({ slug, namespace, pr }: { slug: string; namespace?: string; pr?: number }) {
  const effectiveNamespace = namespace ?? slug;
  const versions = useVersions(slug, effectiveNamespace, pr);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<readonly FilterId[]>([]);

  const data = versions.data;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.rows ?? []).filter((row) => {
      if (filters.includes("en") && row.enConsistent) return false;
      if (filters.includes("zh") && row.zhConsistent) return false;
      if (filters.includes("strong") && !isStrongSignal(row)) return false;
      if (needle === "") return true;
      return row.key.toLowerCase().includes(needle);
    });
  }, [data, filters, query]);

  const summary = useMemo(() => {
    const all = data?.rows ?? [];
    return {
      total: all.length,
      enConsistent: all.filter((row) => row.enConsistent).length,
      zhConsistent: all.filter((row) => row.zhConsistent).length,
      strong: all.filter(isStrongSignal).length,
    };
  }, [data]);

  const columns = useMemo(() => {
    const list: Column<CrossVersionRow>[] = [
      { id: "index", header: "#", width: 56, cell: (_row, index) => <span className="text-xs text-muted">{index + 1}</span> },
      {
        id: "key",
        header: "Key",
        width: 300,
        className: "sticky left-0 z-10 bg-surface",
        headerClassName: "sticky left-0 z-20",
        cell: (row) => (
          <code className="block max-w-[300px] truncate font-mono text-xs" title={row.key}>
            {row.key}
          </code>
        ),
      },
    ];
    for (const version of data?.versions ?? []) {
      list.push({
        id: version,
        header: (
          <span className="flex flex-col">
            <span className="font-mono">{version}</span>
            <span className="text-[10px] font-normal text-muted">EN / ZH</span>
          </span>
        ),
        width: 200,
        cell: (row) => <VersionCell cell={row.cells[version]} />,
      });
    }
    list.push({
      id: "status",
      header: "状态",
      width: 100,
      cell: (row) =>
        row.enConsistent && row.zhConsistent ? <Badge tone="ok">一致</Badge> : <Badge tone="danger">不一致</Badge>,
    });
    return list;
  }, [data?.versions]);

  return (
    <>
      <PageHeader
        back={{ to: "/mods", label: "返回模组列表" }}
        title={`跨版本一致性 · ${slug}`}
        description={
          data
            ? `${effectiveNamespace} · ${data.versions.length} 个版本 · ${data.rows.length} 个 key${pr !== undefined ? ` · 已按 PR #${pr} 过滤` : ""}`
            : undefined
        }
      />

      {versions.error !== null ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : versions.isPending ? (
        <SkeletonTable rows={8} columns={5} />
      ) : !data || data.versions.length === 0 ? (
        <EmptyState title="没有版本数据" description="该 slug 在 main 分支下未找到任何版本的语言文件。" />
      ) : (
        <div className="flex flex-col gap-3">
          {summary.strong > 0 && (
            <p className="flex items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <TriangleAlert aria-hidden="true" className="size-4" />
              {summary.strong} 个 key 英文一致但中文不一致（强信号）
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Key 总数" value={summary.total} />
            <Stat label="EN 一致" value={summary.enConsistent} tone="ok" />
            <Stat label="ZH 一致" value={summary.zhConsistent} tone="ok" />
            <Stat label="EN 同 ZH 异" value={summary.strong} tone="warn" />
          </div>

          <Card>
            <CardBody className="flex flex-wrap items-center gap-2">
              <div className="w-full sm:w-72">
                <Input aria-label="搜索 key" placeholder="搜索 key" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <div role="group" aria-label="一致性筛选" className="flex flex-wrap gap-1">
                {FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={filters.includes(filter.id)}
                    onClick={() =>
                      setFilters((previous) => (previous.includes(filter.id) ? previous.filter((item) => item !== filter.id) : [...previous, filter.id]))
                    }
                    className={cn(
                      "rounded border px-2 py-0.5 text-xs",
                      filters.includes(filter.id) ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-elevated text-muted hover:text-fg",
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted">
                {rows.length} / {data.rows.length} 行
              </span>
            </CardBody>
          </Card>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.key}
            ariaLabel="跨版本一致性矩阵"
            empty="没有匹配的行"
            rowClassName={(row) => (isStrongSignal(row) ? "bg-warn/10" : undefined)}
            height="65vh"
          />
        </div>
      )}

      <p className="mt-3 text-xs text-muted">
        数据来自 main 分支（{data?.versions.length ?? 0} 个版本）{pr !== undefined ? "，并叠加了该 PR 的改动" : ""}。
        <Link to="/mods" className="ml-1 text-accent hover:underline">
          查看全部模组
        </Link>
      </p>
    </>
  );
}
