import type { CompareRow, PrDetail, Workspace } from "@shared/api.ts";
import { formatDiffFilter, parseDiffFilter } from "@shared/diffview.ts";
import { ChevronRight } from "lucide-react";
import { Fragment, useMemo } from "react";
import { DiffViewer } from "@/components/DiffViewer.tsx";
import { CARDS_KEY, CommentButton, CommentsToggle, LineComments, LineThreads, LooseThreads, ViewedToggle } from "@/components/Review.tsx";
import { useReview } from "@/hooks/useReview.tsx";
import { parseWorkspaceKey } from "@/lib/api.ts";
import { compareEntries, compareLanes } from "@/lib/compareView.ts";
import { groupWorkspaces, pickCompareFiles, workspaceParam } from "@/lib/paths.ts";
import { useCompare } from "@/lib/queries.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
import { useStoredFlag } from "@/lib/storedFlag.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

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
  const target = compare.data?.review ?? null;
  const review = useReview();
  const [cards] = useStoredFlag(CARDS_KEY);

  const anchored = new Set(Object.values(target?.keys ?? {}).map((spot) => spot.line));
  const loose = sources.flatMap((path) =>
    review.threadsOf(path).filter((thread) => path !== target?.path || thread.line === null || !anchored.has(thread.line)),
  );

  const lanes = useMemo(() => compareLanes(rows, n), [rows, n]);
  const entries = useMemo(() => compareEntries(rows), [rows]);

  if (workspaces.length === 0) {
    return <EmptyState title="没有可比较的工作区" description="此 PR 没有检测到可比较的语言文件工作区。" />;
  }

  const crumbs = [
    mod !== undefined && (
      <Level
        key="mod"
        label="模组"
        items={groups}
        current={mod}
        name={(item) => item.slug}
        onPick={(item) => open(item.namespaces.flatMap((entry) => entry.workspaces))}
      />
    ),
    mod !== undefined && group !== undefined && (
      <Level
        key="namespace"
        label="命名空间"
        items={mod.namespaces}
        current={group}
        name={(item) => item.namespace}
        onPick={(item) => open(item.workspaces)}
      />
    ),
    group !== undefined && selected !== null && (
      <Level key="version" label="版本" items={group.workspaces} current={selected} name={(item) => item.version} onPick={(item) => open([item])} />
    ),
  ].filter((item) => item !== false);

  const leading = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <nav aria-label="比较范围" className="flex min-w-0 flex-wrap items-center gap-1.5">
          {crumbs.map((crumb, index) => (
            <Fragment key={index}>
              {index > 0 && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted" />}
              {crumb}
            </Fragment>
          ))}
        </nav>
        {sources.length > 0 && (
          <div role="group" aria-label="比较文件" title={sources.join("\n")} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {sources.map((path) => (
              <span key={path} className="inline-flex items-center gap-1.5">
                <span className="font-mono text-xs text-muted">{path.slice(path.lastIndexOf("/") + 1)}</span>
                <ViewedToggle path={path} />
              </span>
            ))}
          </div>
        )}
      </div>
      {compare.data !== undefined && compare.data.missing.length > 0 && (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">缺失文件：{compare.data.missing.join("、")}</p>
      )}
      <LooseThreads
        title="没对上 key 的评论（已过时或在英文文件上）"
        threads={loose}
        locate={(thread) => `${thread.path.slice(thread.path.lastIndexOf("/") + 1)}${thread.line === null ? "" : `:${thread.line}`}`}
      />
    </div>
  );

  const controls =
    compare.data === undefined ? undefined : target === null ? (
      <span className="text-xs text-muted" title="GitHub 只允许在本 PR 改动过的行上评论">
        中文文件未改动，不能行内评论
      </span>
    ) : (
      <>
        <CommentsToggle />
        <span className="text-xs text-muted" title="点 key 旁的气泡评论；中文改动范围外的行 GitHub 不允许评论">
          {Object.keys(target.keys).length} 个 key 可评论
        </span>
      </>
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
      controls={controls}
      pending={compare.isPending}
      error={compare.error}
      onRetry={() => void compare.refetch()}
      rowAction={
        target === null
          ? undefined
          : (entry) => {
              const spot = target.keys[entry.key];
              return spot === undefined ? null : (
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <CommentButton path={target.path} line={spot.line} />
                  <LineComments path={target.path} line={spot.line} />
                </div>
              );
            }
      }
      rowFooter={
        target === null || !cards
          ? undefined
          : (entry) => {
              const spot = target.keys[entry.key];
              return spot === undefined ? null : <LineThreads path={target.path} line={spot.line} raw={spot.raw} />;
            }
      }
    />
  );
}

function Level<T>({
  label,
  items,
  current,
  name,
  onPick,
}: {
  label: string;
  items: readonly T[];
  current: T;
  name: (item: T) => string;
  onPick: (item: T) => void;
}) {
  if (items.length <= 1) {
    return (
      <span title={label} className="font-mono text-xs text-fg">
        {name(current)}
      </span>
    );
  }
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <ToggleChip key={name(item)} mono pressed={item === current} onClick={() => onPick(item)}>
          {name(item)}
        </ToggleChip>
      ))}
    </div>
  );
}
