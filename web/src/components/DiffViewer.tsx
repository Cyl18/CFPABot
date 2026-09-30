import type { DiffCell, DiffEntry, DiffFacet, DiffFacts, DiffFilterState, DiffLane } from "@shared/diffview.ts";
import { DEFAULT_DIFF_FILTER, DIFF_FACETS, FACET_MATCH, diffFacts, matchesFilter, matchesQuery } from "@shared/diffview.ts";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeftRight, Check, Copy, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DiffModePicker } from "@/components/DiffModePicker.tsx";
import { cn } from "@/lib/cn.ts";
import { inlineDiff } from "@/lib/diff.ts";
import { useDiffMode } from "@/lib/diffMode.ts";
import { expandNewlines } from "@/lib/format.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

export type DiffLayout = "merge" | "lanes" | "grid";

const LAYOUT_KEY = "cfpa-diff-layout";
const SWAP_KEY = "cfpa-diff-swap";

const LAYOUTS: readonly TabItem<DiffLayout>[] = [
  { id: "merge", label: "合并" },
  { id: "lanes", label: "逐版本" },
  { id: "grid", label: "分列" },
];

const FACET_LABELS: Record<DiffFacet, string> = {
  changed: "有变化",
  en: "英文改了",
  zhAny: "中文改了",
  add: "新增",
  remove: "删除",
  partial: "部分版本缺",
  untranslated: "未翻译",
  extra: "与模组不一致",
};

const MODE_FACETS: Record<"compare" | "versions", readonly DiffFacet[]> = {
  compare: ["changed", "en", "zhAny", "add", "remove", "untranslated", "extra"],
  versions: ["changed", "en", "zhAny", "partial", "untranslated"],
};

// 只有这几个开关值得反过来筛。
const NEGATABLE: readonly DiffFacet[] = ["changed", "en", "zhAny"];

const INSERT = "rounded-sm bg-ok/20 px-0.5 text-ok no-underline";
const DELETE = "rounded-sm bg-danger/20 px-0.5 text-danger line-through decoration-danger/60";

type Tone = "ok" | "danger" | "warn" | "accent" | "info" | "line" | "none";

const BORDER: Record<Tone, string> = {
  ok: "border-l-ok",
  danger: "border-l-danger",
  warn: "border-l-warn",
  accent: "border-l-accent",
  info: "border-l-info",
  line: "border-l-line",
  none: "border-l-transparent",
};

const ROW = "flex flex-col gap-2 border-l-2 px-3 py-2.5 md:flex-row md:items-start md:gap-3";
const CELL = "min-w-0 flex-1 whitespace-pre-wrap break-words";
const KEYCOL = "flex min-w-0 shrink-0 flex-col gap-1 md:w-52";
const HEADER = "sticky z-10 hidden border-b border-line bg-elevated px-3 py-1.5 text-xs text-muted md:flex md:items-center md:gap-3 max-lg:top-14 max-md:top-0";

function toneOf(facts: DiffFacts, compare: boolean): Tone {
  if (facts.missing === "add") return "ok";
  if (facts.missing === "remove") return "danger";
  if (facts.stale) return compare ? "warn" : "danger";
  if (facts.en) return "warn";
  if (facts.zhAny) return "accent";
  if (facts.missing === "partial") return "line";
  if (facts.untranslated) return "info";
  return "none";
}

