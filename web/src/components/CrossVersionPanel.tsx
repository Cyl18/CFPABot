import type { CrossVersionIssue, CrossVersionIssueKind, CrossVersionKeyRow, CrossVersionVariant } from "@shared/api.ts";
import { Check, CircleCheck, Copy, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DiffModePicker } from "@/components/DiffModePicker.tsx";
import { cn } from "@/lib/cn.ts";
import type { CrossVersionKind, CrossVersionQuery, CrossVersionView } from "@/lib/crossVersionSearch.ts";
import { inlineDiff } from "@/lib/diff.ts";
import { useDiffMode } from "@/lib/diffMode.ts";
import { expandNewlines } from "@/lib/format.ts";
import { PAIR_LAYOUTS, usePairLayout, type PairLayout } from "@/lib/pairLayout.ts";
import { useVersions, useVersionsKeys } from "@/lib/queries.ts";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Checkbox, Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { DataTable, type Column } from "@/ui/Table.tsx";
import { Tabs } from "@/ui/Tabs.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

const PAGE = 50;

const KINDS: readonly CrossVersionIssueKind[] = ["conflict", "changed", "untranslated"];

const VIEWS: readonly { id: CrossVersionView; label: string }[] = [
  { id: "issues", label: "跨版本问题" },
  { id: "keys", label: "全部 key 对齐" },
];

const KIND_LABEL: Record<CrossVersionKind, string> = { conflict: "冲突", changed: "有变化", untranslated: "未翻译", all: "全部" };

const KIND_TONE: Record<CrossVersionIssueKind, BadgeTone> = { conflict: "danger", changed: "warn", untranslated: "info" };

const PAIR_GRID = "grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3";

export interface CrossVersionPanelProps {
  slug: string;
  namespace?: string;
  pr?: number;
  state: CrossVersionQuery;
  onStateChange: (patch: Partial<CrossVersionQuery>) => void;
  onNamespaceChange: (namespace: string) => void;
}

