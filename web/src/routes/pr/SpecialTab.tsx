import type { SpecialKeyRow, SpecialPair, SpecialPairContent, SpecialText } from "@shared/api.ts";
import { DEFAULT_DIFF_FILTER, type DiffFilterState } from "@shared/diffview.ts";
import { Check, FileDiff, Maximize2, MessageSquarePlus, Minimize2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DiffModePicker } from "@/components/DiffModePicker.tsx";
import { DiffViewer } from "@/components/DiffViewer.tsx";
import { CARDS_KEY, CommentButton, CommentsToggle, LineComments, LineThreads, LooseThreads, ViewedToggle } from "@/components/Review.tsx";
import { useReview } from "@/hooks/useReview.tsx";
import { cn } from "@/lib/cn.ts";
import { compareEntries, compareLanes } from "@/lib/compareView.ts";
import { lineRows, type DiffSegment, type LineRow, type LineRowKind } from "@/lib/diff.ts";
import { useDiffMode } from "@/lib/diffMode.ts";
import { useSpecial, useSpecialContent } from "@/lib/queries.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
import { useStoredFlag } from "@/lib/storedFlag.ts";
import { Badge, FileStatusBadge } from "@/ui/Badge.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Input } from "@/ui/Input.tsx";
import { SkeletonText } from "@/ui/Spinner.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const WRAP_KEY = "cfpa-special-wrap";
const SYNC_KEY = "cfpa-special-sync";
const VIEW_KEY = "cfpa-special-by-key";
const LANG = "{lang}";
const FLASH_MS = 1600;

type ViewId = "text" | "key";
type Lang = "en" | "zh";

const LANGS: Record<Lang, string> = { en: "英文", zh: "中文" };
const SHORT: Record<Lang, string> = { en: "英", zh: "中" };

const ROW_TONE: Record<LineRowKind, string> = {
  equal: "border-l-transparent",
  insert: "border-l-ok bg-ok/10",
  delete: "border-l-danger bg-danger/10 text-danger/80",
  change: "border-l-warn bg-warn/5",
};

const INSERT = "rounded-sm bg-ok/20 text-ok";
const DELETE = "rounded-sm bg-danger/20 text-danger line-through decoration-danger/60";
const CHANGE = "rounded-sm bg-warn/20 text-warn";

interface Side {
  label: string;
  text: SpecialText;
}

interface Position {
  anchor: number;
  fraction: number;
}

interface Flash {
  lang: Lang;
  line: number;
}

interface Spot {
  lang: Lang;
  line: number;
  path: string;
  commentable: boolean;
}

function sharedDir(keys: readonly string[]): string {
  const [first, ...rest] = keys;
  if (first === undefined) return "";
  let parts = first.split("/").slice(0, -1);
  for (const key of rest) {
    const other = key.split("/");
    let size = 0;
    while (size < parts.length && size < other.length - 1 && parts[size] === other[size]) size += 1;
    parts = parts.slice(0, size);
  }
  const lang = parts.findIndex((part) => part.includes(LANG));
  const kept = lang === -1 ? parts : parts.slice(0, lang);
  return kept.length === 0 ? "" : `${kept.join("/")}/`;
}

function labelOf(key: string, prefix: string): string {
  const label = key
    .slice(prefix.length)
    .split("/")
    .filter((part) => part !== LANG)
    .join("/")
    .replace(/[._-]\{lang\}(?=\.|$)/g, "");
  return label === "" ? key : label;
}

function sidesOf(content: SpecialPairContent): Side[] {
  if (content.kind === "single") return [{ label: "文件", text: content.file }];
  return [
    { label: "英文", text: content.en },
    { label: "中文", text: content.zh },
  ];
}

function positionOf(pane: HTMLElement, rows: readonly LineRow[]): Position | null {
  const list = pane.firstElementChild?.children;
  if (rows.length === 0 || !list || list.length !== rows.length) return null;
  const top = pane.scrollTop;
  let lo = 0;
  let hi = list.length - 1;
  let index = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as HTMLElement).offsetTop <= top) {
      index = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const row = list[index] as HTMLElement;
  const fraction = row.offsetHeight === 0 ? 0 : Math.min(1, Math.max(0, (top - row.offsetTop) / row.offsetHeight));
  return { anchor: rows[index]?.anchor ?? 0, fraction };
}

