import { createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell.tsx";
import { RequireAdmin } from "@/components/RequireAdmin.tsx";
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

const PR_TABS: readonly PrTab[] = ["overview", "files", "compare", "special", "reviews"];
const ADMIN_TABS: readonly AdminTab[] = ["status", "llm", "mappings", "logs", "cache"];

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: PrListPage });

const prRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$n",
  validateSearch: (search: Record<string, unknown>): { ws?: string } => (typeof search.ws === "string" ? { ws: search.ws } : {}),
});

const prIndexRoute = createRoute({ getParentRoute: () => prRoute, path: "/", component: PrOverviewRoot });

const prTabRoute = createRoute({ getParentRoute: () => prRoute, path: "$tab", component: PrTabRoot });

const versionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/versions/$slug",
  validateSearch: (search: Record<string, unknown>): { namespace?: string; pr?: number } => ({
    ...(typeof search.namespace === "string" ? { namespace: search.namespace } : {}),
    ...(typeof search.pr === "number" ? { pr: search.pr } : typeof search.pr === "string" && search.pr !== "" ? { pr: Number(search.pr) } : {}),
  }),
  component: VersionsRoot,
});

const compareRoute = createRoute({ getParentRoute: () => rootRoute, path: "/compare", component: ComparePage });
const modsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/mods", component: ModsPage });
const commandsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/commands", component: CommandsPage });
const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent", component: AgentRoot });
const agentSessionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent/$id", component: AgentSessionRoot });

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  validateSearch: (search: Record<string, unknown>): { tab?: string } => (typeof search.tab === "string" ? { tab: search.tab } : {}),
  component: AdminRoot,
});

function PrOverviewRoot() {
  const { n } = prRoute.useParams();
  return <PrDetailPage n={Number(n)} tab="overview" />;
}

function PrTabRoot() {
  const { n } = prRoute.useParams();
  const { tab } = prTabRoute.useParams();
  const { ws } = prTabRoute.useSearch();
  const resolved = PR_TABS.find((item) => item === tab) ?? "overview";
  return <PrDetailPage n={Number(n)} tab={resolved} ws={ws} />;
}

function VersionsRoot() {
  const { slug } = versionsRoute.useParams();
  const { namespace, pr } = versionsRoute.useSearch();
  return <VersionsPage slug={slug} namespace={namespace} pr={pr} />;
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

export const router = createRouter({ routeTree, defaultPreload: "intent", defaultPreloadStaleTime: 0 });
