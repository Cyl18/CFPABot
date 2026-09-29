import { LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { loginUrl } from "@/lib/api.ts";
import { useMe } from "@/lib/queries.ts";
import { EmptyState } from "@/ui/EmptyState.tsx";
import { ErrorState } from "@/ui/ErrorState.tsx";
import { SkeletonTable } from "@/ui/Spinner.tsx";

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data: me, isPending, error, refetch } = useMe();

  if (isPending) return <SkeletonTable rows={5} columns={4} />;
  if (error !== null) return <ErrorState error={error} onRetry={() => void refetch()} />;

  if (me === null) {
    return (
      <EmptyState
        title="需要登录"
        description="此页面仅对仓库协作者开放，请先使用 GitHub 登录。"
        icon={<LogIn aria-hidden="true" className="size-6" />}
        action={
          <a
            href={loginUrl()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-transparent bg-accent px-3.5 text-sm font-medium text-accent-fg hover:brightness-110"
          >
            <LogIn aria-hidden="true" className="size-4" />
            使用 GitHub 登录
          </a>
        }
      />
    );
  }

  if (!me.isAdmin) {
    return <EmptyState title="需要管理员权限" description={`当前账号 ${me.login} 不是该仓库的协作者。`} />;
  }

  return <>{children}</>;
}