function scrollTopFor(pane: HTMLElement, rows: readonly LineRow[], position: Position): number | null {
  const list = pane.firstElementChild?.children;
  if (rows.length === 0 || !list || list.length !== rows.length) return null;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.anchor ?? 0) < position.anchor) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= rows.length) return pane.scrollHeight;
  const row = list[lo] as HTMLElement;
  return row.offsetTop + (rows[lo]?.anchor === position.anchor ? position.fraction * row.offsetHeight : 0);
}

export function SpecialTab({ n, paths, search, onSearchChange }: { n: number; paths: string[]; search: PrSearch; onSearchChange: (patch: SearchPatch) => void }) {
  const special = useSpecial(n);
  const review = useReview();
  const [query, setQuery] = useState("");
  const items = useMemo(() => special.data ?? [], [special.data]);
  const prefix = useMemo(() => sharedDir(items.map((item) => item.key)), [items]);

  if (special.error !== null) return <ErrorState error={special.error} onRetry={() => void special.refetch()} />;
  if (special.isPending) return <SkeletonText lines={6} />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff aria-hidden="true" className="size-5" />}
        title="没有特殊文件变更"
        description={paths.length > 0 ? "特殊文件内容为空或超出大小限制。" : "本次 PR 没有手册 / 文档等非语言文件变更。"}
      />
    );
  }

  const selected = items.find((item) => item.key === search.file) ?? items[0] ?? null;
  const needle = query.trim().toLowerCase();
  const visible = needle === "" ? items : items.filter((item) => item.key.toLowerCase().includes(needle));
  const orphans = items.filter((item) => item.kind === "pair" && (item.en.status === "missing" || item.zh.status === "missing")).length;

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Card className="lg:self-start">
        <CardBody className="flex flex-col gap-2">
          <Input
            icon={<Search />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选文件"
            aria-label="筛选文件"
          />
          <p className="text-xs text-muted">
            共 {items.length} 组
            {orphans > 0 && <span className="text-danger"> · {orphans} 组缺对应语言</span>}
          </p>
          {prefix !== "" && <p className="break-all font-mono text-[11px] text-muted">{prefix}</p>}
          <nav aria-label="特殊文件">
            <ul className="-mx-2 flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto">
              {visible.map((item) => {
                const active = item === selected;
                const sides = (item.kind === "single" ? [item.file] : [item.en, item.zh]).filter((side) => side.status !== "unchanged" && side.status !== "missing");
                const done = sides.length > 0 && sides.every((side) => review.viewedOf(side.path) === "VIEWED");
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      title={item.key}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSearchChange({ file: item === items[0] ? undefined : item.key })}
                      className={cn(
                        "flex w-full flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left transition-colors",
                        active ? "bg-accent-soft text-accent" : "text-fg hover:bg-elevated",
                      )}
                    >
                      <span className="flex w-full items-start gap-1">
                        <span className="min-w-0 flex-1 break-all font-mono text-xs">{labelOf(item.key, prefix)}</span>
                        {done && <Check aria-label="已看" className="size-3.5 shrink-0 text-ok" />}
                      </span>
                      <SideTags item={item} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          {visible.length === 0 && <p className="text-xs text-muted">没有匹配的文件</p>}
        </CardBody>
      </Card>
      {selected && <PairView key={selected.key} n={n} pair={selected} label={labelOf(selected.key, prefix)} />}
    </div>
  );
}

function SideTags({ item }: { item: SpecialPair }) {
  if (item.kind === "single") return <FileStatusBadge status={item.file.status} />;
  return (
    <span className="flex flex-wrap gap-1">
      <FileStatusBadge prefix="英·" status={item.en.status} />
      <FileStatusBadge prefix="中·" status={item.zh.status} />
      {item.parsedFormat !== null && (
        <Badge tone="accent" title="这组文件能按 key 逐条对照">
          key
        </Badge>
      )}
    </span>
  );
}

function PairView({ n, pair, label }: { n: number; pair: SpecialPair; label: string }) {
  const content = useSpecialContent(n, pair.key);
  const [mode] = useDiffMode();
  const [wrap, setWrap] = useStoredFlag(WRAP_KEY);
  const [syncScroll, setSyncScroll] = useStoredFlag(SYNC_KEY);
  const [preferKey, setPreferKey] = useStoredFlag(VIEW_KEY);
  const [cards] = useStoredFlag(CARDS_KEY);
  const sides = useMemo(() => (content.data ? sidesOf(content.data) : []), [content.data]);
  const rows = useMemo(
    () => sides.map((side) => (side.text.status === "missing" ? [] : lineRows(side.text.base, side.text.head, mode))),
    [sides, mode],
  );
  const panes = useRef<(HTMLDivElement | null)[]>([]);
  const echoes = useRef<(number | null)[]>([]);
  const shell = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const [jumped, setJumped] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [filter, setFilter] = useState<DiffFilterState>(DEFAULT_DIFF_FILTER);
  const [query, setQuery] = useState("");

  const data = content.data;
  const parsed = data?.kind === "pair" && data.parsed !== null && data.parsed.rows.length > 0 ? { content: data, rows: data.parsed.rows } : null;
  const keyable = data === undefined ? pair.kind === "pair" && pair.parsedFormat !== null : parsed !== null;
  const view: ViewId = keyable && preferKey && !jumped ? "key" : "text";
  const bindShell = useCallback((node: HTMLDivElement | null) => {
    shell.current = node;
    setScroller(node);
  }, []);

  useEffect(() => {
    if (!full) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    document.addEventListener("keydown", onKeyDown);
    (panes.current[0] ?? shell.current)?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      restore?.focus();
    };
  }, [full]);

  useEffect(() => {
    if (flash === null || view !== "text") return;
    const pane = panes.current[flash.lang === "en" ? 0 : 1];
    pane?.querySelector(`[data-line="${flash.line}"]`)?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash, view]);

  const sync = (from: number) => {
    const source = panes.current[from];
    if (!source) return;
    const echo = echoes.current[from];
    echoes.current[from] = null;
    if (echo != null && Math.abs(echo - source.scrollTop) < 1) return;
    const position = positionOf(source, rows[from] ?? []);
    if (position === null) return;
    panes.current.forEach((target, index) => {
      if (index === from || !target) return;
      const top = scrollTopFor(target, rows[index] ?? [], position);
      if (top === null || Math.abs(target.scrollTop - top) < 1) return;
      target.scrollTop = top;
      echoes.current[index] = target.scrollTop;
    });
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="min-w-0 break-all font-mono text-sm text-fg" title={pair.key}>
        {label}
      </h2>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {view === "text" && <DiffModePicker size="sm" />}
        <CommentsToggle />
        {view === "text" && (
          <>
            <ToggleChip pressed={wrap} onClick={() => setWrap(!wrap)}>
              自动换行
            </ToggleChip>
            <ToggleChip
              pressed={syncScroll}
              onClick={() => {
                const next = !syncScroll;
                setSyncScroll(next);
                if (next) sync(0);
              }}
            >
              同步滚动
            </ToggleChip>
          </>
        )}
        {keyable && (
          <ToggleChip
            pressed={view === "key"}
            onClick={() => {
              setJumped(false);
              setPreferKey(view !== "key");
            }}
            title={view === "key" ? "回到文本对照" : "按 key 逐条对照"}
          >
            按 key 对照
          </ToggleChip>
        )}
        <ToggleChip pressed={full} onClick={() => setFull(!full)} title={full ? "退出全屏（Esc）" : "全屏查看"}>
          {full ? <Minimize2 aria-hidden="true" className="size-3.5" /> : <Maximize2 aria-hidden="true" className="size-3.5" />}
          {full ? "退出全屏" : "全屏"}
        </ToggleChip>
      </div>
    </div>
  );

  if (view === "key" && parsed !== null) {
    return (
      <div ref={bindShell} tabIndex={-1} className={cn("min-w-0", full && "fixed inset-0 z-50 overflow-y-auto bg-bg p-3 outline-none")}>
        <KeyView
          content={parsed.content}
          rows={parsed.rows}
          header={header}
          cards={cards}
          filter={filter}
          onFilterChange={setFilter}
          query={query}
          onQueryChange={setQuery}
          scroller={full ? scroller : null}
          onJump={(lang, line) => {
            setJumped(true);
            setFlash({ lang, line });
          }}
        />
      </div>
    );
  }

  return (
    <Card className={cn("min-w-0", full && "fixed inset-0 z-50 flex flex-col rounded-none")}>
      <CardBody className={cn("flex flex-col gap-3", full && "min-h-0 flex-1")}>
        {header}
        {content.error !== null ? (
          <ErrorState error={content.error} onRetry={() => void content.refetch()} />
        ) : content.isPending ? (
          <SkeletonText lines={8} />
        ) : (
          <div className={cn("grid gap-4", sides.length === 2 && "md:grid-cols-2", full ? "min-h-0 flex-1 items-stretch" : "items-start")}>
            {sides.map((side, index) => (
              <SidePane
                key={side.label}
                side={side}
                rows={rows[index] ?? []}
                wrap={wrap}
                cards={cards}
                fill={full}
                flash={flash !== null && LANGS[flash.lang] === side.label ? flash.line : null}
                paneRef={(node) => {
                  panes.current[index] = node;
                }}
                onScroll={syncScroll ? () => sync(index) : undefined}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function KeyView({
  content,
  rows,
  header,
  cards,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  scroller,
  onJump,
}: {
  content: Extract<SpecialPairContent, { kind: "pair" }>;
  rows: readonly SpecialKeyRow[];
  header: ReactNode;
  cards: boolean;
  filter: DiffFilterState;
  onFilterChange: (next: DiffFilterState) => void;
  query: string;
  onQueryChange: (next: string) => void;
  scroller: HTMLElement | null;
  onJump: (lang: Lang, line: number) => void;
}) {
  const review = useReview();
  const lanes = useMemo(() => compareLanes(rows, review.n), [rows, review.n]);
  const entries = useMemo(() => compareEntries(rows), [rows]);
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const heads = useMemo(
    () => ({ en: content.en.head?.split("\n") ?? [], zh: content.zh.head?.split("\n") ?? [] }),
    [content.en.head, content.zh.head],
  );

  const spotsOf = (key: string): Spot[] => {
    const row = byKey.get(key);
    if (row === undefined) return [];
    const spots: Spot[] = [];
    for (const lang of ["en", "zh"] as const) {
      const line = lang === "en" ? row.enLine : row.zhLine;
      if (line === undefined) continue;
      const text = content[lang];
      spots.push({ lang, line, path: text.path, commentable: (text.hunks ?? []).some((hunk) => line >= hunk.start && line <= hunk.end) });
    }
    return spots;
  };

  const anchored = { en: new Set(rows.flatMap((row) => row.enLine ?? [])), zh: new Set(rows.flatMap((row) => row.zhLine ?? [])) };
  const loose = (["en", "zh"] as const).flatMap((lang) =>
    review.threadsOf(content[lang].path).filter((thread) => thread.line === null || !anchored[lang].has(thread.line)).map((thread) => ({ lang, thread })),
  );
  const langOf = new Map(loose.map((item) => [item.thread, item.lang]));

  const leading = (
    <div className="flex flex-col gap-2">
      {header}
      <div role="group" aria-label="对照文件" className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {(["en", "zh"] as const).map((lang) => {
          const text = content[lang];
          return (
            <span key={lang} className="inline-flex min-w-0 items-center gap-1.5 text-xs">
              <span className="font-medium text-fg">{LANGS[lang]}</span>
              <FileStatusBadge status={text.status} />
              <code className="break-all font-mono text-muted" title={text.path}>
                {text.path.slice(text.path.lastIndexOf("/") + 1)}
              </code>
              {text.status !== "unchanged" && text.status !== "missing" && <ViewedToggle path={text.path} />}
            </span>
          );
        })}
      </div>
      <LooseThreads
        title="没对上 key 的评论（已过时或不在条目行上）"
        threads={loose.map((item) => item.thread)}
        locate={(thread) => {
          const side = LANGS[langOf.get(thread) ?? "zh"];
          if (thread.line !== null) return `${side}第 ${thread.line} 行`;
          return thread.originalLine === null ? side : `${side}原第 ${thread.originalLine} 行`;
        }}
      />
    </div>
  );

  return (
    <DiffViewer
      mode="compare"
      lanes={lanes}
      active={["base", "head"]}
      entries={entries}
      filter={filter}
      onFilterChange={onFilterChange}
      query={query}
      onQueryChange={onQueryChange}
      defaultLayout="merge"
      leading={leading}
      scroller={scroller}
      rowAction={(entry) => {
        const spots = spotsOf(entry.key);
        if (spots.length === 0) return null;
        return (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            {spots.map((spot) => (
              <span key={spot.lang} className="inline-flex items-center gap-0.5">
                {spot.commentable && <CommentButton path={spot.path} line={spot.line} label={`${LANGS[spot.lang]}第 ${spot.line} 行：`} peek />}
                {spot.commentable && !cards && <LineComments path={spot.path} line={spot.line} />}
                <button
                  type="button"
                  onClick={() => onJump(spot.lang, spot.line)}
                  aria-label={`在文本对照里查看${LANGS[spot.lang]}第 ${spot.line} 行`}
                  title={`在文本对照里查看${LANGS[spot.lang]}第 ${spot.line} 行`}
                  className="inline-flex h-5 items-center gap-1 rounded px-1 font-mono text-[11px] tabular-nums text-muted transition-colors hover:bg-elevated hover:text-accent"
                >
                  <span className="font-sans">{SHORT[spot.lang]}</span>
                  {spot.line}
                </button>
              </span>
            ))}
          </div>
        );
      }}
      rowFooter={
        cards
          ? (entry) => {
              const shown = spotsOf(entry.key).filter(
                (spot) =>
                  review.threadsAt(spot.path, spot.line).length + review.outgoingAt(spot.path, spot.line).length > 0 || review.isOpen(spot.path, spot.line),
              );
              if (shown.length === 0) return null;
              return (
                <div className="flex flex-col gap-2">
                  {shown.map((spot) => (
                    <div key={spot.lang} className="flex flex-col gap-1">
                      <span className="text-xs text-muted">
                        {LANGS[spot.lang]} · 第 {spot.line} 行
                      </span>
                      <LineThreads path={spot.path} line={spot.line} raw={heads[spot.lang][spot.line - 1]?.replace(/\r$/, "")} />
                    </div>
                  ))}
                </div>
              );
            }
          : undefined
      }
    />
  );
}

function SidePane({
  side,
  rows,
  wrap,
  cards,
  fill,
  flash,
  paneRef,
  onScroll,
}: {
  side: Side;
  rows: readonly LineRow[];
  wrap: boolean;
  cards: boolean;
  fill: boolean;
  flash: number | null;
  paneRef: (node: HTMLDivElement | null) => void;
  onScroll?: () => void;
}) {
  const review = useReview();
  const { text } = side;
  const missing = text.status === "missing";
  const paneHeight = fill ? "min-h-0 flex-1" : "h-[70vh]";
  const hunks = text.hunks ?? [];
  const heads = text.head?.split("\n") ?? [];
  const outdated = review.threadsOf(text.path).filter((thread) => thread.line === null);
  return (
    <section aria-label={side.label} className={cn("flex min-w-0 flex-col gap-1.5", fill && "min-h-0")}>
      <header className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-fg">{side.label}</span>
        <FileStatusBadge status={text.status} />
        {text.status !== "unchanged" && !missing && <ViewedToggle path={text.path} />}
        {text.truncated && <span className="text-warn">内容过大，已截断</span>}
        <RowCounts rows={rows} />
      </header>
      <code className="break-all font-mono text-[11px] text-muted">
        {text.previousPath === undefined ? text.path : `${text.previousPath} → ${text.path}`}
      </code>
      <LooseThreads title="已过时的评论" threads={outdated} locate={(thread) => (thread.originalLine === null ? "" : `原第 ${thread.originalLine} 行`)} />
      {missing ? (
        <div className={cn("flex items-center justify-center rounded-md border border-dashed border-line px-4 text-center text-sm text-muted", paneHeight)}>
          仓库里没有对应的{side.label}文件
        </div>
      ) : rows.length === 0 ? (
        <div className={cn("flex items-center justify-center rounded-md border border-line px-4 text-sm text-muted", paneHeight)}>空文件</div>
      ) : (
        <div
          ref={paneRef}
          onScroll={onScroll}
          tabIndex={0}
          aria-label={`${side.label}内容`}
          className={cn("@container relative overflow-auto rounded-md border border-line bg-surface font-mono text-xs leading-5", paneHeight)}
        >
          <div className={wrap ? "w-full" : "w-max min-w-full"}>
            {rows.map((row, index) => {
              const line = row.line;
              const commentable = line !== null && hunks.some((hunk) => line >= hunk.start && line <= hunk.end);
              const count = line === null ? 0 : review.threadsAt(text.path, line).length + review.outgoingAt(text.path, line).length;
              return (
                <div key={index} data-line={line ?? undefined}>
                  <div className={cn("group flex border-l-2 transition-shadow", ROW_TONE[row.kind], line !== null && line === flash && "ring-2 ring-inset ring-accent")}>
                    <span className="sticky left-0 flex w-14 shrink-0 select-none items-start justify-end gap-0.5 bg-surface pr-2 tabular-nums text-muted">
                      {commentable && (
                        <button
                          type="button"
                          aria-label={`评论第 ${line} 行`}
                          title={count > 0 ? `${count} 条评论` : "评论这一行（进入你的待提交审查）"}
                          onClick={() => review.setOpen(text.path, line, !review.isOpen(text.path, line))}
                          className={cn(
                            "mt-0.5 inline-flex size-4 items-center justify-center rounded text-accent focus-visible:opacity-100",
                            count > 0 ? "bg-accent-soft opacity-100" : "opacity-0 group-hover:opacity-100 hover:bg-accent-soft",
                          )}
                        >
                          <MessageSquarePlus aria-hidden="true" className="size-3" />
                        </button>
                      )}
                      <span>{line ?? ""}</span>
                    </span>
                    <span className={cn("min-w-0 flex-1 px-2", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
                      {row.segments ? <Segments segments={row.segments} /> : row.text === "" ? " " : row.text}
                    </span>
                  </div>
                  {commentable && cards && (
                    <LineThreads
                      path={text.path}
                      line={line}
                      raw={heads[line - 1]?.replace(/\r$/, "")}
                      className="sticky left-0 w-full max-w-[min(48rem,100cqw)] border-y border-line/60 bg-elevated/40 px-3 py-2"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function Segments({ segments }: { segments: readonly DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "insert" ? (
          <ins key={index} className={cn(INSERT, "no-underline")}>
            {segment.text}
          </ins>
        ) : segment.type === "delete" ? (
          <del key={index} className={DELETE}>
            {segment.text}
          </del>
        ) : segment.type === "change" ? (
          <span key={index} className={CHANGE}>
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function RowCounts({ rows }: { rows: readonly LineRow[] }) {
  let inserted = 0;
  let deleted = 0;
  let changed = 0;
  for (const row of rows) {
    if (row.kind === "insert") inserted += 1;
    else if (row.kind === "delete") deleted += 1;
    else if (row.kind === "change") changed += 1;
  }
  return (
    <span className="ml-auto flex gap-2 tabular-nums text-muted">
      <span>{rows.length} 行</span>
      {changed > 0 && <span className="text-warn">~{changed}</span>}
      {inserted > 0 && <span className="text-ok">+{inserted}</span>}
      {deleted > 0 && <span className="text-danger">-{deleted}</span>}
    </span>
  );
}
