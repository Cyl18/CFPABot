import type { SessionSummary } from "@shared/api.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Archive, ChevronsLeft, ChevronsRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { formatRelative } from "@/lib/format.ts";
import { qk, useSessions } from "@/lib/queries.ts";
import { Tabs, type TabItem } from "@/ui/Tabs.tsx";

type Scope = "active" | "archived";

const SCOPES: readonly TabItem<Scope>[] = [
  { id: "active", label: "活跃" },
  { id: "archived", label: "已归档" },
];

const COLLAPSE_KEY = "cfpa-agent-sidebar";

function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function statusDot(session: SessionSummary): string {
  if (session.status === "running") return "animate-pulse bg-warn";
  if (session.lastError !== undefined) return "bg-danger";
  return "bg-muted/50";
}

function SessionRow({
  session,
  active,
  collapsed,
  onArchive,
}: {
  session: SessionSummary;
  active: boolean;
  collapsed: boolean;
  onArchive: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex w-52 shrink-0 items-center rounded-md pr-1 md:w-auto",
        collapsed && "md:w-7 md:justify-center md:pr-0",
        active && "bg-accent-soft",
      )}
    >
      <Link
        to="/agent/$id"
        params={{ id: session.id }}
        title={collapsed ? session.title || session.id : undefined}
        className={cn("flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5", collapsed && "md:justify-center md:px-0")}
      >
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", statusDot(session))} />
        <span className={cn("min-w-0 flex-1", collapsed && "md:hidden")}>
          <span className={cn("block truncate text-[13px]", active ? "text-accent" : "text-fg")}>{session.title || session.id}</span>
          <span className="flex items-center gap-1.5 truncate text-[11px] text-muted">
            <span>{formatRelative(session.updatedAt)}</span>
            {session.prNumber !== undefined && <span className="font-mono">#{session.prNumber}</span>}
            {session.draft !== undefined && <span>· {session.draft.comments} 条评论</span>}
          </span>
        </span>
      </Link>
      {!session.archived && (
        <button
          type="button"
          title="归档会话"
          aria-label="归档会话"
          onClick={onArchive}
          className={cn(
            "hidden size-6 shrink-0 place-items-center rounded text-muted transition-opacity hover:bg-elevated hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 md:grid md:opacity-0",
            collapsed && "md:hidden",
          )}
        >
          <Archive aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function AgentLayout() {
  const sessions = useSessions();
  const client = useQueryClient();
  const [scope, setScope] = useState<Scope>("active");
  const [collapsed, setCollapsed] = useState(initialCollapsed);
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

  const toggle = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "collapsed" : "expanded");
      } catch {}
      return next;
    });
  };

  return (
    <div className="flex h-[calc(100dvh-6rem)] flex-col gap-3 md:flex-row lg:h-[calc(100dvh-2.5rem)]">
      <aside
        aria-label="会话列表"
        className={cn(
          "flex min-h-0 shrink-0 flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-lg md:border md:border-line md:bg-surface",
          collapsed ? "md:w-11" : "md:w-56",
        )}
      >
        <div className={cn("flex flex-col gap-2 md:border-b md:border-line md:p-2", collapsed && "md:hidden")}>
          <div className="flex items-center gap-1.5">
            <Link
              to="/agent"
              title="新建会话"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg hover:bg-elevated"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              新建
            </Link>
            <div className="ml-auto md:hidden">
              <Tabs items={SCOPES} value={scope} onChange={setScope} ariaLabel="会话范围" />
            </div>
            <button
              type="button"
              onClick={toggle}
              title="收起会话栏"
              aria-label="收起会话栏"
              aria-expanded={true}
              className="ml-auto hidden size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg md:grid"
            >
              <ChevronsLeft aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="hidden md:block">
            <Tabs items={SCOPES} value={scope} onChange={setScope} ariaLabel="会话范围" className="w-full" />
          </div>
        </div>

        {collapsed && (
          <div className="hidden shrink-0 flex-col items-center gap-1 border-b border-line p-1.5 md:flex">
            <Link
              to="/agent"
              title="新建会话"
              className="grid size-8 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
            >
              <Plus aria-hidden="true" className="size-4" />
            </Link>
            <button
              type="button"
              onClick={toggle}
              title="展开会话栏"
              aria-label="展开会话栏"
              aria-expanded={false}
              className="grid size-8 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
            >
              <ChevronsRight aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}

        <nav className="scroll-thin flex gap-1.5 overflow-x-auto pb-1 md:min-h-0 md:flex-1 md:flex-col md:gap-0.5 md:overflow-x-hidden md:overflow-y-auto md:p-1.5">
          {sessions.isPending && <p className={cn("px-2 py-1 text-xs text-muted", collapsed && "md:hidden")}>加载中…</p>}
          {sessions.isError && <p className={cn("px-2 py-1 text-xs text-danger", collapsed && "md:hidden")}>会话加载失败</p>}
          {rows.length === 0 && !sessions.isPending && !sessions.isError && (
            <p className={cn("px-2 py-1 text-xs text-muted", collapsed && "md:hidden")}>{scope === "active" ? "还没有会话" : "没有已归档会话"}</p>
          )}
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeId}
              collapsed={collapsed}
              onArchive={() => archive.mutate(session.id)}
            />
          ))}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
