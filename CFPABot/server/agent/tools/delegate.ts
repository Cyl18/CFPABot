import { type } from "@oh-my-pi/omptype";
import {
  createAgentSession,
  SessionManager,
  type CustomTool,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import type { ToolContext } from "../context.ts";
import { loadConfig, resolveModel } from "../llm.ts";
import { parseRoleSelector } from "../llm-providers.ts";
import { paths } from "../../paths.ts";
import { openAuthStorage, openModelRuntime } from "../pi.ts";
import { onAbortSignal } from "./signal.ts";

const CHILD_TOOLS: Record<string, true> = { read: true, grep: true, find: true, glob: true, bash: true };

const DELEGATE_PARAMS = type({
  model: type("string").describe("模型别名，例如 @taska"),
  task: type("string").describe("交给子代理的任务"),
});

export function delegateTool(
  ctx: ToolContext,
  childTools: (ctx: ToolContext) => CustomTool[],
  extensions: ExtensionFactory[],
): CustomTool<typeof DELEGATE_PARAMS> {
  return {
    name: "delegate",
    label: "派发子代理",
    description: "按模型别名启动只读子代理，返回它的最终文本。别名来自 LLM 配置的 roles。",
    parameters: DELEGATE_PARAMS,
    execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
      const name = params.model.trim().replace(/^@/, "");
      const config = await loadConfig();
      const selector = config.roles[name];
      if (selector === undefined) throw new Error(`未知模型别名 @${name}`);
      const { endpoint: endpointId, thinking } = parseRoleSelector(selector);
      const { model } = await resolveModel(endpointId, thinking);
      const authStorage = await openAuthStorage(config.endpoints);
      const runtime = await openModelRuntime(authStorage, config.endpoints, config.roles);
      const created = await createAgentSession({
        cwd: paths.root,
        agentDir: paths.piAgent,
        model,
        authStorage,
        modelRegistry: runtime.registry,
        settings: runtime.settings,
        sessionManager: SessionManager.inMemory(paths.root),
        customTools: childTools(ctx).filter((tool) => CHILD_TOOLS[tool.name] === true),
        extensions,
        disableExtensionDiscovery: true,
        systemPrompt: "你是子代理。只完成分配的任务，用简洁文本返回结论；不要派发子代理。",
      });
      const session = created.session;
      const stopListening = onAbortSignal(signal, () => void session.abort());
      try {
        await session.setActiveToolsByName(
          session.getActiveToolNames().filter((name) => CHILD_TOOLS[name] === true || name.startsWith("mcp__")),
        );
        await session.prompt(params.task);
        const last = session.agent.state.messages.at(-1);
        if (last?.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
        const text =
          last?.role === "assistant"
            ? last.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
                .trim()
            : "";
        return {
          content: [{ type: "text", text: text || "(子代理没有返回文本)" }],
          details: { model: name, endpoint: endpointId, thinking },
        };
      } finally {
        stopListening();
        await session.dispose().catch(() => {});
        authStorage.close();
      }
    },
  };
}
