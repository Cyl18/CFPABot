import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import type { WriteScope } from "@cfpa/contracts/api";

export interface LocalEntry {
  content: string;
  updatedAt: string;
}

export interface LocalFileInfo {
  name: string;
  size: number;
  updatedAt: string;
}

export interface ToolContext {
  sessionId: string;
  writeScope: WriteScope;
  /** 会话绑定的 PR；bash 用它给出 $CFPA_PR，子代理也用它校验分片。 */
  prNumber?: number;
  /** 会话创建后才存在；子代理据此继承父会话的 MCP 连接。 */
  mcpManager?: () => MCPManager | undefined;
  local(name: string): Promise<LocalEntry | null>;
  saveLocal(name: string, content: string): Promise<LocalEntry>;
  listLocal(): Promise<LocalFileInfo[]>;
}
