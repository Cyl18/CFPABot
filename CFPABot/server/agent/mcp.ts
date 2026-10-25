import {
  loadAllMCPConfigs,
  MCPManager,
  type LoadMCPConfigsOptions,
  type LoadMCPConfigsResult,
  type MCPConfigLoader,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";

const log = logger("agent-mcp");

/** 只加载项目级 `.mcp.json`：用户级配置属于操作者本人，不进 bot 会话。 */
const projectConfigs: MCPConfigLoader = async (
  cwd: string,
  options?: LoadMCPConfigsOptions,
): Promise<LoadMCPConfigsResult> => {
  const loaded = await loadAllMCPConfigs(cwd, options);
  const kept = Object.keys(loaded.configs).filter((name) => loaded.sources[name]?.level === "project");
  const dropped = Object.keys(loaded.configs).filter((name) => !kept.includes(name));
  if (dropped.length > 0) log.info("忽略非项目级 MCP 服务器", { dropped });
  return {
    configs: Object.fromEntries(kept.map((name) => [name, loaded.configs[name]!])),
    sources: Object.fromEntries(kept.map((name) => [name, loaded.sources[name]!])),
    exaApiKeys: loaded.exaApiKeys,
  };
};

let shared: Promise<MCPManager | undefined> | undefined;

/** 全进程一个 manager：所有会话与子代理共用同一条 MCP 连接。 */
export function agentMcpManager(): Promise<MCPManager | undefined> {
  shared ??= (async () => {
    const manager = new MCPManager(paths.root, null, projectConfigs);
    try {
      const result = await manager.discoverAndConnect({ filterExa: true });
      for (const entry of result.errors) log.error("MCP 加载失败", { path: entry[0], error: entry[1] });
      return manager;
    } catch (error) {
      log.error("MCP 初始化失败", { error });
      shared = undefined;
      return undefined;
    }
  })();
  return shared;
}

export async function closeAgentMcp(): Promise<void> {
  const pending = shared;
  shared = undefined;
  if (pending === undefined) return;
  const manager = await pending.catch(() => undefined);
  await manager?.disconnectAll().catch(() => undefined);
}
