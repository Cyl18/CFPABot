import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { LlmEndpoint } from "@cfpa/contracts/api";
import { paths } from "../paths.ts";
import { localDir } from "./local-store.ts";
import { assertEndpointRouting, resolveApiKey } from "./llm-providers.ts";
import type { SessionRecord } from "./sessions.ts";

export async function openAuthStorage(endpoints: LlmEndpoint[]): Promise<AuthStorage> {
  assertEndpointRouting(endpoints);
  const authStorage = await discoverAuthStorage(paths.piAgent);
  for (const endpoint of endpoints) {
    const apiKey = resolveApiKey(endpoint.apiKey);
    if (apiKey) authStorage.keys.setRuntime(endpoint.provider, apiKey);
  }
  return authStorage;
}

export async function openModelRuntime(
  authStorage: AuthStorage,
  endpoints: LlmEndpoint[],
  roles: Record<string, string>,
): Promise<{ settings: Settings; registry: ModelRegistry }> {
  assertEndpointRouting(endpoints);
  const settings = await Settings.init({ cwd: paths.root, agentDir: paths.piAgent });
  settings.overrideModelRoles(roles);
  const registry = new ModelRegistry(authStorage);
  const byProvider = new Map<string, LlmEndpoint[]>();
  for (const endpoint of endpoints) {
    if (!resolveApiKey(endpoint.apiKey)) continue;
    byProvider.set(endpoint.provider, [...(byProvider.get(endpoint.provider) ?? []), endpoint]);
  }
  for (const [provider, list] of byProvider) {
    const first = list[0];
    if (!first) continue;
    const apiKey = resolveApiKey(first.apiKey);
    if (apiKey === undefined) continue;
    registry.registerProvider(
      provider,
      {
        baseUrl: first.baseUrl,
        apiKey,
        api: first.protocol,
        models: list.map((endpoint) => ({
          id: endpoint.model,
          name: endpoint.id,
          api: endpoint.protocol,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: endpoint.contextWindow ?? 128_000,
          maxTokens: endpoint.maxOutput ?? 8192,
        })),
      },
      "cfpa",
    );
  }
  return { settings, registry };
}

export async function openSessionManager(record: SessionRecord): Promise<SessionManager> {
  if (record.sessionFile && existsSync(record.sessionFile)) {
    return SessionManager.open(record.sessionFile, paths.sessions);
  }
  // 会话文件定在 runtime/sessions/<id>.jsonl：omp 的 artifacts 目录随之等于 <id>/，local:// 与 cwd 都落在 <id>/local。
  const manager = SessionManager.create(localDir(record.meta.id), paths.sessions);
  const file = join(paths.sessions, `${record.meta.id}.jsonl`);
  await manager.setSessionFile(file);
  record.sessionFile = file;
  return manager;
}

export async function sessionMessages(record: SessionRecord): Promise<AgentMessage[]> {
  if (!record.sessionFile || !existsSync(record.sessionFile)) return [];
  try {
    const manager = await SessionManager.open(record.sessionFile, paths.sessions);
    return manager.buildSessionContext({ transcript: true, collapseCompactedHistory: true }).messages;
  } catch {
    return [];
  }
}
