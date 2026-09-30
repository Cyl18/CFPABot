import type { CompareRow, Workspace } from "@shared/api.ts";
import type { DiffCell, DiffEntry, DiffLane } from "@shared/diffview.ts";
import { isDiffFilter, type DiffFilter } from "@shared/diffview.ts";
import { type ReactNode, useMemo } from "react";
import { DiffViewer } from "@/components/DiffViewer.tsx";
import { parseWorkspaceKey } from "@/lib/api.ts";
import { groupWorkspaces, workspaceParam } from "@/lib/paths.ts";
import { useCompare, useModSource } from "@/lib/queries.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Checkbox } from "@/ui/Input.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

function cellOf(en: string | undefined, zh: string | undefined): DiffCell | null {
  return en === undefined && zh === undefined ? null : { en: en ?? "", zh: zh ?? null };
}

export interface CompareTabProps {
  n: number;
  workspaces: Workspace[];
  search: PrSearch;
  onSearchChange: (patch: SearchPatch) => void;
}

export function CompareTab({ n, workspaces, search, onSearchChange }: CompareTabProps) {
  const ws = search.ws;
  const filter: DiffFilter = isDiffFilter(search.filter) ? search.filter : "diff";
  const query = search.q ?? "";
  const overlay = search.overlay === "1";

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
  const modSource = useModSource(n, key, overlay);

  const rows: readonly CompareRow[] = compare.data?.rows ?? [];
  const modByKey = useMemo(() => new Map((modSource.data?.rows ?? []).map((row) => [row.key, row])), [modSource.data]);

  const lanes: DiffLane[] = useMemo(() => {
    const hasZh = (side: "base" | "head") => rows.some((row) => (side === "base" ? row.baseZh : row.headZh) !== undefined);
    const base = rows.some((row) => row.baseEn !== undefined || row.baseZh !== undefined);
    const head = rows.some((row) => row.headEn !== undefined || row.headZh !== undefined);
    const whole = base === head ? null : head ? ("insert" as const) : ("delete" as const);
    const source = modSource.data?.source ?? null;
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
      ...(overlay
        ? [
            {
              id: "jar",
              label: "模组 jar",
              role: "extra" as const,
              title: source === null ? "模组 jar 里的 en_us" : `${source.provider} · ${source.fileName}`,
            },
          ]
        : []),
    ];
  }, [rows, overlay, n, modSource.data]);

  const entries: DiffEntry[] = useMemo(
    () =>
      rows.map((row) => {
        const hit = modByKey.get(row.key);
        return {
          key: row.key,
          cells: {
            base: cellOf(row.baseEn, row.baseZh),
            head: cellOf(row.headEn, row.headZh),
            jar: hit?.mod === undefined ? null : { en: hit.mod, zh: null },
          },
        };
      }),
    [rows, modByKey],
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
      </div>
      {compare.data !== undefined && compare.data.missing.length > 0 && (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">缺失文件：{compare.data.missing.join("、")}</p>
      )}
    </div>
  );

  const note =
    !overlay ? undefined : modSource.error !== null ? (
      <ErrorState error={modSource.error} onRetry={() => void modSource.refetch()} />
    ) : modSource.isPending ? (
      <p className="text-xs text-muted">正在读取模组 en_us…</p>
    ) : (
      <p className="text-xs text-muted">
        {modSource.data?.note !== undefined
          ? `模组来源：${modSource.data.note}`
          : `对比来源：${modSource.data?.source?.provider ?? "-"} · ${modSource.data?.source?.fileName ?? "-"}`}
      </p>
    );

  return (
    <DiffViewer
      mode="compare"
      lanes={lanes}
      active={overlay && modSource.data !== undefined ? ["base", "head", "jar"] : ["base", "head"]}
      entries={entries}
      filter={filter}
      onFilterChange={(next) => onSearchChange({ filter: next === "diff" ? undefined : next })}
      query={query}
      onQueryChange={(next) => onSearchChange({ q: next === "" ? undefined : next })}
      defaultLayout="merge"
      leading={leading}
      controls={<Checkbox label="叠加模组 en_us" checked={overlay} onChange={(event) => onSearchChange({ overlay: event.target.checked ? "1" : undefined })} />}
      note={note}
      pending={compare.isPending}
      error={compare.error}
      onRetry={() => void compare.refetch()}
    />
  );
}

function SelectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="pt-1.5 text-xs text-muted">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {children}
      </div>
    </>
  );
}
