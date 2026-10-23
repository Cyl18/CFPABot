import type { CompareRow, PrDetail, Workspace } from "@cfpa/contracts/api";
import { formatDiffFilter, parseDiffFilter } from "@cfpa/contracts/diffview";
import { ChevronRight } from "lucide-react";
import { Fragment, useMemo, type ReactNode } from "react";
import { DiffViewer } from "@/components/DiffViewer.tsx";
import { CommentAnchor, LineThreads, LooseThreads, ViewedToggle } from "@/components/Review.tsx";
import { useReview } from "@/hooks/useReview.tsx";
import { parseWorkspaceKey } from "@/lib/api.ts";
import { compareEntries, compareLanes } from "@/lib/compareView.ts";
import { groupWorkspaces, pickCompareFiles, workspaceParam } from "@/lib/paths.ts";
import { useCompare } from "@/lib/queries.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
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
  const enTarget = compare.data?.reviewEn ?? null;
  const review = useReview();
  // 依赖 review 的底层数据而不是 review 本身：后者每次渲染都是新对象，这层 memo 会白算。
  const commentedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const source of [enTarget, target]) {
      if (source === null) continue;
      for (const [key, spot] of Object.entries(source.keys)) {
        if (review.threadsAt(source.path, spot.line).length > 0 || review.outgoingAt(source.path, spot.line).length > 0) keys.add(key);
      }
    }
    return keys;
  }, [enTarget, target, review.state, review.deleting, review.outgoing]);

  const anchored = new Map<string, Set<number>>();
  for (const source of [enTarget, target]) {
    if (source === null) continue;
    anchored.set(source.path, new Set(Object.values(source.keys).map((spot) => spot.line)));
  }
  const loose = sources.flatMap((path) => {
    const lines = anchored.get(path);
    return review.threadsOf(path).filter((thread) => lines === undefined || thread.line === null || !lines.has(thread.line));
  });

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
      <span className="text-xs text-muted" title="点英文、中文列之间的加号评论；只有 PR 改动过的行 GitHub 才允许评论">
        中文 {Object.keys(target.keys).length} 个 key 可评论
        {enTarget !== null && ` · 英文 ${Object.keys(enTarget.keys).length} 个`}
      </span>
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
      commented={commentedKeys}
      rowAnchor={
        target === null && enTarget === null
          ? undefined
          : (entry, side) => {
              const source = side === "en" ? enTarget : target;
              const spot = source?.keys[entry.key];
              if (source === null || spot === undefined) return null;
              return (
                <CommentAnchor
                  path={source.path}
                  line={spot.line}
                  label={side === "en" ? "英文" : "中文"}
                  active={review.isOpen(source.path, spot.line)}
                />
              );
            }
      }
      rowFooter={
        target === null && enTarget === null
          ? undefined
          : (entry) => {
              const zones: ReactNode[] = [];
              for (const source of [enTarget, target]) {
                if (source === null) continue;
                const spot = source.keys[entry.key];
                if (spot === undefined) continue;
                if (!review.isOpen(source.path, spot.line)) continue;
                zones.push(<LineThreads key={source.path} path={source.path} line={spot.line} raw={spot.raw} />);
              }
              return zones.length === 0 ? null : <div className="flex flex-col gap-3">{zones}</div>;
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
