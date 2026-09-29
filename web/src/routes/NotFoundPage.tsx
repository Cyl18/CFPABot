import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { EmptyState } from "@/ui/EmptyState.tsx";

export function NotFoundPage() {
  return (
    <EmptyState
      className="mt-16"
      icon={<Compass aria-hidden="true" className="size-6" />}
      title="页面未找到"
      description="你访问的页面不存在或已被移除。"
      action={
        <Link to="/" className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg hover:brightness-110">
          返回 PR 列表
        </Link>
      }
    />
  );
}
