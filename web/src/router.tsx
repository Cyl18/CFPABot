import { createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell.tsx";
import { RequireAdmin } from "@/components/RequireAdmin.tsx";
import { parseSearch, stringifySearch, type ModsSearch, type PrListSearch, type PrSearch, type VersionsSearch } from "@/lib/search.ts";
import { AdminPage, type AdminTab } from "@/routes/admin/AdminPage.tsx";
import { SessionPage } from "@/routes/agent/SessionPage.tsx";
import { CommandsPage } from "@/routes/CommandsPage.tsx";
import { ComparePage } from "@/routes/ComparePage.tsx";
import { ModsPage } from "@/routes/ModsPage.tsx";
import { NotFoundPage } from "@/routes/NotFoundPage.tsx";
import { PrDetailPage, type PrTab } from "@/routes/PrDetailPage.tsx";
import { PrListPage } from "@/routes/PrListPage.tsx";
import { SessionListPage } from "@/routes/agent/SessionListPage.tsx";
import { VersionsPage } from "@/routes/VersionsPage.tsx";

const PR_TABS: readonly PrTab[] = ["overview", "files", "compare", "versions", "special", "reviews"];
const ADMIN_TABS: readonly AdminTab[] = ["status", "llm", "mappings", "logs", "cache"];

const PR_SEARCH_KEYS = ["ws", "slug", "ns", "status", "mode", "overlay", "file", "layout", "view", "versions", "kind", "prOnly", "q", "kq"] as const;

function pickStrings<T extends string>(search: Record<string, unknown>, keys: readonly T[]): Partial<Record<T, string>> {
  const result: Partial<Record<T, string>> = {};
  for (const key of keys) {
    const value = search[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): PrListSearch => pickStrings(search, ["state", "q", "labels"]),
  component: PrListRoot,
});

const prRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$n",
  validateSearch: (search: Record<string, unknown>): PrSearch => pickStrings(search, PR_SEARCH_KEYS),
});

const prIndexRoute = createRoute({ getParentRoute: () => prRoute, path: "/", component: PrOverviewRoot });

const prTabRoute = createRoute({ getParentRoute: () => prRoute, path: "$tab", component: PrTabRoot });

const versionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/versions/$slug",
  validateSearch: (search: Record<string, unknown>): VersionsSearch => pickStrings(search, ["namespace", "view", "versions", "kind", "q", "kq"]),
  component: VersionsRoot,
});

const compareRoute = createRoute({ getParentRoute: () => rootRoute, path: "/compare", component: ComparePage });

const modsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mods",
  validateSearch: (search: Record<string, unknown>): ModsSearch => pickStrings(search, ["q"]),
  component: ModsRoot,
});

const commandsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/commands", component: CommandsPage });
const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent", component: AgentRoot });
const agentSessionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent/$id", component: AgentSessionRoot });

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  validateSearch: (search: Record<string, unknown>): { tab?: string } => (typeof search.tab === "string" ? { tab: search.tab } : {}),
  component: AdminRoot,
});

function PrListRoot() {
  const search = indexRoute.useSearch();
  const navigate = useNavigate();
  return (
    <PrListPage
      search={search}
      onSearchChange={(patch) => void navigate({ to: "/", search: (prev: PrListSearch) => ({ ...prev, ...patch }), replace: true })}
    />
  );
}

function PrOverviewRoot() {
  const { n } = prRoute.useParams();
  const navigate = useNavigate();
  return (
    <PrDetailPage
      n={Number(n)}
      tab="overview"
      search={{}}
      onSearchChange={(patch) => void navigate({ to: "/pr/$n", params: { n }, search: (prev: PrSearch) => ({ ...prev, ...patch }), replace: true })}
    />
  );
}

function PrTabRoot() {
  const { n } = prRoute.useParams();
  const { tab } = prTabRoute.useParams();
  const search = prTabRoute.useSearch();
  const navigate = useNavigate();
  const resolved = PR_TABS.find((item) => item === tab) ?? "overview";
  return (
    <PrDetailPage
      n={Number(n)}
      tab={resolved}
      search={search}
      onSearchChange={(patch) => void navigate({ to: "/pr/$n/$tab", params: { n, tab: resolved }, search: (prev: PrSearch) => ({ ...prev, ...patch }), replace: true })}
    />
  );
}

function VersionsRoot() {
  const { slug } = versionsRoute.useParams();
  const search = versionsRoute.useSearch();
  const navigate = useNavigate();
  return (
    <VersionsPage
      slug={slug}
      search={search}
      onSearchChange={(patch) => void navigate({ to: "/versions/$slug", params: { slug }, search: (prev: VersionsSearch) => ({ ...prev, ...patch }), replace: true })}
    />
  );
}

function ModsRoot() {
  const search = modsRoute.useSearch();
  const navigate = useNavigate();
  return <ModsPage query={search.q ?? ""} onSearchChange={(patch) => void navigate({ to: "/mods", search: (prev: ModsSearch) => ({ ...prev, ...patch }), replace: true })} />;
}

function AgentRoot() {
  return (
    <RequireAdmin>
      <SessionListPage />
    </RequireAdmin>
  );
}

function AgentSessionRoot() {
  const { id } = agentSessionRoute.useParams();
  return (
    <RequireAdmin>
      <SessionPage id={id} />
    </RequireAdmin>
  );
}

function AdminRoot() {
  const { tab } = adminRoute.useSearch();
  const navigate = useNavigate();
  const resolved = ADMIN_TABS.find((item) => item === tab) ?? "status";
  return (
    <RequireAdmin>
      <AdminPage tab={resolved} onTabChange={(next) => void navigate({ to: "/admin", search: { tab: next } })} />
    </RequireAdmin>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  prRoute.addChildren([prIndexRoute, prTabRoute]),
  versionsRoute,
  compareRoute,
  modsRoute,
  commandsRoute,
  agentRoute,
  agentSessionRoute,
  adminRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent", defaultPreloadStaleTime: 0, parseSearch, stringifySearch });
