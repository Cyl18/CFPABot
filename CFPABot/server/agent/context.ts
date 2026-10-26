import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { SessionEvent } from "@cfpa/contracts/api";

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
  /** 会话绑定的 PR；bash 用它给出 $CFPA_PR。 */
  prNumber?: number;
  /** 会话创建后才存在；子代理据此继承父会话的 MCP 连接。 */
  mcpManager?: () => MCPManager | undefined;
  /** 会话创建后才存在；delegate 用它注册后台 job。 */
  session?: () => AgentSession | undefined;
  /** 往这个会话的 SSE 推事件。 */
  emit?: (event: SessionEvent) => void;
}
