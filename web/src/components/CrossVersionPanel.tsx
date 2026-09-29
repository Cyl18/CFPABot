import type { CrossVersionIssue, CrossVersionIssueKind, CrossVersionKeyRow, CrossVersionVariant } from "@shared/api.ts";
import { diffChars, diffWordsWithSpace } from "diff";
import { Check, CircleCheck, Copy, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { expandNewlines } from "@/lib/format.ts";
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

type KindFilter = CrossVersionIssueKind | "all";
type View = "issues" | "keys";

const PAGE = 50;
const KEY_PAGE = 50;

const KINDS: readonly CrossVersionIssueKind[] = ["conflict", "changed", "untranslated"];

const VIEWS: readonly { id: View; label: string }[] = [
  { id: "issues", label: "跨版本问题" },
  { id: "keys", label: "全部 key 对齐" },
];

const KIND_LABEL: Record<KindFilter, string> = { conflict: "冲突", changed: "有变化", untranslated: "未翻译", all: "全部" };

const KIND_TONE: Record<CrossVersionIssueKind, BadgeTone> = { conflict: "danger", changed: "warn", untranslated: "info" };

export interface CrossVersionPanelProps {
  slug: string;
  namespace?: string;
  pr?: number;
  onNamespaceChange: (namespace: string) => void;
}

export function CrossVersionPanel({ slug, namespace, pr, onNamespaceChange }: CrossVersionPanelProps) {
  const [view, setView] = useState<View>("issues");
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  const [kind, setKind] = useState<KindFilter>("conflict");
  const [prOnly, setPrOnly] = useState(pr !== undefined);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [keyQuery, setKeyQuery] = useState("");
  const [keyOffset, setKeyOffset] = useState(0);

  const versions = useVersions(slug, { namespace, pr, versions: selection ?? undefined });
  const search = useDebounced(keyQuery, 200);
  const keys = useVersionsKeys(
    slug,
    { namespace, pr, versions: selection ?? undefined, q: search, offset: keyOffset, limit: KEY_PAGE },
    view === "keys",
  );

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
    const result: Record<KindFilter, number> = { conflict: 0, changed: 0, untranslated: 0, all: scoped.length };
    for (const issue of scoped) result[issue.kind] += 1;
    return result;
  }, [scoped]);

  const filtered = kind === "all" ? scoped : scoped.filter((issue) => issue.kind === kind);
  const visible = filtered.slice(0, limit);
  const touchedTotal = useMemo(() => (data?.issues ?? []).filter((issue) => issue.touched).length, [data]);

  const reset = () => {
    setLimit(PAGE);
    setKeyOffset(0);
  };

  const toggleVersion = (version: string) => {
    if (data === undefined) return;
    const next = activeVersions.includes(version)
      ? activeVersions.filter((item) => item !== version)
      : data.versions.filter((item) => item === version || activeVersions.includes(item));
    if (next.length === 0) return;
    setSelection(next.length === data.versions.length ? null : next);
    reset();
  };

  if (versions.error !== null) return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  if (data === undefined) return <SkeletonTable rows={6} columns={3} />;

  const hasIssues = activeVersions.length >= 2 && data.issues.length > 0;
  const keyData = keys.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <Tabs
            ariaLabel="视图"
            value={view}
            onChange={setView}
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
            <Input
              aria-label="搜索 key 或译文"
              placeholder="搜索 key / 英文 / 中文"
              icon={<Search />}
              wrapperClassName="w-full sm:w-72"
              value={keyQuery}
              onChange={(event) => {
                setKeyQuery(event.target.value);
                setKeyOffset(0);
              }}
            />
          ) : (
            hasIssues && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Tabs
                    ariaLabel="问题类型"
                    value={kind}
                    onChange={(next) => {
                      setKind(next);
                      reset();
                    }}
                    items={[...KINDS, "all" as const].map((id) => ({ id, label: `${KIND_LABEL[id]} ${counts[id]}` }))}
                  />
                  {pr !== undefined && (
                    <Checkbox
                      label="只看本 PR 改动的 key"
                      checked={prOnly}
                      onChange={(event) => {
                        setPrOnly(event.target.checked);
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
                      setQuery(event.target.value);
                      reset();
                    }}
                  />
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
        ) : keyData === undefined ? (
          <SkeletonTable rows={8} columns={3} />
        ) : keyData.total === 0 ? (
          <EmptyState
            icon={<Search aria-hidden="true" className="size-5" />}
            title="没有匹配的 key"
            description={keyQuery.trim() === "" ? "这个命名空间下没有可对齐的 key。" : "换个搜索词试试。"}
          />
        ) : (
          <>
            <AlignTable
              rows={keyData.rows}
              versions={activeVersions}
              prVersions={prVersions}
              showTouched={pr !== undefined}
            />
            <div className="flex items-center justify-center gap-3 text-xs text-muted">
              <Button size="sm" disabled={keyOffset === 0} onClick={() => setKeyOffset(Math.max(0, keyOffset - KEY_PAGE))}>
                上一页
              </Button>
              <span>
                {keyOffset + 1}–{keyOffset + keyData.rows.length} / {keyData.total}
              </span>
              <Button
                size="sm"
                disabled={keyOffset + keyData.rows.length >= keyData.total}
                onClick={() => setKeyOffset(keyOffset + KEY_PAGE)}
              >
                下一页
              </Button>
            </div>
          </>
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
            <Button size="sm" onClick={() => setView("keys")}>
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
              <Button size="sm" onClick={() => setPrOnly(false)}>
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
              <Button size="sm" onClick={() => setKind("all")}>
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

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function AlignTable({
  rows,
  versions,
  prVersions,
  showTouched,
}: {
  rows: readonly CrossVersionKeyRow[];
  versions: readonly string[];
  prVersions: ReadonlySet<string>;
  showTouched: boolean;
}) {
  const columns = useMemo<Column<CrossVersionKeyRow>[]>(
    () => [
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
      ...versions.map((version) => ({
        id: version,
        header: <VersionChip version={version} highlight={prVersions.has(version)} />,
        width: 320,
        cell: (row: CrossVersionKeyRow) => <AlignCell row={row} version={version} />,
      })),
    ],
    [prVersions, showTouched, versions],
  );

  return (
    <DataTable
      ariaLabel="全部 key 对齐"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      scroll="contained"
      height="70vh"
    />
  );
}

function AlignCell({ row, version }: { row: CrossVersionKeyRow; version: string }) {
  const cell = row.cells.find((item) => item.version === version);
  if (cell === undefined) return <span className="text-muted">—</span>;
  const enDiffers = new Set(row.cells.map((item) => item.en)).size > 1;
  const zhDiffers = new Set(row.cells.map((item) => item.zh)).size > 1;
  const zhReference = row.cells.find((item) => item.zh !== null)?.zh ?? null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs leading-5">
        <Highlight text={cell.en} reference={enDiffers ? (row.cells[0]?.en ?? null) : null} words />
      </span>
      <span className={cn("text-sm", cell.zh === null && "italic text-muted")}>
        {cell.zh === null ? "未翻译" : <Highlight text={cell.zh} reference={zhDiffers ? zhReference : null} words={false} />}
      </span>
    </div>
  );
}

function VersionChip({ version, highlight }: { version: string; highlight: boolean }) {
  return (
    <span
      title={highlight ? "本 PR 修改了这个版本" : undefined}
      className={cn(
        "inline-flex h-5 items-center whitespace-nowrap rounded border px-1.5 font-mono text-xs",
        highlight ? "border-accent/50 bg-accent-soft font-medium text-accent" : "border-line bg-elevated text-muted",
      )}
    >
      {version}
    </span>
  );
}

function Highlight({ text, reference, words }: { text: string; reference: string | null; words: boolean }) {
  if (reference === null || reference === text) return <>{expandNewlines(text)}</>;
  const left = expandNewlines(reference);
  const right = expandNewlines(text);
  const changes = words ? diffWordsWithSpace(left, right) : diffChars(left, right);
  return (
    <>
      {changes.map((change, index) =>
        change.added ? (
          <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent">
            {change.value}
          </mark>
        ) : change.removed ? (
          <del key={index} className="rounded-sm px-0.5 text-muted/70 decoration-danger/60">
            {change.value}
          </del>
        ) : (
          <span key={index}>{change.value}</span>
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
                          <Highlight text={variant.en} reference={index === 0 ? null : (previous?.en ?? null)} words />
                        </span>
                      </p>
                    )}
                    <p className="flex gap-3">
                      <span className="w-8 shrink-0 text-xs leading-5 text-muted">中文</span>
                      <span className={cn("min-w-0 whitespace-pre-wrap break-words", variant.zh === null && "italic text-muted")}>
                        {variant.zh === null ? (
                          "未翻译"
                        ) : (
                          <Highlight text={variant.zh} reference={index === 0 ? null : (previous?.zh ?? null)} words={false} />
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
