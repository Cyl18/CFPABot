import type { SessionSummary } from "@cfpa/contracts/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Archive, Plus } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { useSessionsFeed } from "@/hooks/useSessionEvents.ts";
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

const OPEN_KEY = "cfpa-agent-sidebar-open";

function initialOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "closed";
  } catch {
    return true;
  }
}

function statusDot(session: SessionSummary): string {
  if (session.status === "running") return "animate-pulse bg-warn";
  if (session.lastError !== undefined) return "bg-danger";
  return "bg-muted/50";
}

type AgentSidebarValue = { open: boolean; toggle: () => void };

const AgentSidebarContext = createContext<AgentSidebarValue | null>(null);

export function useAgentSidebar(): AgentSidebarValue {
  const value = useContext(AgentSidebarContext);
  if (value === null) throw new Error("useAgentSidebar must be used inside AgentLayout");
  return value;
}

function SessionRow({ session, active, onArchive }: { session: SessionSummary; active: boolean; onArchive: () => void }) {
  return (
    <div className={cn("agent-fade group flex w-52 shrink-0 items-center rounded-md pr-1 md:w-auto", active && "bg-accent-soft")}>
      <Link
        to="/agent/$id"
        params={{ id: session.id }}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
      >
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", statusDot(session))} />
        <span className="min-w-0 flex-1">
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
          className="hidden size-6 shrink-0 place-items-center rounded text-muted transition-opacity hover:bg-elevated hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 md:grid md:opacity-0"
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
  useSessionsFeed(() => {
    void client.invalidateQueries({ queryKey: qk.sessions });
  });
  const [scope, setScope] = useState<Scope>("active");
  const [open, setOpen] = useState(initialOpen);
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
    setOpen((value) => {
      const next = !value;
      try {
        localStorage.setItem(OPEN_KEY, next ? "open" : "closed");
      } catch {}
      return next;
    });
  };

  return (
    <AgentSidebarContext.Provider value={{ open, toggle }}>
      <div
        className={cn(
          "flex h-[calc(100dvh-6rem)] flex-col gap-3 md:flex-row md:transition-[gap] md:duration-200 motion-reduce:transition-none lg:h-[calc(100dvh-2.5rem)]",
          !open && "md:gap-0",
        )}
      >
        <aside
          aria-label="会话列表"
          className={cn(
            "flex min-h-0 shrink-0 flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-lg md:bg-surface md:transition-[width,border-width,visibility] md:duration-200 motion-reduce:transition-none",
            open ? "md:w-64 md:border md:border-line" : "md:invisible md:w-0 md:border-0",
          )}
        >
          <div className="flex flex-col gap-2 md:border-b md:border-line md:p-2">
            <div className="flex items-center gap-1.5">
              <Link
                to="/agent"
                activeOptions={{ exact: true }}
                title="新建会话"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg hover:bg-elevated"
              >
                <Plus aria-hidden="true" className="size-3.5" />
                新建
              </Link>
              <div className="ml-auto md:hidden">
                <Tabs items={SCOPES} value={scope} onChange={setScope} ariaLabel="会话范围" />
              </div>
            </div>
            <div className="hidden md:block">
              <Tabs items={SCOPES} value={scope} onChange={setScope} ariaLabel="会话范围" className="w-full" />
            </div>
          </div>

          <nav className="scroll-thin flex gap-1.5 overflow-x-auto pb-1 md:min-h-0 md:flex-1 md:flex-col md:gap-0.5 md:overflow-x-hidden md:overflow-y-auto md:p-1.5">
            {sessions.isPending && <p className="px-2 py-1 text-xs text-muted">加载中…</p>}
            {sessions.isError && <p className="px-2 py-1 text-xs text-danger">会话加载失败</p>}
            {rows.length === 0 && !sessions.isPending && !sessions.isError && (
              <p className="px-2 py-1 text-xs text-muted">{scope === "active" ? "还没有会话" : "没有已归档会话"}</p>
            )}
            {rows.map((session) => (
              <SessionRow key={session.id} session={session} active={session.id === activeId} onArchive={() => archive.mutate(session.id)} />
            ))}
          </nav>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </AgentSidebarContext.Provider>
  );
}
