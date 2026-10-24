import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Clock, ExternalLink, GitBranch, Play, RefreshCw, User } from "lucide-react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { ReviewFailure, ReviewSubmit } from "@/components/Review.tsx";
import { PrStateBadge } from "@/components/StatusBadges.tsx";
import { ReviewProvider } from "@/hooks/useReview.tsx";
import { api, errorMessage } from "@/lib/api.ts";
import { formatDateTime, formatRelative } from "@/lib/format.ts";
import { useMe, usePr, useRefreshPr, useRefreshStatus } from "@/lib/queries.ts";
import type { PrSearch, SearchPatch } from "@/lib/search.ts";
import { LabelChip, orderLabels } from "@/ui/Badge.tsx";
import { Button, buttonClass } from "@/ui/Button.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { tabClass, tabListClass } from "@/ui/Tabs.tsx";
import { CompareTab } from "@/routes/pr/CompareTab.tsx";
import { FilesTab } from "@/routes/pr/FilesTab.tsx";
import { OverviewTab } from "@/routes/pr/OverviewTab.tsx";
import { ReviewsTab } from "@/routes/pr/ReviewsTab.tsx";
import { SpecialTab } from "@/routes/pr/SpecialTab.tsx";
import { VersionsTab } from "@/routes/pr/VersionsTab.tsx";

export type PrTab = "overview" | "files" | "compare" | "versions" | "special" | "reviews";

const SUB_TABS: readonly { id: PrTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "files", label: "文件" },
  { id: "compare", label: "翻译比较" },
  { id: "versions", label: "跨版本" },
  { id: "special", label: "特殊文件" },
  { id: "reviews", label: "审查" },
];

export function PrDetailPage({ n, tab, search, onSearchChange }: { n: number; tab: PrTab; search: PrSearch; onSearchChange: (patch: SearchPatch) => void }) {
  const { data: me } = useMe();
  const { data: pr, isPending, error, refetch } = usePr(n);
  const refresh = useRefreshPr(n);
  const status = useRefreshStatus(n, me?.isAdmin === true);
  const running = status.data?.running === true;
  const navigate = useNavigate();

  const startReview = useMutation({
    mutationFn: () => api.createSession({ message: `审查 PR #${n}`, prNumber: n }),
    onSuccess: (session) => {
      void navigate({ to: "/agent/$id", params: { id: session.id } });
    },
  });

  if (!Number.isFinite(n) || n <= 0) return <ErrorState error={new Error("无效的 PR 编号")} />;
  if (error !== null) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !pr) return <SkeletonTable rows={8} columns={4} />;

  return (
    <ReviewProvider n={n}>
      <PageHeader
        back={{ to: "/", label: "返回 PR 列表" }}
        title={
          <>
            <span className="mr-2 font-mono font-normal text-muted">#{pr.number}</span>
            {pr.title}
          </>
        }
        description={
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <PrStateBadge state={pr.state} draft={pr.draft} labels={pr.labels} />
              <span className="inline-flex items-center gap-1.5">
                <User aria-hidden="true" className="size-3.5" />
                <span className="text-fg">{pr.author}</span>
              </span>
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={`${pr.headRepo}:${pr.headRef} → ${pr.baseRef}`}>
                <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
                <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-fg">{pr.baseRef}</code>
                <span aria-hidden="true">←</span>
                <code className="min-w-0 truncate rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-fg">
                  {pr.headRepo}:{pr.headRef}
                </code>
              </span>
              <span className="inline-flex items-center gap-1.5" title={formatDateTime(pr.updatedAt)}>
                <Clock aria-hidden="true" className="size-3.5" />
                更新于 {formatRelative(pr.updatedAt)}
              </span>
            </div>
            {pr.labels.length > 0 && (
              <ul aria-label="标签" className="flex flex-wrap gap-1">
                {orderLabels(pr.labels).map((label) => (
                  <li key={label} className="min-w-0 max-w-full">
                    <LabelChip label={label} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        }
        actions={
          <>
            <a href={pr.htmlUrl} target="_blank" rel="noreferrer noopener" className={buttonClass()}>
              <ExternalLink aria-hidden="true" className="size-4" />
              GitHub
            </a>
            <ReviewSubmit author={pr.author} />
            {me?.isAdmin === true && (
              <>
                <Button
                  icon={<RefreshCw aria-hidden="true" className="size-4" />}
                  loading={refresh.isPending || running}
                  onClick={() => refresh.mutate()}
                >
                  刷新信息评论
                </Button>
                <Button
                  variant="primary"
                  icon={<Play aria-hidden="true" className="size-4" />}
                  loading={startReview.isPending}
                  onClick={() => startReview.mutate()}
                >
                  开始审查
                </Button>
              </>
            )}
          </>
        }
      />

      {(refresh.isError || startReview.isError) && (
        <div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2.5 text-xs text-danger">
          {refresh.isError && <p>刷新失败：{errorMessage(refresh.error)}</p>}
          {startReview.isError && <p>启动审查失败：{errorMessage(startReview.error)}</p>}
        </div>
      )}
      <ReviewFailure />

      <nav aria-label="PR 子页面" className={tabListClass("underline", "mb-5")}>
        {SUB_TABS.map((item) => {
          const active = item.id === tab;
          const badge =
            item.id === "files" ? pr.files.length : item.id === "compare" ? pr.workspaces.length : item.id === "special" ? pr.specialFiles.length : undefined;
          const content = (
            <>
              {item.label}
              {badge !== undefined && (
                <span className="rounded-full bg-elevated px-1.5 text-xs font-normal tabular-nums leading-5 text-muted">{badge}</span>
              )}
            </>
          );
          if (item.id === "overview") {
            return (
              <Link key={item.id} to="/pr/$n" params={{ n: String(n) }} className={tabClass(active, "underline")} aria-current={active ? "page" : undefined}>
                {content}
              </Link>
            );
          }
          return (
            <Link
              key={item.id}
              to="/pr/$n/$tab"
              params={{ n: String(n), tab: item.id }}
              search={item.id === "compare" ? { ws: search.ws } : item.id === "versions" ? { slug: search.slug, ns: search.ns } : {}}
              className={tabClass(active, "underline")}
              aria-current={active ? "page" : undefined}
            >
              {content}
            </Link>
          );
        })}
      </nav>

      {tab === "overview" && <OverviewTab pr={pr} />}
      {tab === "files" && <FilesTab pr={pr} search={search} onSearchChange={onSearchChange} />}
      {tab === "compare" && <CompareTab n={n} files={pr.files} workspaces={pr.workspaces} search={search} onSearchChange={onSearchChange} />}
      {tab === "versions" && <VersionsTab n={n} slugs={pr.slugs} search={search} onSearchChange={onSearchChange} />}
      {tab === "special" && <SpecialTab n={n} paths={pr.specialFiles} search={search} onSearchChange={onSearchChange} />}
      {tab === "reviews" && <ReviewsTab n={n} />}
    </ReviewProvider>
  );
}
