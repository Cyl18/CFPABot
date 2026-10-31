import type { DiffCell, DiffCombine, DiffEntry, DiffFacet, DiffFacts, DiffFilterState, DiffLane } from "@cfpa/contracts/diffview";
import { DEFAULT_DIFF_FILTER, DIFF_FACETS, FACET_MATCH, diffFacts, matchesFilter, matchesQuery } from "@cfpa/contracts/diffview";
import { elementScroll, observeElementOffset, observeElementRect, useWindowVirtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { AlignRight, ArrowLeftRight, Check, Info, Search, X } from "lucide-react";
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DiffModePicker } from "@/components/DiffModePicker.tsx";
import { CHANGE, DELETE, INSERT, InlineRuns, InlineTextDiff } from "@/components/InlineTextDiff.tsx";
import { cn } from "@/lib/cn.ts";
import { consensusOf } from "@/lib/consensus.ts";
import { inlineDiff, type DiffMode, type DiffSegment } from "@/lib/diff.ts";
import { useDiffMode } from "@/lib/diffMode.ts";
import { expandNewlines } from "@/lib/format.ts";
import { useStoredFlag } from "@/lib/storedFlag.ts";
import { Badge } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { Popover } from "@/ui/Popover.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

export type DiffLayout = "merge" | "lanes" | "grid";

const LAYOUT_KEY = "cfpa-diff-layout";
const SWAP_KEY = "cfpa-diff-swap";
const EN_RIGHT_KEY = "cfpa-diff-en-right";

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
  comments: "有评论",
};

const MODE_FACETS: Record<"compare" | "versions", readonly DiffFacet[]> = {
  compare: ["changed", "en", "zhAny", "add", "remove", "untranslated"],
  versions: ["changed", "en", "zhAny", "partial", "untranslated"],
};

const COMBINES: readonly { id: DiffCombine; label: string; hint: string }[] = [
  { id: "and", label: "和", hint: "同时满足选中的条件" },
  { id: "or", label: "或", hint: "满足其中任意一个条件" },
];

// 只有这几个开关值得反过来筛。
const NEGATABLE: readonly DiffFacet[] = ["changed", "en", "zhAny"];

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
const HEAD_SHELL = "sticky top-0 z-10 hidden border-b border-line bg-elevated text-xs text-muted";
const PAGE_OFFSET = "max-lg:top-14 max-md:top-0";
const HEADER = "px-3 py-1.5 md:flex md:items-center md:gap-3";

// 分列每列至少这么宽，放不下就横向滚动；Key 列和表头钉住。
const GRID_KEY_REM = 14;
const GRID_COL_REM = 15;
const GRID_GAP_REM = 0.75;
const GRID_ROW = "flex flex-col gap-2 border-l-2 px-3 py-2.5 md:flex-row md:items-start md:gap-3 md:border-l-0 md:py-0 md:pl-0";
const GRID_KEY =
  "flex min-w-0 flex-col gap-1 md:sticky md:left-0 md:z-[1] md:w-56 md:shrink-0 md:self-stretch md:border-l-2 md:border-r md:border-r-line/60 md:bg-surface md:py-2.5 md:pl-3 md:pr-3";

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
  if (lane.whole !== undefined) return <InlineTextDiff {...wholeEdge(lane.whole, cell?.zh ?? null)} />;
  if (cell === null) {
    if (typeof before === "string" && before !== "" && mode !== "off") return <del className={DELETE}>{expandNewlines(before)}</del>;
    return <span className="text-muted">—</span>;
  }
  if (cell.zh === null) {
    return (
      <>
        {typeof before === "string" && before !== "" && mode !== "off" && <del className={DELETE}>{expandNewlines(before)}</del>}
        {typeof before === "string" && before !== "" && mode !== "off" && " "}
        <span className="text-xs italic text-muted">未翻译</span>
      </>
    );
  }
  return <InlineTextDiff before={before} after={cell.zh} />;
}

// 行内差异按侧拆开：删除段落只画在含这段文字的旧一侧，插入段落只画在新一侧。
interface ChainSide {
  en: string;
  zh: string | null;
  zhFile: boolean;
  skipZh: boolean;
  absent: boolean;
}

type MarkKind = "insert" | "delete" | "change";

interface ChainMarks {
  en: ((MarkKind | null)[] | null)[];
  zh: ((MarkKind | null)[] | null)[];
}

