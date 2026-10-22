import type { SessionSummary } from "@shared/api.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Archive, ChevronsLeft, ChevronsRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatRelative } from "@/lib/format.ts";
import { qk, useSessions } from "@/lib/queries.ts";

const COLLAPSE_KEY = "cfpa-agent-sidebar";

function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

type Scope = "active" | "archived";

export function AgentLayout() {
  const sessions = useSessions();
  const client = useQueryClient();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [scope, setScope] = useState<Scope>("active");
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeId = pathname.startsWith("/agent/") ? pathname.slice("/agent/".length) : null;

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveSession(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.sessions }),
  });

  const rows = useMemo(
    () => (sessions.data ?? []).filter((session) => (scope === "active" ? !session.archived : session.archived)),
    [sessions.data, scope],
  );

  const toggle = (): void => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "collapsed" : "expanded");
      } catch {}
      return next;
    });
  };

  const row = (session: SessionSummary) => {
    const active = session.id === activeId;
    if (collapsed) {
      return (
        <Link
          key={session.id}
          to="/agent/$id"
          params={{ id: session.id }}
          title={session.title || session.id}
          className={cn("mx-auto my-1 grid size-7 place-items-center rounded-md", active ? "bg-accent-soft" : "hover:bg-elevated")}
        >
          <span className={cn("size-1.5 rounded-full", session.status === "running" ? "bg-warn" : "bg-muted")} />
        </Link>
      );
    }
    return (
      <div key={session.id} className={cn("group flex items-center rounded-md pr-1", active && "bg-accent-soft")}>
        <Link to="/agent/$id" params={{ id: session.id }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", session.status === "running" ? "bg-warn" : "bg-muted")} />
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-[13px]", active ? "text-accent" : "text-fg")}>{session.title || session.id}</span>
            <span className="block truncate text-[11px] text-muted">{formatRelative(session.updatedAt)}</span>
          </span>
        </Link>
        {!session.archived && (
          <button
            type="button"
            title="归档会话"
            aria-label="归档会话"
            onClick={() => archive.mutate(session.id)}
            className="grid size-6 shrink-0 place-items-center rounded text-muted opacity-0 transition-opacity hover:bg-elevated hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Archive aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex items-start gap-4">
      <aside
        aria-label="会话列表"
        className={cn(
          "sticky top-5 flex max-h-[calc(100dvh-6rem)] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-[width] duration-200",
          collapsed ? "w-11" : "w-60",
        )}
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-line p-1.5">
          <Link to="/agent" title="新建会话" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg">
            <Plus aria-hidden="true" className="size-4" />
          </Link>
          {!collapsed && <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">会话</span>}
          <button
            type="button"
            onClick={toggle}
            title={collapsed ? "展开会话栏" : "收起会话栏"}
            aria-expanded={!collapsed}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
          >
            {collapsed ? <ChevronsRight aria-hidden="true" className="size-4" /> : <ChevronsLeft aria-hidden="true" className="size-4" />}
          </button>
        </div>
        {!collapsed && (
          <div className="flex shrink-0 gap-1 border-b border-line px-1.5 py-1.5">
            {(["active", "archived"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setScope(item)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs transition-colors",
                  scope === item ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-fg",
                )}
              >
                {item === "active" ? "活跃" : "已归档"}
              </button>
            ))}
          </div>
        )}
        <nav className="scroll-thin flex-1 overflow-y-auto p-1.5">
          {sessions.isPending && <p className="px-2 py-1 text-xs text-muted">加载中…</p>}
          {sessions.isError && <p className="px-2 py-1 text-xs text-danger">会话加载失败</p>}
          {rows.length === 0 && !sessions.isPending && !sessions.isError && (
            <p className="px-2 py-1 text-xs text-muted">{scope === "active" ? "还没有会话" : "没有已归档会话"}</p>
          )}
          {rows.map(row)}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
