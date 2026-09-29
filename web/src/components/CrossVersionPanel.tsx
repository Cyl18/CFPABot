import type { CrossVersionIssue, CrossVersionIssueKind, CrossVersionVariant } from "@shared/api.ts";
import { diffChars, diffWordsWithSpace } from "diff";
import { Check, CircleCheck, Copy, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { useVersions } from "@/lib/queries.ts";
import { Badge, type BadgeTone } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { Checkbox, Input } from "@/ui/Input.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { Tabs } from "@/ui/Tabs.tsx";
import { ToggleChip } from "@/ui/ToggleChip.tsx";

type KindFilter = CrossVersionIssueKind | "all";

const PAGE = 50;

const KINDS: readonly CrossVersionIssueKind[] = ["conflict", "changed", "untranslated"];

const KIND_LABEL: Record<KindFilter, string> = { conflict: "冲突", changed: "有变化", untranslated: "未翻译", all: "全部" };

const KIND_TONE: Record<CrossVersionIssueKind, BadgeTone> = { conflict: "danger", changed: "warn", untranslated: "info" };

export interface CrossVersionPanelProps {
  slug: string;
  namespace?: string;
  pr?: number;
  onNamespaceChange: (namespace: string) => void;
}

export function CrossVersionPanel({ slug, namespace, pr, onNamespaceChange }: CrossVersionPanelProps) {
  const versions = useVersions(slug, namespace, pr);
  const [kind, setKind] = useState<KindFilter>("conflict");
  const [prOnly, setPrOnly] = useState(pr !== undefined);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const data = versions.data;
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

  const reset = () => setLimit(PAGE);

  if (versions.error !== null) return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  if (versions.isPending || !data) return <SkeletonTable rows={6} columns={3} />;

  const hasIssues = data.versions.length >= 2 && data.issues.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-3">
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
              <VersionChip key={version} version={version} highlight={prVersions.has(version)} />
            ))}
            <span className="ml-1 text-xs text-muted">· {data.keyCount} 个 key</span>
          </div>

          {hasIssues && (
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
          )}
        </CardBody>
      </Card>

      {data.versions.length < 2 ? (
        <EmptyState
          title="只有一个版本，无从比较"
          description={`${data.namespace} 目前只有 ${data.versions[0] ?? "—"} 这一个版本的语言文件。出现第二个版本后，这里会列出跨版本的冲突、变化和未翻译。`}
        />
      ) : !hasIssues ? (
        <EmptyState
          icon={<CircleCheck aria-hidden="true" className="size-5 text-ok" />}
          title="各版本一致"
          description={`${data.versions.length} 个版本、${data.keyCount} 个 key 里没有发现冲突、英文变化或未翻译。`}
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

function VersionChip({ version, highlight }: { version: string; highlight: boolean }) {
  return (
    <span
      title={highlight ? "本 PR 修改了这个版本" : undefined}
      className={cn(
        "inline-flex h-5 items-center whitespace-nowrap rounded border px-1.5 font-mono text-xs",
        highlight ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-elevated text-muted",
      )}
    >
      {version}
    </span>
  );
}

function Highlight({ text, reference, words }: { text: string; reference: string | null; words: boolean }) {
  if (reference === null || reference === text) return <>{text}</>;
  const changes = words ? diffWordsWithSpace(reference, text) : diffChars(reference, text);
  return (
    <>
      {changes.map((change, index) =>
        change.added ? (
          <mark key={index} className="rounded-sm bg-warn/20 px-0.5 text-warn">
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
    <li className="rounded-lg border border-line bg-surface">
      <header className="flex min-w-0 items-center gap-2 border-b border-line px-4 py-2">
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
            <span className="min-w-0 whitespace-pre-wrap break-words">{first.en}</span>
          </p>
        )}
        <ul aria-label="各版本文本" className="flex flex-col gap-1.5">
          {issue.variants.map((variant, index) => {
            const previous = sameEn ? first : issue.variants[index - 1];
            return (
              <li key={`${variant.en}\u0000${variant.zh ?? "\u0001"}`} className="flex gap-3 rounded-md bg-elevated/60 px-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
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
                  <span className="flex shrink-0 flex-wrap items-center gap-1 sm:max-w-[45%] sm:justify-end">
                    {variant.versions.map((version) => (
                      <VersionChip key={version} version={version} highlight={prVersions.has(version)} />
                    ))}
                  </span>
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