// 改写的删掉那半不画，只在含新写法的一侧标黄。
function marksOf(text: string, segments: readonly DiffSegment[], side: "before" | "after"): (MarkKind | null)[] {
  const marks = new Array<MarkKind | null>(text.length).fill(null);
  let at = 0;
  for (const segment of segments) {
    if (segment.type === "equal") {
      at += segment.text.length;
      continue;
    }
    if (side === "before" ? segment.type !== "delete" : segment.type === "delete") continue;
    marks.fill(segment.type === "delete" ? "delete" : segment.type === "change" ? "change" : "insert", at, at + segment.text.length);
    at += segment.text.length;
  }
  return marks;
}

function Marked({ text, marks }: { text: string; marks: (MarkKind | null)[] | null }) {
  if (text === "") return <span className="text-muted">—</span>;
  if (marks === null) return <span>{text}</span>;
  const runs: { type: MarkKind | null; text: string }[] = [];
  let at = 0;
  while (at < text.length) {
    const type = marks[at] ?? null;
    let end = at + 1;
    while (end < text.length && (marks[end] ?? null) === type) end += 1;
    runs.push({ type, text: text.slice(at, end) });
    at = end;
  }
  return (
    <>
      {runs.map((run, index) =>
        run.type === "delete" ? (
          <del key={index} className={DELETE}>
            {run.text}
          </del>
        ) : run.type === "insert" ? (
          <ins key={index} className={INSERT}>
            {run.text}
          </ins>
        ) : run.type === "change" ? (
          <span key={index} className={CHANGE}>
            {run.text}
          </span>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}

// 相邻两侧逐个比对，和显示顺序无关；两侧都含的段落两边都不标。
function chainMarks(sides: readonly ChainSide[], mode: DiffMode): ChainMarks {
  const count = sides.length;
  const marks: ChainMarks = {
    en: new Array<(MarkKind | null)[] | null>(count).fill(null),
    zh: new Array<(MarkKind | null)[] | null>(count).fill(null),
  };
  if (mode === "off") return marks;
  for (let at = 0; at + 1 < count; at += 1) {
    const left = sides[at];
    const right = sides[at + 1];
    if (left === undefined || right === undefined || left.absent || right.absent) continue;
    const enSegments = inlineDiff(left.en, right.en, mode);
    marks.en[at] = marksOf(left.en, enSegments, "before");
    marks.en[at + 1] = marksOf(right.en, enSegments, "after");
    if (left.skipZh) continue;
    const zhLeft = left.zh ?? "";
    const zhRight = right.zh ?? "";
    const zhSegments = inlineDiff(zhLeft, zhRight, mode);
    if (right.zhFile) {
      marks.zh[at] = marksOf(zhLeft, zhSegments, "before");
      marks.zh[at + 1] = marksOf(zhRight, zhSegments, "after");
    }
  }
  return marks;
}

const CONSENSUS_LANE: DiffLane = {
  id: "\u0000consensus",
  label: "共识",
  role: "ref",
  consensus: true,
  title: "所有参与版本的列投票共识：每个版本一票，逐列取多数写法，可能谁都没写过",
};

interface ConsensusBase {
  en: string | null;
  zh: string | null;
  /** 跟共识一字不差的版本，用来标「= 谁的写法」。 */
  enLanes: string[];
  zhLanes: string[];
}

// 每个版本各投一票（同写法的版本各算一票，不并成一组）；只有两个版本时不投票，退回相邻两两比。
function consensusBase(entry: DiffEntry, lanes: readonly DiffLane[]): ConsensusBase | null {
  if (lanes.length < 3) return null;
  const en: string[] = [];
  const zh: string[] = [];
  for (const lane of lanes) {
    const cell = entry.cells[lane.id];
    if (cell == null) continue;
    en.push(expandNewlines(cell.en));
    if (lane.zhFile !== false && cell.zh != null) zh.push(expandNewlines(cell.zh));
  }
  const enText = consensusOf(en);
  const zhText = consensusOf(zh);
  return {
    en: enText,
    zh: zhText,
    enLanes:
      enText === null
        ? []
        : lanes
            .filter((lane) => {
              const cell = entry.cells[lane.id];
              return cell != null && expandNewlines(cell.en) === enText;
            })
            .map((lane) => lane.label),
    zhLanes:
      zhText === null
        ? []
        : lanes
            .filter((lane) => {
              const cell = entry.cells[lane.id];
              return lane.zhFile !== false && cell?.zh != null && expandNewlines(cell.zh) === zhText;
            })
            .map((lane) => lane.label),
  };
}

function consensusNote(lanes: readonly string[]): string {
  return lanes.length === 0 ? "≠ 任何版本" : `= ${lanes.join("、")} 的写法`;
}

function LaneChip({ lane }: { lane: DiffLane }) {
  return (
    <span
      title={lane.title}
      className={cn(
        "inline-flex h-5 w-fit items-center whitespace-nowrap rounded border px-1.5 font-mono text-xs",
        lane.consensus === true
          ? "border-dashed border-muted/50 bg-transparent text-muted"
          : lane.highlight === true
            ? "border-accent/50 bg-accent-soft font-medium text-accent"
            : "border-line bg-elevated text-muted",
      )}
    >
      {lane.label}
    </span>
  );
}

function FactBadges({ facts, compare, touched }: { facts: DiffFacts; compare: boolean; touched: boolean }) {
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
      {touched && <Badge tone="accent">本 PR 改动</Badge>}
    </div>
  );
}

function KeyColumn({
  entry,
  facts,
  compare,
  hint,
  action,
  className = KEYCOL,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  compare: boolean;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-start gap-1">
        <code className="min-w-0 flex-1 break-words font-mono text-xs text-muted" title={entry.key}>
          {entry.key.split(/(?<=[.:/_-])/).map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <wbr />}
              {part}
            </Fragment>
          ))}
        </code>
        {action}
      </div>
      <FactBadges facts={facts} compare={compare} touched={entry.touched === true} />
      {hint}
    </div>
  );
}

