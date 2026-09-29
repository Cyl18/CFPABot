import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, Play, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader.tsx";
import { PrStateBadge } from "@/components/StatusBadges.tsx";
import { api, errorMessage } from "@/lib/api.ts";
import { formatDateTime } from "@/lib/format.ts";
import { useMe, usePr, useRefreshPr } from "@/lib/queries.ts";
import { Badge, LabelChip } from "@/ui/Badge.tsx";
import { Button } from "@/ui/Button.tsx";
import { Card, CardBody } from "@/ui/Card.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";
import { tabClass } from "@/ui/Tabs.tsx";
import { CompareTab } from "@/routes/pr/CompareTab.tsx";
import { FilesTab } from "@/routes/pr/FilesTab.tsx";
import { OverviewTab } from "@/routes/pr/OverviewTab.tsx";
import { ReviewsTab } from "@/routes/pr/ReviewsTab.tsx";
import { SpecialTab } from "@/routes/pr/SpecialTab.tsx";

export type PrTab = "overview" | "files" | "compare" | "special" | "reviews";

const SUB_TABS: readonly { id: PrTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "files", label: "文件" },
  { id: "compare", label: "翻译比较" },
  { id: "special", label: "特殊文件" },
  { id: "reviews", label: "审查" },
];

export function PrDetailPage({ n, tab, ws }: { n: number; tab: PrTab; ws?: string }) {
  const { data: me } = useMe();
  const { data: pr, isPending, error, refetch } = usePr(n);
  const refresh = useRefreshPr(n);
  const navigate = useNavigate();

  const startReview = useMutation({
    mutationFn: () => api.createSession({ prNumber: n, review: true }),
    onSuccess: (session) => {
      void navigate({ to: "/agent/$id", params: { id: session.id } });
    },
  });

  if (!Number.isFinite(n) || n <= 0) return <ErrorState error={new Error("无效的 PR 编号")} />;
  if (error !== null) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !pr) return <SkeletonTable rows={8} columns={4} />;

  return (
    <>
      <PageHeader
        back={{ to: "/", label: "返回 PR 列表" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-accent">#{pr.number}</span>
            <span>{pr.title}</span>
            <PrStateBadge state={pr.state} draft={pr.draft} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>作者 {pr.author}</span>
            <span>·</span>
            <span className="font-mono">
              {pr.baseRef} ← {pr.headRepo}:{pr.headRef}
            </span>
            <span>·</span>
            <span>更新于 {formatDateTime(pr.updatedAt)}</span>
          </span>
        }
        actions={
          <>
            {pr.labels.map((label) => (
              <LabelChip key={label} label={label} />
            ))}
            <a
              href={pr.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-elevated px-2.5 text-sm hover:bg-line/60"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              GitHub
            </a>
            {me?.isAdmin === true && (
              <>
                <Button
                  size="sm"
                  icon={<RefreshCw aria-hidden="true" className="size-3.5" />}
                  loading={refresh.isPending}
                  onClick={() => refresh.mutate()}
                >
                  刷新信息评论
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Play aria-hidden="true" className="size-3.5" />}
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
        <Card className="mb-3">
          <CardBody className="text-xs text-danger">
            {refresh.isError && <p>刷新失败：{errorMessage(refresh.error)}</p>}
            {startReview.isError && <p>启动审查失败：{errorMessage(startReview.error)}</p>}
          </CardBody>
        </Card>
      )}

      <nav aria-label="PR 子页面" className="mb-3 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1">
        {SUB_TABS.map((item) => {
          const active = item.id === tab;
          const badge =
            item.id === "files" ? pr.files.length : item.id === "compare" ? pr.workspaces.length : item.id === "special" ? pr.specialFiles.length : undefined;
          const content = (
            <>
              {item.label}
              {badge !== undefined && <span className="text-xs tabular-nums opacity-70">{badge}</span>}
            </>
          );
          if (item.id === "overview") {
            return (
              <Link key={item.id} to="/pr/$n" params={{ n: String(n) }} className={tabClass(active)} aria-current={active ? "page" : undefined}>
                {content}
              </Link>
            );
          }
          return (
            <Link
              key={item.id}
              to="/pr/$n/$tab"
              params={{ n: String(n), tab: item.id }}
              search={item.id === "compare" ? { ws } : {}}
              className={tabClass(active)}
              aria-current={active ? "page" : undefined}
            >
              {content}
            </Link>
          );
        })}
        {pr.draft && <Badge tone="warn">草稿</Badge>}
      </nav>

      {tab === "overview" && <OverviewTab pr={pr} />}
      {tab === "files" && <FilesTab pr={pr} />}
      {tab === "compare" && <CompareTab n={n} workspaces={pr.workspaces} ws={ws} />}
      {tab === "special" && <SpecialTab n={n} paths={pr.specialFiles} />}
      {tab === "reviews" && <ReviewsTab n={n} />}
    </>
  );
}
