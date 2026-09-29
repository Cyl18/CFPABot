import { LogIn, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn.ts";
import { errorMessage, isApiError, loginUrl } from "@/lib/api.ts";
import { Button } from "@/ui/Button.tsx";

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}

export function ErrorState({ error, onRetry, title, className }: ErrorStateProps) {
  const unauthorized = isApiError(error) && error.status === 401;
  const notFound = isApiError(error) && error.status === 404;
  const heading = unauthorized ? "需要登录" : notFound ? "未找到" : (title ?? "加载失败");

  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-8 text-center", className)}
    >
      <TriangleAlert aria-hidden="true" className="size-5 text-danger" />
      <div>
        <p className="text-sm font-semibold">{heading}</p>
        <p className="mt-1 max-w-lg text-xs text-muted">
          {unauthorized ? "此页面需要管理员权限，登录后重试。" : errorMessage(error)}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {unauthorized && (
          <a
            href={loginUrl()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-transparent bg-accent px-3.5 text-sm font-medium text-accent-fg hover:brightness-110"
          >
            <LogIn aria-hidden="true" className="size-4" />
            使用 GitHub 登录
          </a>
        )}
        {onRetry !== undefined && (
          <Button onClick={onRetry} icon={<RefreshCw aria-hidden="true" className="size-3.5" />}>
            重试
          </Button>
        )}
      </div>
    </div>
  );
}