function MergeRow({
  entry,
  facts,
  lanes,
  compare,
  enRight,
  anchor,
  action,
  onShowLanes,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  lanes: readonly DiffLane[];
  compare: boolean;
  enRight: boolean;
  anchor?: (side: "en" | "zh") => ReactNode;
  action?: ReactNode;
  onShowLanes: () => void;
}) {
  const from = lanes[0];
  const to = lanes[lanes.length - 1];
  if (from === undefined || to === undefined) return null;
  const fromCell = entry.cells[from.id] ?? null;
  const toCell = entry.cells[to.id] ?? null;
  const wholeLane = lanes.find((lane) => lane.whole !== undefined) ?? null;
  const whole = wholeLane?.whole ?? null;
  const wholeCell = wholeLane === null ? null : (entry.cells[wholeLane.id] ?? null);
  const hidden =
    lanes.length > 2 &&
    lanes
      .slice(1, -1)
      .some((lane) => JSON.stringify(entry.cells[lane.id] ?? null) !== JSON.stringify(fromCell) && JSON.stringify(entry.cells[lane.id] ?? null) !== JSON.stringify(toCell));
  return (
    <article className={cn(ROW, BORDER[toneOf(facts, compare)])}>
      <KeyColumn
        entry={entry}
        facts={facts}
        compare={compare}
        action={action}
        hint={
          hidden ? (
            <button type="button" className="w-fit text-xs text-accent hover:underline" onClick={onShowLanes}>
              中间版本另有写法，切「逐版本」看全部
            </button>
          ) : undefined
        }
      />
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {anchor !== undefined && !enRight && <span className="flex w-7 shrink-0 justify-center">{anchor("en")}</span>}
        <div className={cn(CELL, enRight && "md:text-right")}>
          {whole === null ? (
            <InlineTextDiff before={fromCell?.en ?? null} after={toCell?.en ?? null} />
          ) : (
            <InlineTextDiff {...wholeEdge(whole, wholeCell?.en ?? null)} />
          )}
        </div>
        {anchor !== undefined && enRight && <span className="flex w-7 shrink-0 justify-center">{anchor("en")}</span>}
      </div>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {anchor !== undefined && <span className="flex w-7 shrink-0 justify-center">{anchor("zh")}</span>}
        <div className={CELL}>
          {wholeLane === null ? <ZhText lane={to} cell={toCell} before={zhReference(from, fromCell)} /> : <ZhText lane={wholeLane} cell={wholeCell} />}
        </div>
      </div>
    </article>
  );
}