function useLayout(fallback: DiffLayout): [DiffLayout, (next: DiffLayout) => void] {
  const [layout, setLayout] = useState<DiffLayout>(() => {
    try {
      const stored = localStorage.getItem(LAYOUT_KEY);
      return LAYOUTS.some((item) => item.id === stored) ? (stored as DiffLayout) : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    layout,
    (next) => {
      setLayout(next);
      try {
        localStorage.setItem(LAYOUT_KEY, next);
      } catch {}
    },
  ];
}

function Inline({ before, after }: { before?: string | null; after: string | null }) {
  const [mode] = useDiffMode();
  // before 为 undefined 表示没有可比的来源，原样显示，不要整段标成新增。
  if (before === undefined) return <span>{expandNewlines(after ?? "")}</span>;
  const left = before ?? "";
  const right = after ?? "";
  if (left === "" && right === "") return <span className="text-muted">—</span>;
  if (mode === "off" || left === right) return <span>{expandNewlines(right === "" ? left : right)}</span>;
  if (left === "") return <ins className={INSERT}>{expandNewlines(right)}</ins>;
  if (right === "") return <del className={DELETE}>{expandNewlines(left)}</del>;
  return (
    <>
      {inlineDiff(expandNewlines(left), expandNewlines(right), mode).map((segment, index) =>
        segment.type === "insert" ? (
          <ins key={index} className={INSERT}>
            {segment.text}
          </ins>
        ) : segment.type === "delete" ? (
          <del key={index} className={DELETE}>
            {segment.text}
          </del>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function wholeEdge(direction: "insert" | "delete", value: string | null): { before: string | null; after: string | null } {
  return direction === "insert" ? { before: null, after: value } : { before: value, after: null };
}

function zhReference(lane: DiffLane | null, cell: DiffCell | null): string | null | undefined {
  if (lane === null || lane.skipZh === true) return undefined;
  return cell?.zh ?? null;
}

function ZhText({ lane, cell, before }: { lane: DiffLane; cell: DiffCell | null; before?: string | null }) {
  const [mode] = useDiffMode();
  if (lane.zhFile === false) return <span className="text-xs italic text-muted" title="这个来源整份中文文件都不存在">无中文文件</span>;
  if (lane.whole !== undefined) return <Inline {...wholeEdge(lane.whole, cell?.zh ?? null)} />;
  if (cell === null) return <span className="text-muted">—</span>;
  if (cell.zh === null) {
    return (
      <>
        {typeof before === "string" && before !== "" && mode !== "off" && <del className={DELETE}>{expandNewlines(before)}</del>}
        {typeof before === "string" && before !== "" && mode !== "off" && " "}
        <span className="text-xs italic text-muted">未翻译</span>
      </>
    );
  }
  return <Inline before={before} after={cell.zh} />;
}

function LaneChip({ lane }: { lane: DiffLane }) {
  return (
    <span
      title={lane.title}
      className={cn(
        "inline-flex h-5 w-fit items-center whitespace-nowrap rounded border px-1.5 font-mono text-xs",
        lane.highlight === true ? "border-accent/50 bg-accent-soft font-medium text-accent" : "border-line bg-elevated text-muted",
        lane.role === "extra" && "border-dashed",
      )}
    >
      {lane.label}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      aria-label={copied ? "已复制" : "复制这条译文"}
      title={copied ? "已复制" : "复制这条译文"}
      icon={copied ? <Check aria-hidden="true" className="size-3.5 text-ok" /> : <Copy aria-hidden="true" className="size-3.5" />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

function FactBadges({ facts, compare, touched, extra }: { facts: DiffFacts; compare: boolean; touched: boolean; extra: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {facts.missing === "add" && <Badge tone="ok">新增</Badge>}
      {facts.missing === "remove" && <Badge tone="danger">删除</Badge>}
      {facts.missing === "partial" && <Badge title="有的版本没有这个 key">部分版本缺</Badge>}
      {facts.en && <Badge tone="warn">英文改了</Badge>}
      {facts.zh ? (
        <Badge tone="accent">{compare ? "只改中文" : "同文异译"}</Badge>
      ) : (
        facts.zhAny && facts.missing === null && <Badge tone="accent">中文也改了</Badge>
      )}
      {facts.stale && (
        <Badge tone={compare ? "warn" : "danger"} title="英文改了，但有的来源的中文还是旧英文时的写法">
          译文没跟上
        </Badge>
      )}
      {facts.untranslated && <Badge tone="info">未翻译</Badge>}
      {extra && facts.extra && <Badge tone="warn">与模组不一致</Badge>}
      {touched && <Badge tone="accent">本 PR 改动</Badge>}
    </div>
  );
}

function KeyColumn({ entry, facts, compare, extra, hint }: { entry: DiffEntry; facts: DiffFacts; compare: boolean; extra: boolean; hint?: ReactNode }) {
  return (
    <div className={KEYCOL}>
      <code className="break-all font-mono text-xs text-muted" title={entry.key}>
        {entry.key}
      </code>
      <FactBadges facts={facts} compare={compare} touched={entry.touched === true} extra={extra} />
      {hint}
    </div>
  );
}

function MergeRow({
  entry,
  facts,
  core,
  extra,
  compare,
  onShowLanes,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  core: readonly DiffLane[];
  extra: DiffLane | null;
  compare: boolean;
  onShowLanes: () => void;
}) {
  const from = core[0];
  const to = core[core.length - 1];
  if (from === undefined || to === undefined) return null;
  const fromCell = entry.cells[from.id] ?? null;
  const toCell = entry.cells[to.id] ?? null;
  const wholeLane = core.find((lane) => lane.whole !== undefined) ?? null;
  const whole = wholeLane?.whole ?? null;
  const wholeCell = wholeLane === null ? null : (entry.cells[wholeLane.id] ?? null);
  const jar = extra === null ? null : (entry.cells[extra.id] ?? null);
  const hidden =
    core.length > 2 &&
    core
      .slice(1, -1)
      .some((lane) => JSON.stringify(entry.cells[lane.id] ?? null) !== JSON.stringify(fromCell) && JSON.stringify(entry.cells[lane.id] ?? null) !== JSON.stringify(toCell));
  return (
    <article className={cn(ROW, BORDER[toneOf(facts, compare)])}>
      <KeyColumn
        entry={entry}
        facts={facts}
        compare={compare}
        extra={extra !== null}
        hint={
          hidden ? (
            <button type="button" className="w-fit text-xs text-accent hover:underline" onClick={onShowLanes}>
              中间版本另有写法，切「逐版本」看全部
            </button>
          ) : undefined
        }
      />
      <div className={CELL}>
        {whole === null ? (
          <Inline before={fromCell?.en ?? null} after={toCell?.en ?? null} />
        ) : (
          <Inline {...wholeEdge(whole, wholeCell?.en ?? null)} />
        )}
      </div>
      <div className={cn(CELL, "relative pr-6")}>
        {wholeLane === null ? (
          <>
            <ZhText lane={to} cell={toCell} before={zhReference(from, fromCell)} />
            {toCell?.zh != null && <CopyButton text={toCell.zh} />}
          </>
        ) : (
          <>
            <ZhText lane={wholeLane} cell={wholeCell} />
            {wholeCell?.zh != null && <CopyButton text={wholeCell.zh} />}
          </>
        )}
      </div>
      {extra !== null && (
        <div className={cn(CELL, "text-xs text-muted")}>
          {jar === null ? "模组里没有这个 key" : <Inline before={toCell?.en ?? null} after={jar.en} />}
        </div>
      )}
    </article>
  );
}

function GridRow({
  entry,
  facts,
  lanes,
  display,
  compare,
  extra,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  lanes: readonly DiffLane[];
  display: readonly DiffLane[];
  compare: boolean;
  extra: boolean;
}) {
  const nodes = new Map<string, ReactNode>();
  let beforeCell: DiffCell | null = null;
  let beforeLane: DiffLane | null = null;
  // 参照按来源本身的顺序算，和显示顺序无关。
  for (const lane of lanes) {
    const cell = entry.cells[lane.id] ?? null;
    const previousCell = beforeCell;
    const previousLane = beforeLane;
    beforeCell = cell;
    beforeLane = lane;
    if (lane.absent === true) {
      nodes.set(
        lane.id,
        <div key={lane.id} className={CELL}>
          <span className="text-muted">—</span>
          <div className="mt-0.5 text-sm">
            <span className="text-muted">—</span>
          </div>
        </div>,
      );
      continue;
    }
    const same =
      previousCell !== null && cell !== null && previousCell.en === cell.en && (lane.zhFile === false || previousLane?.zhFile === false || previousCell.zh === cell.zh);
    nodes.set(
      lane.id,
      <div key={lane.id} className={cn(CELL, "relative pr-6", same && "opacity-55")}>
        <Inline {...(lane.whole === undefined ? { before: previousLane === null ? undefined : (previousCell?.en ?? null), after: cell?.en ?? null } : wholeEdge(lane.whole, cell?.en ?? null))} />
        {lane.role === "extra" ? null : (
          <div className="mt-0.5 text-sm">
            <ZhText lane={lane} cell={cell} before={zhReference(previousLane, previousCell)} />
          </div>
        )}
        {cell?.zh != null && <CopyButton text={cell.zh} />}
      </div>,
    );
  }
  return (
    <article className={cn(ROW, BORDER[toneOf(facts, compare)])}>
      <KeyColumn entry={entry} facts={facts} compare={compare} extra={extra} />
      {display.map((lane) => nodes.get(lane.id))}
    </article>
  );
}

interface LaneGroup {
  lanes: DiffLane[];
  cell: DiffCell | null;
  wild: boolean;
}

function LaneCard({
  entry,
  facts,
  lanes,
  display,
  compare,
  extra,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  lanes: readonly DiffLane[];
  display: readonly DiffLane[];
  compare: boolean;
  extra: boolean;
}) {
  const groups: LaneGroup[] = [];
  for (const lane of lanes) {
    const cell = entry.cells[lane.id] ?? null;
    const wild = lane.role === "extra" || lane.zhFile === false;
    const found =
      cell === null
        ? groups.find((group) => group.cell === null)
        : groups.find((group) => group.cell !== null && group.cell.en === cell.en && (wild || group.wild || group.cell.zh === cell.zh));
    if (found === undefined) {
      groups.push({ lanes: [lane], cell, wild });
      continue;
    }
    found.lanes.push(lane);
    if (found.wild && !wild) {
      found.cell = cell;
      found.wild = false;
    }
  }

  const present = groups.filter((group) => group.cell !== null);
  const sameEn = present.length > 1 && new Set(present.map((group) => group.cell!.en)).size === 1;
  const direction = facts.missing === "add" ? "insert" : facts.missing === "remove" ? "delete" : null;
  const shown: LaneGroup[] = [];
  for (const lane of display) {
    const group = groups.find((item) => item.lanes.some((one) => one.id === lane.id));
    if (group !== undefined && !shown.includes(group)) shown.push(group);
  }

  return (
    <article className={cn("flex flex-col gap-2 border-l-2 px-3 py-2.5", BORDER[toneOf(facts, compare)])}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all font-mono text-xs text-muted" title={entry.key}>
          {entry.key}
        </code>
        <FactBadges facts={facts} compare={compare} touched={entry.touched === true} extra={extra} />
      </div>
      {sameEn && (
        <p className="flex gap-2 text-sm">
          <span className="w-7 shrink-0 text-xs leading-5 text-muted">英文</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{expandNewlines(present[0]!.cell!.en)}</span>
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {shown.map((group) => {
          if (group.cell === null) return null;
          const at = groups.indexOf(group);
          const reference = groups[at - 1] ?? null;
          const en = group.cell.en;
          const enBefore = reference === null ? undefined : (reference.cell?.en ?? null);
          const zhBefore = zhReference(reference === null || reference.wild ? null : reference.lanes[0]!, reference?.cell ?? null);
          return (
            <li key={at} className="flex flex-col gap-1 rounded-md border border-line/60 bg-elevated/50 px-2 py-1.5 sm:flex-row sm:gap-3">
              <div className="flex flex-wrap items-center gap-1 sm:w-36 sm:shrink-0">
                {group.lanes.map((lane) => (
                  <LaneChip key={lane.id} lane={lane} />
                ))}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                {!sameEn && (
                  <p className="flex gap-2">
                    <span className="w-7 shrink-0 text-xs leading-5 text-muted">英文</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      {direction === null ? <Inline before={enBefore} after={en} /> : <Inline {...wholeEdge(direction, en)} />}
                    </span>
                  </p>
                )}
                <p className="flex gap-2">
                  <span className="w-7 shrink-0 text-xs leading-5 text-muted">中文</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {group.wild ? (
                      group.lanes.every((lane) => lane.role === "extra") ? (
                        <span className="text-xs text-muted">模组 jar 只有英文</span>
                      ) : (
                        <span className="text-xs italic text-muted">无中文文件</span>
                      )
                    ) : direction === null ? (
                      <ZhText lane={group.lanes[0]!} cell={group.cell} before={zhBefore} />
                    ) : (
                      <Inline {...wholeEdge(direction, group.cell.zh)} />
                    )}
                  </span>
                </p>
              </div>
              {group.wild || group.cell.zh == null ? null : <CopyButton text={group.cell.zh} />}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

const CHIP = "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors";
const CHIP_IDLE = "border-line bg-elevated text-muted hover:border-muted/40 hover:text-fg";
const CHIP_ONLY = "border-accent/50 bg-accent-soft text-accent";
const CHIP_NOT = "border-danger/40 bg-danger/10 text-danger";

function FilterChip({ facet, count, state, onCycle }: { facet: DiffFacet; count: number; state: boolean | undefined; onCycle: () => void }) {
  const label = FACET_LABELS[facet];
  const idle = state === undefined;
  const title = idle
    ? `只看${label}`
    : state
      ? NEGATABLE.includes(facet)
        ? `已只看${label}，再点一下改成排除`
        : `已只看${label}，再点一下取消`
      : `已排除${label}，再点一下取消`;
  return (
    <button
      type="button"
      aria-pressed={state === true}
      disabled={idle && count === 0}
      title={title}
      onClick={onCycle}
      className={cn(CHIP, idle ? CHIP_IDLE : state ? CHIP_ONLY : CHIP_NOT, idle && count === 0 && "opacity-45")}
    >
      {state === true ? <Check aria-hidden="true" className="size-3.5" /> : state === false ? <X aria-hidden="true" className="size-3.5" /> : null}
      {label}
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

export interface DiffViewerProps {
  mode: "compare" | "versions";
  lanes: readonly DiffLane[];
  active: readonly string[];
  entries: readonly DiffEntry[];
  filter: DiffFilterState;
  onFilterChange: (next: DiffFilterState) => void;
  query: string;
  onQueryChange: (next: string) => void;
  defaultLayout: DiffLayout;
  leading?: ReactNode;
  controls?: ReactNode;
  note?: ReactNode;
  pending?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  scope?: (entry: DiffEntry) => boolean;
  noDiff?: (outside: number) => ReactNode;
  sortTouchedFirst?: boolean;
}

export function DiffViewer({
  mode,
  lanes,
  active,
  entries,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  defaultLayout,
  leading,
  controls,
  note,
  pending = false,
  error = null,
  onRetry,
  empty,
  scope,
  noDiff,
  sortTouchedFirst = false,
}: DiffViewerProps) {
  const [layout, setLayout] = useLayout(defaultLayout);
  const [swapped, setSwapped] = useState(() => {
    try {
      return localStorage.getItem(SWAP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const activeKey = active.join("\u0000");
  const activeLanes = useMemo(() => lanes.filter((lane) => active.includes(lane.id)), [lanes, activeKey]);
  const compare = mode === "compare";
  const display = useMemo(() => {
    if (!compare || !swapped) return activeLanes;
    const sources = activeLanes.filter((lane) => lane.role !== "extra");
    const rest = activeLanes.filter((lane) => lane.role === "extra");
    return [...sources].reverse().concat(rest);
  }, [activeLanes, compare, swapped]);
  const core = activeLanes.filter((lane) => lane.role !== "extra");
  const extra = activeLanes.find((lane) => lane.role === "extra") ?? null;
  const present = core.filter((lane) => lane.absent !== true);
  const mergeLabel = present.length === core.length ? `${core[0]?.label} → ${core[core.length - 1]?.label}` : present.map((lane) => lane.label).join(" → ");
  const left = swapped ? core[core.length - 1] : core[0];
  const right = swapped ? core[0] : core[core.length - 1];
  const needle = query.trim().toLowerCase();

  const all = useMemo(
    () =>
      entries
        .filter((entry) => activeLanes.some((lane) => entry.cells[lane.id] != null))
        .map((entry) => ({ entry, facts: diffFacts(entry, activeLanes) })),
    [entries, activeLanes],
  );
  const inScope = useMemo(() => (scope === undefined ? all : all.filter((row) => scope(row.entry))), [all, scope]);
  const outside = useMemo(() => (scope === undefined ? 0 : all.filter((row) => !scope(row.entry) && row.facts.differs).length), [all, scope]);
  const scoped = useMemo(() => {
    const rows = inScope.filter((row) => matchesQuery(row.entry, activeLanes, needle));
    if (sortTouchedFirst) rows.sort((a, b) => Number(b.entry.touched === true) - Number(a.entry.touched === true));
    return rows;
  }, [inScope, activeLanes, needle, sortTouchedFirst]);

  const { counts, visible } = useMemo(() => {
    const tally = new Map<DiffFacet, number>();
    const rows: typeof scoped = [];
    for (const row of scoped) {
      for (const facet of DIFF_FACETS) {
        if (FACET_MATCH[facet](row.facts)) tally.set(facet, (tally.get(facet) ?? 0) + 1);
      }
      if (matchesFilter(row.facts, filter)) rows.push(row);
    }
    return { counts: tally, visible: rows };
  }, [scoped, filter]);

  const facets = MODE_FACETS[mode].filter((facet) => facet !== "extra" || extra !== null);
  const isDefault = DIFF_FACETS.every((facet) => filter[facet] === DEFAULT_DIFF_FILTER[facet]);

  function cycleFacet(facet: DiffFacet) {
    const next: DiffFilterState = { ...filter };
    if (filter[facet] === undefined) next[facet] = true;
    else if (filter[facet] === true && NEGATABLE.includes(facet)) next[facet] = false;
    else delete next[facet];
    onFilterChange(next);
  }

  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useWindowVirtualizer({
    count: visible.length,
    estimateSize: () => (layout === "lanes" ? 140 : layout === "grid" ? 92 : 76),
    overscan: 8,
    scrollMargin,
    getItemKey: (index) => visible[index]?.entry.key ?? index,
  });

  useLayoutEffect(() => {
    const top = (listRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top);
  });

  useEffect(() => {
    virtualizer.measure();
  }, [layout, virtualizer]);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardBody className="flex flex-col gap-3">
          {leading}
          <div role="group" aria-label="差异筛选" className="flex flex-wrap items-center gap-1">
            {facets.map((facet) => (
              <FilterChip key={facet} facet={facet} count={counts.get(facet) ?? 0} state={filter[facet]} onCycle={() => cycleFacet(facet)} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              wrapperClassName="w-full sm:w-72"
              icon={<Search aria-hidden="true" className="size-3.5" />}
              aria-label="搜索 key 或文本"
              placeholder="搜索 key / 英文 / 中文"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <Tabs items={LAYOUTS} value={layout} onChange={setLayout} ariaLabel="排列方式" />
            {compare && layout !== "merge" && (
              <ToggleChip
                pressed={swapped}
                title={`当前 ${left?.label ?? "—"} 在左，点一下换成 ${right?.label ?? "—"} 在左`}
                onClick={() => {
                  const next = !swapped;
                  setSwapped(next);
                  try {
                    localStorage.setItem(SWAP_KEY, next ? "1" : "0");
                  } catch {}
                }}
              >
                <ArrowLeftRight aria-hidden="true" className="size-3.5" />
                交换 {core[0]?.label} / {core[core.length - 1]?.label}
              </ToggleChip>
            )}
            <DiffModePicker />
            {controls}
          </div>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              <ins className={INSERT}>绿底</ins> 新写法多出来的
            </span>
            <span>
              <del className={DELETE}>红底删除线</del> 旧写法里没了的
            </span>
            <span>行内差异在浏览器本地计算</span>
          </p>
          <p className="text-xs text-muted">
            显示 <span className="font-medium text-fg">{visible.length}</span> / {scoped.length} 个 key · {core.length} 个{compare ? "来源" : "版本"}参与比较
            {scope !== undefined && outside > 0 && <> · 范围外还有 {outside} 处差异</>}
          </p>
          {note}
        </CardBody>
      </Card>

      {error !== null ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : pending ? (
        <SkeletonTable rows={8} columns={3} />
      ) : entries.length === 0 ? (
        (empty ?? <EmptyState title="没有可比较的内容" description="这个范围里没有找到可以对照的语言文件。" />)
      ) : core.length < 2 ? (
        <EmptyState
          title="只有一个版本，无从比较"
          description={`当前只选了 ${core[0]?.label ?? "—"}。至少选中两个版本，这里才有差异可看。`}
        />
      ) : scoped.length === 0 ? (
        scope !== undefined && inScope.length === 0 && all.length > 0 ? (
          (noDiff?.(outside) ?? <EmptyState title="没有范围内的 key" description="当前的筛选范围里没有任何 key。" />)
        ) : needle === "" ? (
          (empty ?? <EmptyState title="没有可显示的 key" description="当前条件下没有任何 key。" />)
        ) : (
          <EmptyState
            title="没有匹配的 key"
            description="换个搜索词试试。"
            action={
              <Button size="sm" onClick={() => onQueryChange("")}>
                清空搜索
              </Button>
            }
          />
        )
      ) : visible.length === 0 ? (
        isDefault ? (
          (noDiff?.(outside) ?? <EmptyState title="没有差异" description="这些来源之间没有发现差异。" />)
        ) : (
          <EmptyState
            title="当前筛选下没有 key"
            description={`清空筛选后还有 ${scoped.length} 个 key。`}
            action={
              <Button size="sm" onClick={() => onFilterChange({})}>
                清空筛选
              </Button>
            }
          />
        )
      ) : (
        <div className="overflow-clip rounded-lg border border-line bg-surface">
          {layout === "merge" && (
            <div className={cn(HEADER, "flex-col md:flex-row")}>
              <span className="md:w-52 md:shrink-0">Key</span>
              <span className="md:flex-1">
                英文 <span className="font-mono">{mergeLabel}</span>
              </span>
              <span className="md:flex-1">
                中文 <span className="font-mono">{mergeLabel}</span>
              </span>
              {extra !== null && <span className="md:flex-1">模组 jar en_us（对比 PR）</span>}
            </div>
          )}
          {layout === "grid" && (
            <div className={HEADER}>
              <span className="md:w-52 md:shrink-0">Key</span>
              {display.map((lane) => (
                <span key={lane.id} className="md:flex-1">
                  <LaneChip lane={lane} />
                </span>
              ))}
            </div>
          )}
          <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = visible[item.index];
              if (row === undefined) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 border-b border-line"
                  style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
                >
                  {layout === "merge" ? (
                    <MergeRow entry={row.entry} facts={row.facts} core={core} extra={extra} compare={compare} onShowLanes={() => setLayout("lanes")} />
                  ) : layout === "grid" ? (
                    <GridRow entry={row.entry} facts={row.facts} lanes={activeLanes} display={display} compare={compare} extra={extra !== null} />
                  ) : (
                    <LaneCard entry={row.entry} facts={row.facts} lanes={activeLanes} display={display} compare={compare} extra={extra !== null} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
