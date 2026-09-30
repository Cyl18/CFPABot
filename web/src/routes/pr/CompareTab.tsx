import type { CompareRow, PrDetail, Workspace } from "@shared/api.ts";
import type { DiffCell, DiffEntry, DiffLane } from "@shared/diffview.ts";
import { formatDiffFilter, parseDiffFilter } from "@shared/diffview.ts";
import { type ReactNode, useMemo } from "react";
import { DiffViewer } from "@/components/DiffViewer.tsx";
import { parseWorkspaceKey } from "@/lib/api.ts";
import { groupWorkspaces, pickCompareFiles, workspaceParam } from "@/lib/paths.ts";
import { useCompare } from "@/lib/queries.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

function cellOf(en: string | undefined, zh: string | undefined): DiffCell | null {
  return en === undefined && zh === undefined ? null : { en: en ?? "", zh: zh ?? null };
}

export interface CompareTabProps {
  n: number;
  files: PrDetail["files"];
  workspaces: Workspace[];
  search: PrSearch;
  onSearchChange: (patch: SearchPatch) => void;
}

export function CompareTab({ n, files, workspaces, search, onSearchChange }: CompareTabProps) {
  const ws = search.ws;
  const filter = parseDiffFilter(search.filter);
  const query = search.q ?? "";

  const selected = useMemo(() => {
    const parsed = ws !== undefined ? parseWorkspaceKey(ws) : null;
    const match =
      parsed !== null
        ? workspaces.find((item) => item.slug === parsed.slug && item.version === parsed.version && item.namespace === parsed.namespace)
        : undefined;
    return match ?? workspaces[0] ?? null;
  }, [ws, workspaces]);

  const groups = useMemo(() => groupWorkspaces(workspaces), [workspaces]);
  const mod = groups.find((item) => item.slug === selected?.slug);
  const group = mod?.namespaces.find((item) => item.namespace === selected?.namespace);

  const open = (candidates: readonly Workspace[]) => {
    const target = candidates.find((item) => item.version === selected?.version) ?? candidates[0];
    if (target === undefined) return;
    onSearchChange({ ws: workspaceParam(target.slug, target.version, target.namespace) });
  };

  const key = selected === null ? null : { slug: selected.slug, version: selected.version, namespace: selected.namespace };
  const compare = useCompare(n, key);

  const sources = useMemo(() => {
    if (selected === null) return [];
    const picked = pickCompareFiles(files, selected);
    return [picked.en_us, picked.zh_cn].filter((path): path is string => path !== undefined);
  }, [files, selected]);

  const rows: readonly CompareRow[] = compare.data?.rows ?? [];

  const lanes: DiffLane[] = useMemo(() => {
    const hasZh = (side: "base" | "head") => rows.some((row) => (side === "base" ? row.baseZh : row.headZh) !== undefined);
    const base = rows.some((row) => row.baseEn !== undefined || row.baseZh !== undefined);
    const head = rows.some((row) => row.headEn !== undefined || row.headZh !== undefined);
    const whole = base === head ? null : head ? ("insert" as const) : ("delete" as const);
    return [
      {
        id: "base",
        label: "main",
        role: "ref",
        zhFile: hasZh("base"),
        title: "main 分支的这份文件",
        absent: !base,
        ...(whole === "delete" ? { whole } : {}),
      },
      {
        id: "head",
        label: "PR",
        role: "real",
        highlight: true,
        zhFile: hasZh("head"),
        title: `PR #${n} 里的这份文件`,
        absent: !head,
        ...(whole === "insert" ? { whole } : {}),
      },
    ];
  }, [rows, n]);

  const entries: DiffEntry[] = useMemo(
    () =>
      rows.map((row) => ({
        key: row.key,
        cells: {
          base: cellOf(row.baseEn, row.baseZh),
          head: cellOf(row.headEn, row.headZh),
        },
      })),
    [rows],
  );

  if (workspaces.length === 0) {
    return <EmptyState title="没有可比较的工作区" description="此 PR 没有检测到可比较的语言文件工作区。" />;
  }

  const leading = (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[max-content_1fr] items-start gap-x-3 gap-y-2">
        {groups.length > 1 && (
          <SelectorRow label="模组">
            {groups.map((item) => (
              <ToggleChip key={item.slug} mono pressed={item === mod} onClick={() => open(item.namespaces.flatMap((entry) => entry.workspaces))}>
                {item.slug}
              </ToggleChip>
            ))}
          </SelectorRow>
        )}
        {mod !== undefined && mod.namespaces.length > 1 && (
          <SelectorRow label="命名空间">
            {mod.namespaces.map((item) => (
              <ToggleChip key={item.namespace} mono pressed={item === group} onClick={() => open(item.workspaces)}>
                {item.namespace}
              </ToggleChip>
            ))}
          </SelectorRow>
        )}
        {group !== undefined && (
          <SelectorRow label="版本">
            {group.workspaces.map((item) => (
              <ToggleChip key={item.version} mono pressed={item === selected} onClick={() => open([item])}>
                {item.version}
              </ToggleChip>
            ))}
          </SelectorRow>
        )}
        {sources.length > 0 && (
          <SelectorRow label="比较文件" title={sources.join("\n")}>
            <span className="pt-0.5 font-mono text-xs text-muted">{sources.map((path) => path.slice(path.lastIndexOf("/") + 1)).join(" · ")}</span>
          </SelectorRow>
        )}
      </div>
      {compare.data !== undefined && compare.data.missing.length > 0 && (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">缺失文件：{compare.data.missing.join("、")}</p>
      )}
    </div>
  );

  return (
    <DiffViewer
      mode="compare"
      lanes={lanes}
      active={["base", "head"]}
      entries={entries}
      filter={filter}
      onFilterChange={(next) => onSearchChange({ filter: formatDiffFilter(next) })}
      query={query}
      onQueryChange={(next) => onSearchChange({ q: next === "" ? undefined : next })}
      defaultLayout="merge"
      leading={leading}
      pending={compare.isPending}
      error={compare.error}
      onRetry={() => void compare.refetch()}
    />
  );
}

function SelectorRow({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <>
      <span className="pt-1.5 text-xs text-muted">{label}</span>
      <div role="group" aria-label={label} title={title} className="flex flex-wrap gap-1.5">
        {children}
      </div>
    </>
  );
}
