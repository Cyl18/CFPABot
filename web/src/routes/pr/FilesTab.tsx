import type { PrDetail, PrFile } from "@shared/api.ts";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { FileStatusBadge } from "@/ui/Badge.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { Input } from "@/ui/Input.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";
import { parseLangFile, workspaceParam } from "@/lib/paths.ts";

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "added", label: "新增" },
  { value: "modified", label: "修改" },
  { value: "removed", label: "删除" },
  { value: "renamed", label: "重命名" },
] as const;

export function FilesTab({ pr }: { pr: PrDetail }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pr.files.filter((file) => {
      if (status !== "all" && file.status !== status && !(status === "modified" && file.status === "changed")) return false;
      if (needle === "") return true;
      return file.path.toLowerCase().includes(needle);
    });
  }, [pr.files, query, status]);

  const columns: readonly Column<PrFile>[] = [
    {
      id: "path",
      header: "路径",
      cell: (file) => {
        const parsed = parseLangFile(file.path);
        if (parsed) {
          return (
            <Link
              to="/pr/$n/$tab"
              params={{ n: String(pr.number), tab: "compare" }}
              search={{ ws: workspaceParam(parsed.slug, parsed.version, parsed.namespace) }}
              className="block truncate font-mono text-xs text-accent hover:underline"
              title={file.path}
            >
              {file.path}
            </Link>
          );
        }
        return (
          <code className="block truncate font-mono text-xs" title={file.path}>
            {file.path}
          </code>
        );
      },
    },
    {
      id: "status",
      header: "状态",
      width: 90,
      cell: (file) => <FileStatusBadge status={file.status} />,
    },
    { id: "additions", header: "+", width: 64, align: "right", cell: (file) => <span className="text-ok">+{file.additions}</span> },
    { id: "deletions", header: "-", width: 64, align: "right", cell: (file) => <span className="text-danger">-{file.deletions}</span> },
    {
      id: "previous",
      header: "原路径",
      width: 320,
      hideBelow: "xl",
      cell: (file) =>
        file.previousPath !== undefined ? (
          <code className="block truncate font-mono text-xs text-muted" title={file.previousPath}>
            {file.previousPath}
          </code>
        ) : (
          <span className="text-muted">-</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          wrapperClassName="w-full sm:w-80"
          icon={<Search />}
          aria-label="搜索文件路径"
          placeholder="搜索文件路径"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div role="group" aria-label="文件状态筛选" className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((option) => (
            <ToggleChip key={option.value} pressed={status === option.value} onClick={() => setStatus(option.value)}>
              {option.label}
            </ToggleChip>
          ))}
        </div>
        <span className="text-xs text-muted sm:ml-auto">
          {rows.length} / {pr.files.length} 个文件
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="没有匹配的文件" description="试试调整搜索条件或状态筛选。" />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(file) => file.path} ariaLabel="变更文件列表" valign="middle" />
      )}
    </div>
  );
}