function GridRow({
  entry,
  facts,
  runs,
  columns,
  compare,
  anchor,
  action,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  runs: readonly DiffLane[][];
  columns: readonly DiffLane[][];
  compare: boolean;
  anchor?: (side: "en" | "zh") => ReactNode;
  action?: ReactNode;
}) {
  const [mode] = useDiffMode();
  const lanes = useMemo(() => runs.flat(), [runs]);
  const base = useMemo(() => consensusBase(entry, lanes), [entry, lanes]);
  const heads = runs.map((run) => run[0]!);
  const sides: ChainSide[] = heads.map((lane) => {
    const cell = entry.cells[lane.id] ?? null;
    return {
      en: expandNewlines(cell?.en ?? ""),
      zh: cell?.zh == null ? null : expandNewlines(cell.zh),
      zhFile: lane.zhFile !== false,
      skipZh: lane.skipZh === true,
      absent: lane.absent === true,
    };
  });
  const marks = base === null ? chainMarks(sides, mode) : null;
  const nodes = new Map<string, ReactNode>();
  runs.forEach((run, at) => {
    const lane = heads[at]!;
    const cell = entry.cells[lane.id] ?? null;
    const side = sides[at];
    if (side === undefined) return;
    const chips = (
      <div className="mb-1 flex flex-wrap gap-1 md:hidden">
        {run.map((one) => (
          <LaneChip key={one.id} lane={one} />
        ))}
      </div>
    );
    if (lane.absent === true) {
      nodes.set(
        lane.id,
        <div key={lane.id} className={cn(CELL, "md:py-2.5")}>
          {chips}
          <span className="text-muted">—</span>
          <div className="mt-0.5 text-sm">
            <span className="text-muted">—</span>
          </div>
        </div>,
      );
      return;
    }
    const previousLane = at > 0 ? (heads[at - 1] ?? null) : null;
    const previousCell = previousLane === null ? null : (entry.cells[previousLane.id] ?? null);
    const same =
      previousCell !== null && cell !== null && previousCell.en === cell.en && (lane.zhFile === false || previousLane?.zhFile === false || previousCell.zh === cell.zh);
    nodes.set(
      lane.id,
      <div key={lane.id} className={cn(CELL, "md:py-2.5", same && "opacity-55")}>
        {chips}
        {lane.whole !== undefined ? (
          <InlineTextDiff {...wholeEdge(lane.whole, cell?.en ?? null)} />
        ) : cell === null ? (
          <span className="text-muted">—</span>
        ) : base?.en != null ? (
          <InlineRuns segments={inlineDiff(base.en, side.en, mode)} />
        ) : (
          <Marked text={side.en} marks={marks?.en[at] ?? null} />
        )}
        <div className="mt-0.5 text-sm">
          {lane.zhFile === false ? (
            <span className="text-xs italic text-muted" title="这个来源整份中文文件都不存在">
              无中文文件
            </span>
          ) : lane.whole !== undefined ? (
            <InlineTextDiff {...wholeEdge(lane.whole, cell?.zh ?? null)} />
          ) : cell === null ? (
            <span className="text-muted">—</span>
          ) : cell.zh === null ? (
            <span className="text-xs italic text-muted">未翻译</span>
          ) : base?.zh != null && side.zh !== null ? (
            <InlineRuns segments={inlineDiff(base.zh, side.zh, mode)} />
          ) : (
            <Marked text={side.zh ?? ""} marks={marks?.zh[at] ?? null} />
          )}
        </div>
      </div>,
    );
  });
  if (base !== null) {
    nodes.set(
      CONSENSUS_LANE.id,
      <div
        key={CONSENSUS_LANE.id}
        className={cn(CELL, "md:py-2.5")}
        title={base.en === null ? undefined : `英文 ${consensusNote(base.enLanes)}`}
      >
        <div className="mb-1 flex flex-wrap gap-1 md:hidden">
          <LaneChip lane={CONSENSUS_LANE} />
        </div>
        <span className="whitespace-pre-wrap break-words">{base.en ?? "—"}</span>
        <div className="mt-0.5 text-sm">
          <span className="whitespace-pre-wrap break-words">{base.zh ?? "—"}</span>
          <span className="ml-1 text-xs text-muted">{consensusNote(base.zhLanes)}</span>
        </div>
      </div>,
    );
  }
  return (
    <article className={cn(GRID_ROW, BORDER[toneOf(facts, compare)])}>
      <KeyColumn
        entry={entry}
        facts={facts}
        compare={compare}
        action={
          anchor === undefined ? (
            action
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              {anchor("en")}
              {anchor("zh")}
              {action}
            </span>
          )
        }
        className={cn(GRID_KEY, BORDER[toneOf(facts, compare)])}
      />
      {columns.map((run) => nodes.get(run[0]!.id))}
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
  anchor,
  action,
}: {
  entry: DiffEntry;
  facts: DiffFacts;
  lanes: readonly DiffLane[];
  display: readonly DiffLane[];
  compare: boolean;
  anchor?: (side: "en" | "zh") => ReactNode;
  action?: ReactNode;
}) {
  const [mode] = useDiffMode();
  const groups: LaneGroup[] = [];
  for (const lane of lanes) {
    const cell = entry.cells[lane.id] ?? null;
    const wild = lane.zhFile === false;
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

  const sides: ChainSide[] = groups.map((group) => ({
    en: expandNewlines(group.cell?.en ?? ""),
    zh: group.cell?.zh == null ? null : expandNewlines(group.cell.zh),
    zhFile: !group.wild,
    skipZh: group.wild,
    absent: false,
  }));
  const base = useMemo(() => consensusBase(entry, lanes), [entry, lanes]);
  const marks = base === null ? chainMarks(sides, mode) : null;
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
        <FactBadges facts={facts} compare={compare} touched={entry.touched === true} />
        {anchor !== undefined && (
          <span className="ml-auto flex items-center gap-1">
            {anchor("en")}
            {anchor("zh")}
          </span>
        )}
        {action !== undefined && <span className={anchor === undefined ? "ml-auto" : undefined}>{action}</span>}
      </div>
      {sameEn && (
        <p className="flex gap-2 text-sm">
          <span className="w-7 shrink-0 text-xs leading-5 text-muted">英文</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{expandNewlines(present[0]!.cell!.en)}</span>
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {base !== null && (
          <li className="flex flex-col gap-1 rounded-md border border-dashed border-line bg-elevated/30 px-2 py-1.5 sm:flex-row sm:gap-3">
            <div className="flex flex-wrap items-center gap-1 sm:w-36 sm:shrink-0">
              <LaneChip lane={CONSENSUS_LANE} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
              {base.en !== null && (
                <p className="flex gap-2">
                  <span className="w-7 shrink-0 text-xs leading-5 text-muted">英文</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {base.en}
                    <span className="ml-1 text-xs text-muted">{consensusNote(base.enLanes)}</span>
                  </span>
                </p>
              )}
              {base.zh !== null && (
                <p className="flex gap-2">
                  <span className="w-7 shrink-0 text-xs leading-5 text-muted">中文</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {base.zh}
                    <span className="ml-1 text-xs text-muted">{consensusNote(base.zhLanes)}</span>
                  </span>
                </p>
              )}
            </div>
          </li>
        )}
        {shown.map((group) => {
          if (group.cell === null) return null;
          const at = groups.indexOf(group);
          const side = sides[at];
          if (side === undefined) return null;
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
                      {direction !== null ? (
                        <InlineTextDiff {...wholeEdge(direction, group.cell.en)} />
                      ) : base?.en != null ? (
                        <InlineRuns segments={inlineDiff(base.en, side.en, mode)} />
                      ) : (
                        <Marked text={side.en} marks={marks?.en[at] ?? null} />
                      )}
                    </span>
                  </p>
                )}
                <p className="flex gap-2">
                  <span className="w-7 shrink-0 text-xs leading-5 text-muted">中文</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {group.wild ? (
                      <span className="text-xs italic text-muted">无中文文件</span>
                    ) : direction !== null ? (
                      <InlineTextDiff {...wholeEdge(direction, group.cell.zh)} />
                    ) : group.cell.zh === null ? (
                      <span className="text-xs italic text-muted">未翻译</span>
                    ) : base?.zh != null && side.zh !== null ? (
                      <InlineRuns segments={inlineDiff(base.zh, side.zh, mode)} />
                    ) : (
                      <Marked text={side.zh ?? ""} marks={marks?.zh[at] ?? null} />
                    )}
                  </span>
                </p>
              </div>
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

function CombineSwitch({ value, onChange }: { value: DiffCombine; onChange: (next: DiffCombine) => void }) {
  return (
    <span
      role="radiogroup"
      aria-label="多个筛选条件之间的关系"
      title="多个「只看」条件之间的关系；「排除」始终生效"
      className="ml-1 inline-flex h-7 items-center rounded-md border border-line bg-elevated p-0.5"
    >
      {COMBINES.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          title={item.hint}
          onClick={() => onChange(item.id)}
          className={cn(
            "inline-flex h-6 items-center rounded px-2 text-xs transition-colors",
            value === item.id ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-fg",
          )}
        >
          {item.label}
        </button>
      ))}
    </span>
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
  pending?: boolean;
  error?: unknown;
  onRetry?: () => void;
  scope?: (entry: DiffEntry) => boolean;
  /** 有评论的 key 集合；传了才出现「有评论」开关。 */
  commented?: ReadonlySet<string>;
  noDiff?: (outside: number) => ReactNode;
  sortTouchedFirst?: boolean;
  rowAction?: (entry: DiffEntry) => ReactNode;
  rowAnchor?: (entry: DiffEntry, side: "en" | "zh") => ReactNode;
  rowFooter?: (entry: DiffEntry) => ReactNode;
  scroller?: HTMLElement | null;
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
  pending = false,
  error = null,
  onRetry,
  scope,
  commented,
  noDiff,
  sortTouchedFirst = false,
  rowAction,
  rowAnchor,
  rowFooter,
  scroller = null,
}: DiffViewerProps) {
  const [layout, setLayout] = useLayout(defaultLayout);
  const [enRight, setEnRight] = useStoredFlag(EN_RIGHT_KEY);
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
  const anchored = rowAnchor !== undefined;
  const display = useMemo(() => {
    if (!compare || !swapped) return activeLanes;
    return [...activeLanes].reverse();
  }, [activeLanes, compare, swapped]);
  // 相邻版本的每个 key 中英文都一样，分列里就并成一列。
  const runs = useMemo(() => {
    const out: DiffLane[][] = [];
    for (const lane of activeLanes) {
      const run = out[out.length - 1];
      const head = run?.[0];
      const same =
        head !== undefined &&
        head.zhFile === lane.zhFile &&
        head.skipZh === lane.skipZh &&
        head.absent === lane.absent &&
        head.whole === lane.whole &&
        entries.every((entry) => {
          const a = entry.cells[head.id];
          const b = entry.cells[lane.id];
          return a == null ? b == null : b != null && a.en === b.en && a.zh === b.zh;
        });
      if (run !== undefined && same) run.push(lane);
      else out.push([lane]);
    }
    return out;
  }, [activeLanes, entries]);
  // 三个版本以上才做列投票共识；分列布局给共识单开一列。
  const consensusOn = activeLanes.length >= 3;
  const columns = useMemo(() => {
    const ordered = consensusOn ? [[CONSENSUS_LANE], ...runs] : compare ? runs.filter((run) => run.some((lane) => lane.absent !== true)) : runs;
    return compare && swapped ? [...ordered].reverse() : ordered;
  }, [runs, compare, swapped, consensusOn]);
  const present = activeLanes.filter((lane) => lane.absent !== true);
  const mergeLabel =
    present.length === activeLanes.length
      ? `${activeLanes[0]?.label} → ${activeLanes[activeLanes.length - 1]?.label}`
      : present.map((lane) => lane.label).join(" → ");
  const left = swapped ? activeLanes[activeLanes.length - 1] : activeLanes[0];
  const right = swapped ? activeLanes[0] : activeLanes[activeLanes.length - 1];
  const needle = query.trim().toLowerCase();

  const all = useMemo(
    () =>
      entries
        .filter((entry) => activeLanes.some((lane) => entry.cells[lane.id] != null))
        .map((entry) => ({ entry, facts: diffFacts(entry, activeLanes) })),
    [entries, activeLanes],
  );
  const inScope = useMemo(() => (scope === undefined ? all : all.filter((row) => scope(row.entry))), [all, scope]);
  const outside = useMemo(
    () => (scope === undefined ? 0 : all.filter((row) => !scope(row.entry) && (row.facts.differs || row.facts.missing !== null)).length),
    [all, scope],
  );
  const scoped = useMemo(() => {
    const rows = inScope.filter((row) => matchesQuery(row.entry, activeLanes, needle));
    if (sortTouchedFirst) rows.sort((a, b) => Number(b.entry.touched === true) - Number(a.entry.touched === true));
    return rows;
  }, [inScope, activeLanes, needle, sortTouchedFirst]);

  const { counts, visible } = useMemo(() => {
    const tally = new Map<DiffFacet, number>();
    const rows: typeof scoped = [];
    const match = (facet: DiffFacet, row: (typeof scoped)[number]) =>
      facet === "comments" ? commented?.has(row.entry.key) === true : FACET_MATCH[facet](row.facts);
    for (const row of scoped) {
      for (const facet of DIFF_FACETS) {
        if (match(facet, row)) tally.set(facet, (tally.get(facet) ?? 0) + 1);
      }
      if (matchesFilter((facet) => match(facet, row), filter)) rows.push(row);
    }
    return { counts: tally, visible: rows };
  }, [scoped, filter, commented]);

  const facets =
    mode === "compare" && commented !== undefined ? [...MODE_FACETS.compare, "comments" as const] : MODE_FACETS[mode];
  const isDefault = filter.combine !== "or" && DIFF_FACETS.every((facet) => filter[facet] === DEFAULT_DIFF_FILTER[facet]);

  function cycleFacet(facet: DiffFacet) {
    const next: DiffFilterState = { ...filter };
    if (filter[facet] === undefined) next[facet] = true;
    else if (filter[facet] === true && NEGATABLE.includes(facet)) next[facet] = false;
    else delete next[facet];
    onFilterChange(next);
  }

  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // 两种 Virtualizer 只差这几个钩子，运行时切换 scroller 安全。
  const own: Partial<VirtualizerOptions<Window, Element>> =
    scroller === null
      ? {}
      : ({
          getScrollElement: () => scroller,
          observeElementRect,
          observeElementOffset,
          scrollToFn: elementScroll,
          initialOffset: () => scroller.scrollTop,
        } as unknown as Partial<VirtualizerOptions<Window, Element>>);
  // key 带上布局：切换排列方式时行会重新挂载并重新测量，否则缓存被清掉后只按估算高度排版，行会互相压住。
  const virtualizer = useWindowVirtualizer({
    count: visible.length,
    estimateSize: () => (layout === "lanes" ? 140 : layout === "grid" ? 92 : 76),
    overscan: 8,
    scrollMargin,
    getItemKey: (index) => `${layout}\u0000${visible[index]?.entry.key ?? index}`,
    ...own,
  });

  useLayoutEffect(() => {
    const top = listRef.current?.getBoundingClientRect().top ?? 0;
    const margin = scroller === null ? top + window.scrollY : top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (Math.abs(margin - scrollMargin) > 1) setScrollMargin(margin);
  });
  const headShell = cn(HEAD_SHELL, scroller === null && PAGE_OFFSET);

  const headRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const gridMin = { "--grid-min": `${GRID_KEY_REM + columns.length * (GRID_COL_REM + GRID_GAP_REM) + GRID_GAP_REM}rem` } as CSSProperties;

  const picked = facets.filter((facet) => filter[facet] === true).length;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardBody className="flex flex-col gap-3">
          {leading !== undefined && <div className="border-b border-line pb-3">{leading}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              wrapperClassName="w-full sm:w-64"
              icon={<Search aria-hidden="true" className="size-3.5" />}
              aria-label="搜索 key 或文本"
              placeholder="搜索 key / 英文 / 中文"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <div role="group" aria-label="差异筛选" className="flex flex-wrap items-center gap-1">
              {facets.map((facet) => (
                <FilterChip key={facet} facet={facet} count={counts.get(facet) ?? 0} state={filter[facet]} onCycle={() => cycleFacet(facet)} />
              ))}
              {picked >= 2 && (
                <CombineSwitch value={filter.combine ?? "and"} onChange={(next) => onFilterChange({ ...filter, combine: next === "or" ? "or" : undefined })} />
              )}
            </div>
            <p aria-live="polite" className="ml-auto text-xs text-muted tabular-nums">
              显示 <span className="font-medium text-fg">{visible.length}</span> / {scoped.length} 个 key
              {scope !== undefined && outside > 0 && <> · 范围外还有 {outside} 处差异</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs items={LAYOUTS} value={layout} onChange={setLayout} ariaLabel="排列方式" />
            {layout === "merge" && (
              <ToggleChip
                pressed={enRight}
                title={enRight ? "英文列右对齐，贴近中文列；点一下改成左对齐" : "英文列左对齐；点一下改成右对齐"}
                onClick={() => setEnRight(!enRight)}
              >
                <AlignRight aria-hidden="true" className="size-3.5" />
                英文右对齐
              </ToggleChip>
            )}
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
                交换左右
              </ToggleChip>
            )}
            <DiffModePicker />
            {controls}
            <span className="ml-auto">
              <Popover
                label="图例与筛选说明"
                trigger={
                  <span className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-fg">
                    <Info aria-hidden="true" className="size-4" />
                  </span>
                }
              >
                <ul className="flex flex-col gap-1.5 text-xs text-muted">
                  <li>
                    <span className={CHANGE}>黄底</span> 同一处既有删又有加（中间没隔着两边都有的字）：只画新写法
                  </li>
                  <li>
                    <ins className={INSERT}>绿底</ins> 新写法多出来的
                  </li>
                  <li>
                    <del className={DELETE}>红底删除线</del> 旧写法里没了的
                  </li>
                  <li>选中三个版本以上时按「列投票共识」比较：虚框的「共识」是各版本逐列投票拼出来的写法，各版本相对它标色；只剩两个版本时退回相邻两两比</li>
                  <li>筛选条件点一下只看这一类，{NEGATABLE.map((facet) => `「${FACET_LABELS[facet]}」`).join("")}再点一下改成排除</li>
                  <li>选中两个以上「只看」后，可以切换它们之间是「和」还是「或」</li>
                  <li>行内差异在浏览器本地计算</li>
                </ul>
              </Popover>
            </span>
          </div>
        </CardBody>
      </Card>

      {error !== null ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : pending ? (
        <SkeletonTable rows={8} columns={3} />
      ) : entries.length === 0 ? (
        <EmptyState title="没有可比较的内容" description="这个范围里没有找到可以对照的语言文件。" />
      ) : activeLanes.length < 2 ? (
        <EmptyState
          title="只有一个版本，无从比较"
          description={`当前只选了 ${activeLanes[0]?.label ?? "—"}。至少选中两个版本，这里才有差异可看。`}
        />
      ) : scoped.length === 0 ? (
        scope !== undefined && inScope.length === 0 && all.length > 0 ? (
          (noDiff?.(outside) ?? <EmptyState title="没有范围内的 key" description="当前的筛选范围里没有任何 key。" />)
        ) : needle === "" ? (
          <EmptyState title="没有可显示的 key" description="当前条件下没有任何 key。" />
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
        <div className="overflow-clip rounded-lg border border-line bg-surface" style={layout === "grid" ? gridMin : undefined}>
          {layout === "merge" && (
            <div className={cn(headShell, HEADER, "flex-col md:flex-row")}>
              <span className="md:w-52 md:shrink-0">Key</span>
              <span className={cn("md:flex-1", enRight && "md:text-right", anchored && (enRight ? "md:pr-7" : "md:pl-7"))}>
                英文 <span className="font-mono">{mergeLabel}</span>
              </span>
              <span className={cn("md:flex-1", anchored && "md:pl-7")}>
                中文 <span className="font-mono">{mergeLabel}</span>
              </span>
            </div>
          )}
          {layout === "grid" && (
            <div
              ref={headRef}
              onScroll={(event) => {
                if (bodyRef.current !== null) bodyRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
              className={cn(headShell, "overflow-x-hidden md:block")}
            >
              <div className="flex items-stretch gap-3 pr-3 md:min-w-(--grid-min)">
                <span className="sticky left-0 z-[1] flex w-56 shrink-0 items-center border-l-2 border-r border-l-transparent border-r-line/60 bg-elevated py-1.5 pl-3 pr-3">Key</span>
                {columns.map((run) => (
                  <span
                    key={run[0]!.id}
                    title={run.length > 1 ? `${run.map((lane) => lane.label).join("、")} 的全部 key 完全一致，合成一列` : undefined}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1.5"
                  >
                    {run.map((lane) => (
                      <LaneChip key={lane.id} lane={lane} />
                    ))}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div
            ref={bodyRef}
            onScroll={
              layout === "grid"
                ? (event) => {
                    if (headRef.current !== null) headRef.current.scrollLeft = event.currentTarget.scrollLeft;
                  }
                : undefined
            }
            className={cn(layout === "grid" && "scroll-thin overflow-y-hidden md:overflow-x-auto")}
          >
          <div
            ref={listRef}
            className={cn(layout === "grid" && "md:min-w-(--grid-min)")}
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = visible[item.index];
              if (row === undefined) return null;
              const action = rowAction?.(row.entry);
              const footer = rowFooter?.(row.entry);
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="group absolute inset-x-0 top-0 border-b border-line"
                  style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
                >
                  {layout === "merge" ? (
                    <MergeRow
                      entry={row.entry}
                      facts={row.facts}
                      lanes={activeLanes}
                      compare={compare}
                      enRight={enRight}
                      anchor={rowAnchor === undefined ? undefined : (side) => rowAnchor(row.entry, side)}
                      action={action}
                      onShowLanes={() => setLayout("lanes")}
                    />
                  ) : layout === "grid" ? (
                    <GridRow
                      entry={row.entry}
                      facts={row.facts}
                      runs={runs}
                      columns={columns}
                      compare={compare}
                      anchor={rowAnchor === undefined ? undefined : (side) => rowAnchor(row.entry, side)}
                      action={action}
                    />
                  ) : (
                    <LaneCard
                      entry={row.entry}
                      facts={row.facts}
                      lanes={activeLanes}
                      display={display}
                      compare={compare}
                      anchor={rowAnchor === undefined ? undefined : (side) => rowAnchor(row.entry, side)}
                      action={action}
                    />
                  )}
                  {footer != null && (
                    <div className={cn("px-3 pb-3 empty:hidden", layout === "merge" && "md:pl-58", layout === "grid" && "sticky left-0 max-w-3xl")}>{footer}</div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
