import type { ModEntry } from "@cfpa/contracts/api";
import { Link } from "@tanstack/react-router";
import { PackageSearch, Search } from "lucide-react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { formatRelative } from "@/lib/format.ts";
import { useMods } from "@/lib/queries.ts";
import type { SearchPatch } from "@/lib/search.ts";
import { Badge } from "@/ui/Badge.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";

export function ModsPage({ query, onSearchChange }: { query: string; onSearchChange: (patch: SearchPatch) => void }) {
  const { data, isPending, error, refetch } = useMods(query);

  const columns: readonly Column<ModEntry>[] = [
    {
      id: "slug",
      header: "Slug",
      width: 260,
      cell: (row) => (
        <Link to="/versions/$slug" params={{ slug: row.slug }} className="block truncate font-mono text-accent hover:underline" title={row.slug}>
          {row.slug}
        </Link>
      ),
    },
    {
      id: "name",
      header: "名称",
      width: 220,
      hideBelow: "lg",
      cell: (row) =>
        row.name === undefined ? <span className="text-muted">-</span> : <span className="block truncate">{row.name}</span>,
    },
    {
      id: "cf",
      header: "CurseForge",
      width: 110,
      cell: (row) => (row.curseforgeId === undefined ? <Badge>未映射</Badge> : <span className="font-mono text-xs text-muted">{row.curseforgeId}</span>),
    },
    {
      id: "versions",
      header: "版本",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.versions.map((version) => (
            <Link
              key={version.version}
              to="/versions/$slug"
              params={{ slug: row.slug }}
              search={{ namespace: version.namespaces[0] }}
              className="inline-flex h-5 items-center whitespace-nowrap rounded border border-line bg-elevated px-1.5 font-mono text-xs text-muted hover:border-accent/50 hover:text-fg"
              title={version.namespaces.join(", ")}
            >
              {version.version}
            </Link>
          ))}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="模组列表"
        description={data ? `共 ${data.mods.length} 个模组 · 索引更新于 ${formatRelative(data.updatedAt)}${data.headSha ? ` · 索引提交 ${data.headSha.slice(0, 7)}` : ""}` : undefined}
        actions={
          <Input
            aria-label="搜索模组"
            placeholder="搜索 slug / 名称"
            icon={<Search />}
            wrapperClassName="w-full sm:w-72"
            value={query}
            onChange={(event) => onSearchChange({ q: event.target.value === "" ? undefined : event.target.value })}
          />
        }
      />

      <p className="mb-3 text-xs text-muted">
        列表来自 main 分支的语言文件索引（
        <code className="font-mono">projects/assets/&#123;slug&#125;/&#123;version&#125;/&#123;namespace&#125;</code>
        ），点击 slug 查看同一句英文在各版本间的译法冲突。
      </p>

      {error !== null ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <SkeletonTable rows={10} columns={4} />
      ) : data && data.mods.length === 0 ? (
        <EmptyState
          icon={<PackageSearch aria-hidden="true" className="size-6" />}
          title="没有匹配的模组"
          description={query.trim() === "" ? "模组索引尚未生成。" : "试试其它关键词。"}
        />
      ) : (
        <DataTable columns={columns} rows={data?.mods ?? []} rowKey={(row) => row.slug} ariaLabel="模组列表" valign="middle" />
      )}
    </>
  );
}
