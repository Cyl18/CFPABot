import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { ChatItem } from "../../shared/api.ts";
import { LiveProjector } from "./projection.ts";

const KEEP_TOOL_RESULTS = 6;

async function pruneToolResults(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const stale: number[] = [];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "toolResult") continue;
    seen++;
    if (seen > KEEP_TOOL_RESULTS) stale.push(index);
  }
  if (stale.length === 0) return messages;
  const pruned = [...messages];
  for (const index of stale) {
    const message = pruned[index];
    if (message?.role !== "toolResult") continue;
    pruned[index] = { ...message, content: [{ type: "text", text: `[旧工具结果已裁剪：${message.toolName}]` }] };
  }
  return pruned;
}

export interface RuntimeOptions {
  sessionId: string;
  model: Model<Api>;
  apiKey: string | undefined;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  thinking: ThinkingLevel | undefined;
  collection: MutableModels;
  onItem(item: ChatItem): void;
}

export interface RunOutcome {
  messages: AgentMessage[];
  error?: string;
  aborted?: boolean;
}

export class SessionRuntime {
  private agent: Agent;
  private projector: LiveProjector;
  private aborted = false;

  constructor(options: RuntimeOptions) {
    const head = options.messages[0];
    const systemHead = head?.role === "system" ? head : undefined;
    const messages = systemHead
      ? [{ ...systemHead, content: options.systemPrompt }, ...options.messages.slice(1)]
      : options.messages;
    this.projector = new LiveProjector(options.messages.length + (systemHead ? 0 : 1));
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: options.tools,
        messages,
        ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
      },
      streamFn: options.collection.streamSimple.bind(options.collection),
      getApiKey: () => options.apiKey,
      transformContext: (messages) => pruneToolResults(messages),
      sessionId: options.sessionId,
    });
    this.agent.subscribe((event) => {
      for (const item of this.projector.handle(event)) options.onItem(item);
    });
  }

  async run(prompt: string): Promise<RunOutcome> {
    try {
      await this.agent.prompt(prompt);
    } catch (err) {
      return { messages: this.agent.state.messages, error: err instanceof Error ? err.message : String(err), aborted: this.aborted };
    }
    const error = this.agent.state.errorMessage;
    if (this.aborted) return { messages: this.agent.state.messages, aborted: true };
    return error ? { messages: this.agent.state.messages, error } : { messages: this.agent.state.messages };
  }

  abort(): void {
    this.aborted = true;
    this.agent.abort();
  }
}
