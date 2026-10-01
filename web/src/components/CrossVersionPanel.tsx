import type { DiffEntry, DiffLane } from "@shared/diffview.ts";
import { CircleCheck } from "lucide-react";
import { useMemo } from "react";
import { DiffViewer } from "@/components/DiffViewer.tsx";
import type { CrossVersionQuery } from "@/lib/crossVersionSearch.ts";
import { useVersionsKeys } from "@/lib/queries.ts";
import { Button } from "@/ui/Button.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { Checkbox } from "@/ui/Input.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

export interface CrossVersionPanelProps {
  slug: string;
  namespace?: string;
  pr?: number;
  state: CrossVersionQuery;
  onStateChange: (patch: Partial<CrossVersionQuery>) => void;
  onNamespaceChange: (namespace: string) => void;
}

export function CrossVersionPanel({ slug, namespace, pr, state, onStateChange, onNamespaceChange }: CrossVersionPanelProps) {
  const { versions: selection, filter, prOnly, query } = state;
  const keys = useVersionsKeys(slug, { namespace, pr, versions: selection ?? undefined });
  const data = keys.data;

  const lanes: DiffLane[] = useMemo(
    () =>
      (data?.versions ?? []).map((version) => {
        const zhFile = data?.zhVersions.includes(version) === true;
        const highlight = data?.prVersions.includes(version) === true;
        return {
          id: version,
          label: version,
          role: "real",
          highlight,
          zhFile,
          skipZh: !zhFile,
          title: highlight ? "本 PR 修改了这个版本" : zhFile ? undefined : "这个版本没有中文文件",
        };
      }),
    [data],
  );

  const entries: DiffEntry[] = useMemo(
    () =>
      (data?.rows ?? []).map((row) => ({
        key: row.key,
        touched: row.touched,
        cells: Object.fromEntries(row.cells.map((cell) => [cell.version, { en: cell.en, zh: cell.zh }])),
      })),
    [data],
  );

  const active = data?.activeVersions ?? [];
  const touched = useMemo(() => entries.filter((entry) => entry.touched === true).length, [entries]);
  const scope = useMemo(() => (prOnly ? (entry: DiffEntry) => entry.touched === true : undefined), [prOnly]);

  const select = (next: readonly string[]) => {
    if (data === undefined || next.length === 0) return;
    onStateChange({ versions: next.length === data.versions.length ? null : [...next] });
  };

  const toggleVersion = (version: string) => {
    if (data === undefined) return;
    select(active.includes(version) ? active.filter((item) => item !== version) : data.versions.filter((item) => item === version || active.includes(item)));
  };

  const leading = (
    <div className="flex flex-col gap-2">
      {data !== undefined && data.namespaces.length > 1 && (
        <div role="group" aria-label="命名空间" className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">命名空间</span>
          {data.namespaces.map((item) => (
            <ToggleChip key={item} mono pressed={item === data.namespace} onClick={() => onNamespaceChange(item)}>
              {item}
            </ToggleChip>
          ))}
        </div>
      )}
      {data !== undefined && (
        <div role="group" aria-label="参与比较的版本" className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">参与比较的版本</span>
          {data.versions.map((version) => (
            <ToggleChip
              key={version}
              mono
              pressed={active.includes(version)}
              title={lanes.find((lane) => lane.id === version)?.title}
              onClick={() => toggleVersion(version)}
            >
              {version}
            </ToggleChip>
          ))}
          {data.versions.length > 2 && (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={active.length === data.versions.length} onClick={() => select(data.versions)}>
                全选
              </Button>
              {pr !== undefined && data.prVersions.length >= 2 && data.prVersions.length < data.versions.length && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={data.prVersions.length === active.length && data.prVersions.every((version) => active.includes(version))}
                  onClick={() => select(data.prVersions)}
                >
                  只选本 PR 改动的
                </Button>
              )}
            </span>
          )}
          <span className="text-xs text-muted">· {data.rows.length} 个 key</span>
        </div>
      )}
    </div>
  );

  const noDiff = (outside: number) => {
    if (prOnly && pr !== undefined) {
      return (
        <EmptyState
          icon={<CircleCheck aria-hidden="true" className="size-5 text-ok" />}
          title={touched === 0 ? "本 PR 没有改动参与比较的 key" : "本 PR 改动的 key 与其他版本一致"}
          description={
            touched === 0
              ? `这个 PR 没动过这 ${active.length} 个版本里的 key，整份对照可以关掉上面的开关看。`
              : outside === 0
                ? `本 PR 改了 ${touched} 个 key，都对得上。`
                : `不过该模组其他 key 还有 ${outside} 处跨版本差异，与本 PR 无关。`
          }
          action={
            <Button size="sm" onClick={() => onStateChange({ prOnly: false })}>
              查看全部差异
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        icon={<CircleCheck aria-hidden="true" className="size-5 text-ok" />}
        title="各版本一致"
        description={`${active.length} 个版本、${data?.rows.length ?? 0} 个 key 里没有发现差异。`}
      />
    );
  };

  return (
    <DiffViewer
      mode="versions"
      lanes={lanes}
      active={active}
      entries={entries}
      filter={filter}
      onFilterChange={(next) => onStateChange({ filter: next })}
      query={query}
      onQueryChange={(next) => onStateChange({ query: next })}
      defaultLayout="lanes"
      leading={leading}
      controls={
        pr === undefined ? undefined : (
          <Checkbox label="只看本 PR 改动的 key" checked={prOnly} onChange={(event) => onStateChange({ prOnly: event.target.checked })} />
        )
      }
      noDiff={noDiff}
      scope={scope}
      pending={keys.isPending}
      error={keys.error}
      onRetry={() => void keys.refetch()}
      sortTouchedFirst={pr !== undefined}
    />
  );
}