export function CrossVersionPanel({ slug, namespace, pr, state, onStateChange, onNamespaceChange }: CrossVersionPanelProps) {
  const { view, versions: selection, kind, prOnly, query, keyQuery } = state;
  const [limit, setLimit] = useState(PAGE);
  const [layout, setLayout] = usePairLayout();

  const versions = useVersions(slug, { namespace, pr, versions: selection ?? undefined });
  const keys = useVersionsKeys(slug, { namespace, pr, versions: selection ?? undefined }, view === "keys");

  const keyRows = useMemo(() => {
    const needle = keyQuery.trim().toLowerCase();
    const rows = keys.data ?? [];
    if (needle === "") return rows;
    return rows.filter(
      (row) =>
        row.key.toLowerCase().includes(needle) ||
        row.cells.some((cell) => cell.en.toLowerCase().includes(needle) || cell.zh?.toLowerCase().includes(needle) === true),
    );
  }, [keys.data, keyQuery]);

  const data = versions.data;
  const activeVersions = data?.activeVersions ?? [];
  const prVersions = useMemo(() => new Set(data?.prVersions ?? []), [data]);

  const scoped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.issues ?? []).filter((issue) => {
      if (prOnly && pr !== undefined && !issue.touched) return false;
      if (needle === "") return true;
      return (
        issue.key.toLowerCase().includes(needle) ||
        issue.variants.some((variant) => variant.en.toLowerCase().includes(needle) || variant.zh?.toLowerCase().includes(needle) === true)
      );
    });
  }, [data, pr, prOnly, query]);

  const counts = useMemo(() => {
    const result: Record<CrossVersionKind, number> = { conflict: 0, changed: 0, untranslated: 0, all: scoped.length };
    for (const issue of scoped) result[issue.kind] += 1;
    return result;
  }, [scoped]);

  const filtered = kind === "all" ? scoped : scoped.filter((issue) => issue.kind === kind);
  const visible = filtered.slice(0, limit);
  const touchedTotal = useMemo(() => (data?.issues ?? []).filter((issue) => issue.touched).length, [data]);

  const reset = () => setLimit(PAGE);

  const toggleVersion = (version: string) => {
    if (data === undefined) return;
    const next = activeVersions.includes(version)
      ? activeVersions.filter((item) => item !== version)
      : data.versions.filter((item) => item === version || activeVersions.includes(item));
    if (next.length === 0) return;
    onStateChange({ versions: next.length === data.versions.length ? null : next });
    reset();
  };

  if (versions.error !== null) return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  if (data === undefined) return <SkeletonTable rows={6} columns={3} />;

  const hasIssues = activeVersions.length >= 2 && data.issues.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <Tabs
            ariaLabel="视图"
            value={view}
            onChange={(next) => onStateChange({ view: next })}
            items={VIEWS.map((item) => ({
              id: item.id,
              label: `${item.label} ${item.id === "issues" ? data.issues.length : data.keyCount}`,
            }))}
          />

          {data.namespaces.length > 1 && (
            <div role="group" aria-label="命名空间" className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">命名空间</span>
              {data.namespaces.map((item) => (
                <ToggleChip key={item} mono pressed={item === data.namespace} onClick={() => onNamespaceChange(item)}>
                  {item}
                </ToggleChip>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-muted">参与比较的版本</span>
            {data.versions.map((version) => (
              <ToggleChip
                key={version}
                mono
                pressed={activeVersions.includes(version)}
                title={prVersions.has(version) ? "本 PR 修改了这个版本" : undefined}
                onClick={() => toggleVersion(version)}
              >
                {version}
              </ToggleChip>
            ))}
            <span className="ml-1 text-xs text-muted">· {data.keyCount} 个 key</span>
          </div>

          {view === "keys" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Tabs items={PAIR_LAYOUTS} value={layout} onChange={setLayout} ariaLabel="对照布局" />
              <Input
                aria-label="搜索 key 或译文"
                placeholder="搜索 key / 英文 / 中文"
                icon={<Search />}
                wrapperClassName="w-full sm:w-72"
                value={keyQuery}
                onChange={(event) => onStateChange({ keyQuery: event.target.value })}
              />
              <DiffModePicker />
            </div>
          ) : (
            hasIssues && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Tabs
                    ariaLabel="问题类型"
                    value={kind}
                    onChange={(next) => {
                      onStateChange({ kind: next });
                      reset();
                    }}
                    items={[...KINDS, "all" as const].map((id) => ({ id, label: `${KIND_LABEL[id]} ${counts[id]}` }))}
                  />
                  {pr !== undefined && (
                    <Checkbox
                      label="只看本 PR 改动的 key"
                      checked={prOnly}
                      onChange={(event) => {
                        onStateChange({ prOnly: event.target.checked });
                        reset();
                      }}
                    />
                  )}
                  <Input
                    aria-label="搜索 key 或译文"
                    placeholder="搜索 key / 英文 / 中文"
                    icon={<Search />}
                    wrapperClassName="w-full sm:ml-auto sm:w-72"
                    value={query}
                    onChange={(event) => {
                      onStateChange({ query: event.target.value });
                      reset();
                    }}
                  />
                  <DiffModePicker />
                </div>

                <p className="text-xs text-muted">
                  <span className="text-danger">冲突</span>：同一句英文在不同版本译法不同；
                  <span className="text-warn">有变化</span>：英文原文在版本之间改过，逐版本对照看译文有没有跟上；
                  <span className="text-info">未翻译</span>：同一句英文有的版本已翻译，有的还空着。
                </p>
              </>
            )
          )}
        </CardBody>
      </Card>

      {view === "keys" ? (
        keys.error !== null ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.data === undefined ? (
          <SkeletonTable rows={8} columns={3} />
        ) : keys.data.length === 0 || keyRows.length === 0 ? (
          <EmptyState
            icon={<Search aria-hidden="true" className="size-5" />}
            title="没有匹配的 key"
            description={keys.data.length === 0 ? "这个命名空间下没有可对齐的 key。" : "换个搜索词试试。"}
          />
        ) : (
          <AlignTable
            rows={keyRows}
            versions={activeVersions}
            prVersions={prVersions}
            showTouched={pr !== undefined}
            layout={layout}
          />
        )
      ) : activeVersions.length < 2 ? (
        <EmptyState
          title="只有一个版本，无从比较"
          description={`${data.namespace} 当前只选了 ${activeVersions[0] ?? "—"} 这一个版本。至少选中两个版本，这里才会列出跨版本的冲突、变化和未翻译。`}
        />
      ) : !hasIssues ? (
        <EmptyState
          icon={<CircleCheck aria-hidden="true" className="size-5 text-ok" />}
          title="各版本一致"
          description={`${activeVersions.length} 个版本、${data.keyCount} 个 key 里没有发现冲突、英文变化或未翻译。切到「全部 key 对齐」可以逐条看英文和译文的对应。`}
          action={
            <Button size="sm" onClick={() => onStateChange({ view: "keys" })}>
              看全部 key 对齐
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        prOnly && pr !== undefined && touchedTotal === 0 && query.trim() === "" ? (
          <EmptyState
            icon={<CircleCheck aria-hidden="true" className="size-5 text-ok" />}
            title="本 PR 改动的 key 与其他版本一致"
            description={`不过该模组其他 key 还有 ${data.issues.length} 处跨版本问题，与本 PR 无关。`}
            action={
              <Button size="sm" onClick={() => onStateChange({ prOnly: false })}>
                查看全部问题
              </Button>
            }
          />
        ) : query.trim() !== "" ? (
          <EmptyState icon={<Search aria-hidden="true" className="size-5" />} title="没有匹配的问题" description="换个搜索词或问题类型试试。" />
        ) : (
          <EmptyState
            icon={<CircleCheck aria-hidden="true" className="size-5 text-ok" />}
            title={`没有${KIND_LABEL[kind]}`}
            description={`其他类型还有 ${counts.all} 条。`}
            action={
              <Button size="sm" onClick={() => onStateChange({ kind: "all" })}>
                查看全部
              </Button>
            }
          />
        )
      ) : (
        <>
          <ul aria-label="跨版本问题" className="flex flex-col gap-3">
            {visible.map((issue) => (
              <IssueCard
                key={`${issue.kind}\u0000${issue.key}\u0000${issue.variants[0]?.en ?? ""}`}
                issue={issue}
                prVersions={prVersions}
                showTouched={pr !== undefined}
              />
            ))}
          </ul>
          <div className="flex items-center justify-center gap-3 text-xs text-muted">
            <span>
              {visible.length} / {filtered.length}
            </span>
            {visible.length < filtered.length && (
              <Button size="sm" onClick={() => setLimit((previous) => previous + PAGE)}>
                再显示 {Math.min(PAGE, filtered.length - visible.length)} 条
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AlignTable({
  rows,
  versions,
  prVersions,
  showTouched,
  layout,
}: {
  rows: readonly CrossVersionKeyRow[];
  versions: readonly string[];
  prVersions: ReadonlySet<string>;
  showTouched: boolean;
  layout: PairLayout;
}) {
  const columns = useMemo<Column<CrossVersionKeyRow>[]>(() => {
    const list: Column<CrossVersionKeyRow>[] = [
      {
        id: "key",
        header: "key",
        width: 280,
        cell: (row) => (
          <div className="flex flex-col items-start gap-1">
            <code className="break-all font-mono text-xs text-muted">{row.key}</code>
            {row.cells.length < versions.length && (
              <Badge tone="neutral" title="这个 key 只出现在部分版本里">
                仅 {row.cells.map((cell) => cell.version).join("、")} 有
              </Badge>
            )}
            {showTouched && row.touched && <Badge tone="accent">本 PR 改动</Badge>}
          </div>
        ),
      },
    ];
    if (layout === "stacked") {
      for (const version of versions) {
        list.push({
          id: version,
          header: <VersionChip version={version} highlight={prVersions.has(version)} />,
          width: 320,
          cell: (row) => <AlignCell row={row} version={version} />,
        });
      }
    } else {
      list.push({
        id: "pair",
        header: (
          <div className={PAIR_GRID}>
            <span>版本</span>
            <span>英文</span>
            <span>中文</span>
          </div>
        ),
        cell: (row) => <PairCell row={row} versions={versions} prVersions={prVersions} />,
      });
    }
    return list;
  }, [layout, prVersions, showTouched, versions]);

  // 实测估算：左右布局每版本子行约 29px、行内留白 8px；上下布局约 64px
  const rowHeight = layout === "stacked" ? 64 : 8 + 29 * versions.length;
  return (
    <DataTable ariaLabel="全部 key 对齐" columns={columns} rows={rows} rowKey={(row) => row.key} rowHeight={rowHeight} />
  );
}

function PairCell({
  row,
  versions,
  prVersions,
}: {
  row: CrossVersionKeyRow;
  versions: readonly string[];
  prVersions: ReadonlySet<string>;
}) {
  const reference = diffReferences(row);
  return (
    <div className="flex flex-col divide-y divide-line/60">
      {versions.map((version) => {
        const cell = row.cells.find((item) => item.version === version);
        return (
          <div key={version} className={cn(PAIR_GRID, "min-w-[560px] py-1 first:pt-0 last:pb-0")}>
            <VersionChip version={version} highlight={prVersions.has(version)} />
            {cell === undefined ? (
              <span className="col-span-2 text-muted">—</span>
            ) : (
              <>
                <EnText text={cell.en} reference={reference.en} />
                <ZhText text={cell.zh} reference={reference.zh} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function diffReferences(row: CrossVersionKeyRow): { en: string | null; zh: string | null } {
  const enDiffers = new Set(row.cells.map((item) => item.en)).size > 1;
  const zhDiffers = new Set(row.cells.map((item) => item.zh)).size > 1;
  return {
    en: enDiffers ? (row.cells[0]?.en ?? null) : null,
    zh: zhDiffers ? (row.cells.find((item) => item.zh !== null)?.zh ?? null) : null,
  };
}

function EnText({ text, reference }: { text: string; reference: string | null }) {
  return (
    <span className="min-w-0 break-words text-xs leading-5">
      <Highlight text={text} reference={reference} />
    </span>
  );
}

function ZhText({ text, reference }: { text: string | null; reference: string | null }) {
  return (
    <span className={cn("min-w-0 break-words text-sm", text === null && "italic text-muted")}>
      {text === null ? "未翻译" : <Highlight text={text} reference={reference} />}
    </span>
  );
}

function AlignCell({ row, version }: { row: CrossVersionKeyRow; version: string }) {
  const cell = row.cells.find((item) => item.version === version);
  if (cell === undefined) return <span className="text-muted">—</span>;
  const reference = diffReferences(row);
  return (
    <div className="flex flex-col gap-0.5">
      <EnText text={cell.en} reference={reference.en} />
      <ZhText text={cell.zh} reference={reference.zh} />
    </div>
  );
}

function VersionChip({ version, highlight }: { version: string; highlight: boolean }) {
  return (
    <span
      title={highlight ? "本 PR 修改了这个版本" : undefined}
      className={cn(
        "inline-flex h-5 w-fit items-center whitespace-nowrap rounded border px-1.5 font-mono text-xs",
        highlight ? "border-accent/50 bg-accent-soft font-medium text-accent" : "border-line bg-elevated text-muted",
      )}
    >
      {version}
    </span>
  );
}

function Highlight({ text, reference }: { text: string; reference: string | null }) {
  const [mode] = useDiffMode();
  if (mode === "off" || reference === null || reference === text) return <>{expandNewlines(text)}</>;
  const segments = inlineDiff(expandNewlines(reference), expandNewlines(text), mode);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "insert" ? (
          <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent">
            {segment.text}
          </mark>
        ) : segment.type === "delete" ? (
          <del key={index} className="rounded-sm px-0.5 text-muted/70 decoration-danger/60">
            {segment.text}
          </del>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function staleZh(variants: readonly CrossVersionVariant[]): boolean {
  const enByZh = new Map<string, Set<string>>();
  for (const variant of variants) {
    if (variant.zh === null) continue;
    const ens = enByZh.get(variant.zh) ?? new Set<string>();
    ens.add(variant.en);
    enByZh.set(variant.zh, ens);
  }
  return [...enByZh.values()].some((ens) => ens.size > 1);
}

function IssueCard({ issue, prVersions, showTouched }: { issue: CrossVersionIssue; prVersions: ReadonlySet<string>; showTouched: boolean }) {
  const [first] = issue.variants;
  const sameEn = issue.kind !== "changed";
  const stale = issue.kind === "changed" && staleZh(issue.variants);

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-panel)]">
      <header className="flex min-w-0 items-center gap-2 border-b border-line bg-elevated/35 px-4 py-2">
        <Badge tone={KIND_TONE[issue.kind]}>{KIND_LABEL[issue.kind]}</Badge>
        {stale && (
          <Badge tone="danger" title="英文改了，但有版本的中文和旧英文版本一模一样">
            译文没跟上
          </Badge>
        )}
        {showTouched && issue.touched && <Badge tone="accent">本 PR 改动</Badge>}
        <code className="min-w-0 truncate font-mono text-xs text-muted" title={issue.key}>
          {issue.key}
        </code>
      </header>
      <div className="flex flex-col gap-2 px-4 py-3">
        {sameEn && first !== undefined && (
          <p className="flex gap-3 text-sm">
            <span className="w-10 shrink-0 text-xs leading-5 text-muted">英文</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{expandNewlines(first.en)}</span>
          </p>
        )}
        <ul aria-label="各版本文本" className="flex flex-col gap-1.5">
          {issue.variants.map((variant, index) => {
            const previous = sameEn ? first : issue.variants[index - 1];
            return (
              <li key={`${variant.en}\u0000${variant.zh ?? "\u0001"}`} className="flex gap-3 rounded-md border border-line/60 bg-elevated/55 px-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-1">
                    {variant.versions.map((version) => (
                      <VersionChip key={version} version={version} highlight={prVersions.has(version)} />
                    ))}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                    {!sameEn && (
                      <p className="flex gap-3">
                        <span className="w-8 shrink-0 text-xs leading-5 text-muted">英文</span>
                        <span className="min-w-0 whitespace-pre-wrap break-words">
                          <Highlight text={variant.en} reference={index === 0 ? null : (previous?.en ?? null)} />
                        </span>
                      </p>
                    )}
                    <p className="flex gap-3">
                      <span className="w-8 shrink-0 text-xs leading-5 text-muted">中文</span>
                      <span className={cn("min-w-0 whitespace-pre-wrap break-words", variant.zh === null && "italic text-muted")}>
                        {variant.zh === null ? (
                          "未翻译"
                        ) : (
                          <Highlight text={variant.zh} reference={index === 0 ? null : (previous?.zh ?? null)} />
                        )}
                      </span>
                    </p>
                  </div>
                </div>
                {variant.zh !== null && <CopyButton text={variant.zh} />}
              </li>
            );
          })}
        </ul>
      </div>
    </li>
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
