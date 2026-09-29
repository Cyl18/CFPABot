import type { CheckReport, CompareResult, CrossVersionResult, LlmConfigView, LogEntry, LogLevel, Me, ModList, ModSourceResult, PrDetail, PrState, PrSummary, SessionDetail, SessionSummary, SpecialFile, SystemStatus } from "@shared/api.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CompareKey } from "@/lib/api.ts";

export const qk = {
  me: ["me"] as const,
  status: ["status"] as const,
  prs: (state: PrState | "all") => ["prs", state] as const,
  pr: (n: number) => ["pr", n] as const,
  checks: (n: number) => ["checks", n] as const,
  compare: (n: number, key: string) => ["compare", n, key] as const,
  modSource: (n: number, key: string) => ["mod-source", n, key] as const,
  special: (n: number) => ["special", n] as const,
  versions: (slug: string, namespace: string, pr: number | undefined) => ["versions", slug, namespace, pr ?? null] as const,
  mods: (q: string) => ["mods", q] as const,
  sessions: ["sessions"] as const,
  session: (id: string) => ["session", id] as const,
  llm: ["llm"] as const,
  logs: (level: LogLevel | "all") => ["logs", level] as const,
  mappings: ["mappings"] as const,
};

export function useMe() {
  return useQuery<Me | null>({ queryKey: qk.me, queryFn: ({ signal }) => api.me(signal), staleTime: 60_000, retry: 0 });
}

export function useStatus(enabled = true) {
  return useQuery<SystemStatus>({ queryKey: qk.status, queryFn: ({ signal }) => api.status(signal), enabled, retry: 0 });
}

export function usePrs(state: PrState | "all") {
  return useQuery<PrSummary[]>({ queryKey: qk.prs(state), queryFn: ({ signal }) => api.prs(state, signal) });
}

export function usePr(n: number) {
  return useQuery<PrDetail>({ queryKey: qk.pr(n), queryFn: ({ signal }) => api.pr(n, signal), enabled: Number.isFinite(n) && n > 0 });
}

export function useChecks(n: number, enabled = true) {
  return useQuery<CheckReport | null>({ queryKey: qk.checks(n), queryFn: ({ signal }) => api.checks(n, signal), enabled });
}

export function useCompare(n: number, key: CompareKey | null) {
  const id = key ? `${key.slug}/${key.version}/${key.namespace}` : "";
  return useQuery<CompareResult>({
    queryKey: qk.compare(n, id),
    queryFn: ({ signal }) => api.compare(n, key as CompareKey, signal),
    enabled: key !== null,
  });
}

export function useModSource(n: number, key: CompareKey | null, enabled: boolean) {
  const id = key ? `${key.slug}/${key.version}/${key.namespace}` : "";
  return useQuery<ModSourceResult>({
    queryKey: qk.modSource(n, id),
    queryFn: ({ signal }) => api.modSource(n, key as CompareKey, signal),
    enabled: enabled && key !== null,
    retry: 0,
  });
}

export function useSpecial(n: number, enabled = true) {
  return useQuery<SpecialFile[]>({ queryKey: qk.special(n), queryFn: ({ signal }) => api.special(n, signal), enabled });
}

export function useVersions(slug: string, namespace: string, pr: number | undefined) {
  return useQuery<CrossVersionResult>({
    queryKey: qk.versions(slug, namespace, pr),
    queryFn: ({ signal }) => api.versions(slug, namespace, pr, signal),
    enabled: slug.length > 0,
  });
}

export function useMods(q: string) {
  return useQuery<ModList>({ queryKey: qk.mods(q), queryFn: ({ signal }) => api.mods(q, signal), placeholderData: (previous) => previous });
}

export function useSessions(enabled = true) {
  return useQuery<SessionSummary[]>({ queryKey: qk.sessions, queryFn: ({ signal }) => api.sessions(signal), enabled, retry: 0 });
}

export function useSession(id: string | undefined, enabled = true) {
  return useQuery<SessionDetail>({
    queryKey: qk.session(id ?? ""),
    queryFn: ({ signal }) => api.session(id as string, signal),
    enabled: enabled && id !== undefined && id.length > 0,
    retry: 0,
  });
}

export function useLlmConfig(enabled = true) {
  return useQuery<LlmConfigView>({ queryKey: qk.llm, queryFn: ({ signal }) => api.llm(signal), enabled, retry: 0 });
}

export function useLogs(level: LogLevel | "all", autoRefresh: boolean) {
  return useQuery<LogEntry[]>({
    queryKey: qk.logs(level),
    queryFn: ({ signal }) => api.logs(level, 500, signal),
    refetchInterval: autoRefresh ? 5_000 : false,
  });
}

export function useMappings() {
  return useQuery({ queryKey: qk.mappings, queryFn: ({ signal }) => api.mappings(signal), retry: 0 });
}

export function useRefreshPr(n: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshPr(n),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.checks(n) }),
  });
}

export function useRefreshCache() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (what: "prs" | "mirror" | "mappings") => api.refreshCache(what),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.status });
      void client.invalidateQueries({ queryKey: qk.prs("all") });
    },
  });
}
