import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { buttonClass } from "@/ui/Button.tsx";
import { EmptyState } from "@/ui/EmptyState.tsx";

export function NotFoundPage() {
  return (
    <EmptyState
      className="mt-16"
      icon={<Compass aria-hidden="true" className="size-6" />}
      title="页面未找到"
      description="你访问的页面不存在或已被移除。"
      action={
        <Link to="/" className={buttonClass("primary")}>
          返回 PR 列表
        </Link>
      }
    />
  );
}
