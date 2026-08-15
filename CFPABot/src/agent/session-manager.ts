// src/agent/session-manager.ts
// PiSessionManager — session orchestration on top of PiRuntime.
// PiRuntime owns the pi-coding-agent SDK assembly (settings, extensions,
// MCP/skill resources, transcripts); this file owns policy and lifecycle:
// model/tool selection, SSE broadcasting, confirmation/continuation loops
// and abort controllers.

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { FlowContext, Logger } from "@/types.js";
import { flowToToolDefinition } from "./flow-adapter.js";
import { isAgentVisible } from "./flow-policy.js";
import { getSharedRegistry } from "@/engine/registry-store.js";
import { syncLlmRegistry, selectSessionModel } from "./llm-registry.js";
import { parseLlmEndpoints, findLlmEndpoint } from "./llm-endpoints.js";

import type { SessionRecord } from "./session-types.js";
import type { SessionService } from "./session-service.js";
import type {
  AgentSession,
  AgentSessionServices,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { PiRuntime } from "./pi-runtime.js";
import { SseBroadcaster, type SseSubscriber } from "./session-sse.js";
import {
  validateToolSet,
  resolvePromptText,
  buildSystemPrompt,
} from "./session-prompt.js";
import { projectToSse } from "./session-projection.js";
import { createTodoTool } from "./tools/todo.js";
import { createCtxGetTool, createCtxSetTool } from "./tools/ctx.js";
import { getSessionCtx, setSessionCtx, clearSessionCtx, type Ctx } from "./session-ctx.js";
import { persistSessionCtx, loadSessionCtx } from "./ctx-store.js";
import { createReviewAlignTool } from "./tools/review-align.js";
import { createDictLookupTool } from "./tools/dict-lookup.js";
import { createTermsExtractTool } from "./tools/terms-extract.js";
import { createReviewMoaTool } from "./tools/review-moa.js";
import { createReviewManualPlanTool } from "./tools/review-manual-plan.js";
import { createReviewManualAlignTool } from "./tools/review-manual-align.js";
import { createReviewAggregateTool } from "./tools/review-aggregate.js";
import { createReviewFinalizeTool } from "./tools/review-finalize.js";
import { createTermsDistillTool } from "./tools/terms-distill.js";
import { createTmQueryTool } from "./tools/tm-query.js";
import { createReviewPrepTool } from "./tools/review-prep.js";

// ─── Internal runtime state ──────────────────────────────────────────

interface PiSessionRuntime {
  sessionId: string;
  abortController: AbortController;
  agentSession?: AgentSession;
}

// ─── Agent flow visibility ────────────────────────────────────────────
// Deliberately narrow allow-list, see src/agent/flow-policy.ts. This is
// NOT derived from Flow.meta.agent_callable on purpose: re-opening a Flow
// for Agent use is a policy decision after the 2026-08-01 publish incident.

// ─── Max continuation rounds in runLoop ──────────────────────────────
const MAX_CONTINUATION_ROUNDS = 3;
export class PiSessionManager {
  private runtimes = new Map<string, PiSessionRuntime>();
  private sessionService: SessionService;
  /** In-flight runLoop promises — used by destroy() to drain background work. */
  private runLoops = new Map<string, Promise<void>>();

  private readonly broadcaster: SseBroadcaster;
  private readonly logger?: Logger;
  /** Owns Pi SDK runtime assembly (extensions/MCP/skills/transcripts). */
  private readonly piRuntime: PiRuntime;

  constructor(
    sessionService: SessionService,
    logger?: Logger,
    piRuntime: PiRuntime = new PiRuntime(),
  ) {
    this.sessionService = sessionService;
    this.logger = logger;
    this.piRuntime = piRuntime;
    this.broadcaster = new SseBroadcaster(logger);
    this.sessionService.sseBroadcast = (sessionId, event) => this.broadcast(sessionId, event);
  }

  // ─── SSE Subscription ─────────────────────────────────────────────

  subscribe(sessionId: string, subscriber: SseSubscriber): () => void {
    return this.broadcaster.subscribe(sessionId, subscriber);
  }

  broadcast(sessionId: string, event: Record<string, unknown>): void {
    return this.broadcaster.broadcast(sessionId, event);
  }

  // ─── Session Lifecycle ────────────────────────────────────────────

  async startSession(sessionId: string, ctx: FlowContext): Promise<void> {
    if (this.runtimes.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a running agent`);
    }
    const started = await this.sessionService.startRunning(sessionId);
    if (!started) {
      throw new Error(`Cannot start session ${sessionId}: not found or already running`);
    }

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      await this.sessionService.updateStatus(sessionId, "idle");
      throw new Error(`Session ${sessionId} not found after startRunning`);
    }

    // Register runtime immediately so isRunning returns true
    const abortController = new AbortController();
    this.runtimes.set(sessionId, { sessionId, abortController });

    // Fire-and-forget — API must return immediately
    const loop = this.runLoop(session, ctx, undefined, abortController).catch((err) => {
      this.logger?.error({ err: String(err), sessionId }, "[PiSessionManager] runLoop error");
    }).finally(() => {
      if (this.runLoops.get(sessionId) === loop) this.runLoops.delete(sessionId);
    });
    this.runLoops.set(sessionId, loop);
  }

  async continueSession(
    sessionId: string,
    ctx: FlowContext,
    promptOverride: string,
  ): Promise<void> {
    if (this.runtimes.has(sessionId)) {
      throw new Error(`Session ${sessionId} is currently running — wait for completion`);
    }
    const started = await this.sessionService.startRunning(sessionId);
    if (!started) {
      throw new Error(`Cannot continue session ${sessionId}: not found or already running`);
    }

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      await this.sessionService.updateStatus(sessionId, "idle");
      throw new Error(`Session ${sessionId} not found after startRunning`);
    }

    const abortController = new AbortController();
    this.runtimes.set(sessionId, { sessionId, abortController });

    const loop = this.runLoop(session, ctx, promptOverride, abortController).catch((err) => {
      this.logger?.error({ err: String(err), sessionId }, "[PiSessionManager] runLoop error");
    }).finally(() => {
      if (this.runLoops.get(sessionId) === loop) this.runLoops.delete(sessionId);
    });
    this.runLoops.set(sessionId, loop);
  }

  // ─── Compose the tool list (whitelist flows + custom tools) ────────

  private buildCustomToolDefs(sessionId: string, session?: SessionRecord): ToolDefinition[] {
    const fallbackModel =
      session?.modelProvider && session?.modelId
        ? { provider: session.modelProvider, modelId: session.modelId }
        : undefined;
    return [
      createTodoTool(sessionId),
      createCtxGetTool(sessionId),
      createCtxSetTool(sessionId),
      createReviewAlignTool(sessionId),
      createDictLookupTool(sessionId),
      createTermsExtractTool(sessionId),
      createReviewMoaTool(sessionId, fallbackModel),
      createReviewManualPlanTool(sessionId),
      createReviewManualAlignTool(sessionId),
      createReviewAggregateTool(sessionId),
      createReviewFinalizeTool(sessionId),
      createTermsDistillTool(sessionId),
      createTmQueryTool(sessionId),
      createReviewPrepTool(sessionId),
    ];
  }

  private buildWhitelistedFlowToolDefs(sessionCtx: FlowContext, sessionId: string): ToolDefinition[] {
    const registry = getSharedRegistry();
    const flowToolDefs: ToolDefinition[] = registry
      .list()
      .filter((f) => isAgentVisible(f.name))
      .map((f) => flowToToolDefinition(f, sessionCtx, this.sessionService, sessionId));
    return flowToolDefs;
  }

  private logPiRuntimeResources(
    sessionId: string,
    services: AgentSessionServices,
  ): void {
    const snapshot = this.piRuntime.inspectResources(services);
    const { extensions, extensionErrors, skills, resourceDiagnostics, serviceDiagnostics } = snapshot;

    this.logger?.debug({
      sessionId,
      extensions: extensions.map((e) => ({ path: e.path, tools: e.tools })),
      skills: skills.map((s) => s.name),
    }, "[PiRuntime] loaded resources");

    for (const err of extensionErrors) {
      this.logger?.error(
        { sessionId, extensionPath: err.path, err: err.error },
        "[PiRuntime] extension load error",
      );
    }
    for (const diagnostic of resourceDiagnostics) {
      this.logger?.warn(
        { sessionId, diagnostic },
        "[PiRuntime] resource diagnostic",
      );
    }
    for (const diagnostic of serviceDiagnostics) {
      this.logger?.warn(
        { sessionId, diagnostic },
        "[PiRuntime] service diagnostic",
      );
    }
  }

  // ─── Run one prompt + optional continuation ───────────────────────

  private async runLoop(
    session: SessionRecord,
    ctx: FlowContext,
    promptOverride?: string,
    abortController?: AbortController,
  ): Promise<void> {
    const sessionId = session.sessionId;
    const ac = abortController ?? new AbortController();
    let agentSession: AgentSession | null = null;
    let agentUnsub: (() => void) | null = null;

    try {
      // ── Build flow context ─────────────────────────────────
      const sessionCtx: FlowContext = {
        ...ctx,
        signal: ac.signal,
        scope: session.headSha
          ? { prNumber: session.prNumber, baseSha: session.baseSha, headSha: session.headSha }
          : {},
        invocation: {
          id: crypto.randomUUID(),
          source: "agent",
          sessionId: session.sessionId,
        },
      };

      // ── Resolve model ──────────────────────────────────────
      syncLlmRegistry();
      const endpointConfigs = parseLlmEndpoints();
      const configuredModel = selectSessionModel(
        session.modelProvider, session.modelId, endpointConfigs,
      );
      const model = configuredModel
        ?? builtinModels().getModel("anthropic", "claude-sonnet-4-20250514")
        ?? builtinModels().getModel("openai", "gpt-4o");
      if (!model) throw new Error("No LLM model available");

      // Match endpoint by provider + modelId
      const selectedEndpoint = findLlmEndpoint(
        model.provider,
        model.id,
      );

      // ── Recover persisted ctx (continue sessions) ─────────────
      // Disk snapshot is stale by design (written at checkpoints); in-memory
      // ctx (same-process continue) wins when already present.
      const existingCtx = getSessionCtx(sessionId);
      if (Object.keys(existingCtx).length === 0) {
        const diskCtx = await loadSessionCtx(sessionId);
        if (diskCtx) setSessionCtx(sessionId, { ...diskCtx });
      }

      // ── Load whitelist Flow tools + custom tools ─────────
      const flowToolDefs = this.buildWhitelistedFlowToolDefs(sessionCtx, sessionId);
      const customToolDefs = this.buildCustomToolDefs(sessionId, session);
      const allToolDefs = [...flowToolDefs, ...customToolDefs];

      // ── Build system prompt ────────────────────────────────
      const systemPrompt = buildSystemPrompt(session);

      // Fail-fast: no API key means every LLM call returns 401
      if (!selectedEndpoint?.apiKey) {
        throw new Error(`No API key configured for provider "${selectedEndpoint?.provider ?? model.provider}" — cannot start agent session`);
      }

      // ── Pi runtime: settings + extensions/MCP/skills + transcript ──
      // One coherent services bundle; one SettingsManager is shared by the
      // resource loader and the AgentSession (previous code used two managers).
      const services = await this.piRuntime.createServices(systemPrompt);
      this.logPiRuntimeResources(sessionId, services);

      const { sessionManager: piSessionManager, createdPath } =
        this.piRuntime.openOrCreateSessionManager(session.piSessionFile);
      if (!session.piSessionFile && createdPath) {
        await this.sessionService.setPiSessionFile(session.sessionId, createdPath);
      }

      // API keys live in config/llm-endpoints.json and are injected at runtime;
      // PiRuntime keeps AuthStorage in-memory so they are never persisted.
      services.authStorage.set(selectedEndpoint.provider, {
        type: "api_key",
        key: selectedEndpoint.apiKey,
      });

      const result = await this.piRuntime.createAgentSession({
        services,
        sessionManager: piSessionManager,
        model,
        customTools: allToolDefs,
        noTools: "builtin",
        ...(session.thinkingLevel
          ? { thinkingLevel: session.thinkingLevel }
          : {}),
      });

      agentSession = result.session;

      // Backfill agentSession to the runtime registered earlier
      const existing = this.runtimes.get(sessionId);
      if (existing) {
        existing.agentSession = agentSession;
      }

      // If abort happened during creation, abort immediately and return
      if (ac.signal.aborted) {
        agentSession.abort();
        await this.finalizeSession(sessionId);
        return;
      }

      // Validate tool set
      const activeNames = new Set(agentSession.getActiveToolNames());
      const expectedNames = new Set(allToolDefs.map((t) => t.name));
      const toolError = validateToolSet(activeNames, expectedNames);
      if (toolError) throw new Error(`Tool set mismatch for session ${sessionId}. ${toolError}`);

      // Subscribe to agent events for SSE broadcast only — no projection side-effect
      agentUnsub = agentSession.subscribe((event) => {
        const sseEvent = projectToSse(event, sessionId);
        if (sseEvent) {
          this.broadcaster.broadcast(sessionId, sseEvent);
        }
      });

      // ── Prompt + continuation loop ────────────────────────
      let rounds = 0;
      let nextPrompt = promptOverride;
      while (true) {
        if (ac.signal.aborted) {
          await this.finalizeSession(sessionId);
          return;
        }

        const promptText = resolvePromptText(session, nextPrompt);
        await agentSession.prompt(promptText);
        rounds++;
        nextPrompt = undefined;

        if (ac.signal.aborted) {
          await this.finalizeSession(sessionId);
          return;
        }

        if (agentSession.agent.state.errorMessage) {
          const agentError: string = agentSession.agent.state.errorMessage;
          // Archived is terminal — never overwrite it (the admin archived the
          // session while the loop was running; the failure is moot).
          const cur = await this.sessionService.getSession(sessionId);
          if (cur?.status === "archived") return;
          await this.sessionService.updateStatus(sessionId, "idle");
          await this.sessionService.addMessage(sessionId, "system", `Agent 执行失败: ${agentError}`);
          this.broadcast(sessionId, { type: "session_status", sessionId, status: "idle", error: agentError });
          return;
        }

        // Check pending confirmation — let the admin resolve before continuing
        const currentRecord = await this.sessionService.getSession(sessionId);
        if (currentRecord?.pendingConfirmation !== undefined) {
          return;
        }

        // Check remaining open todos — continue prompting if any are unfinished
        // and we haven't exhausted rounds.
        if (rounds < MAX_CONTINUATION_ROUNDS) {
          const ctx = getSessionCtx(sessionId);
          const todos = ctx.todos ?? [];
          const open = todos.filter((t) => t.status !== "completed");
          if (open.length > 0) {
            const list = open.map((t) => `- [${t.status}] ${t.id}: ${t.title}`).join("\n");
            nextPrompt = `还有未完成的 todo：\n${list}\n\n请继续处理这些任务直到全部完成（用 todo op=complete 标记）。`;
            continue;
          }
        }

        break;
      }

      await this.finalizeSession(sessionId);

    } catch (err) {
      if (ac.signal.aborted) {
        await this.finalizeSession(sessionId);
      } else {
        const cur = await this.sessionService.getSession(sessionId);
        // pendingConfirmation 仍在 → agent 停在待确认状态, 不算失败;
        // archived 是终态, 永不覆盖。
        if (cur && cur.pendingConfirmation === undefined && cur.status !== "archived") {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await this.sessionService.updateStatus(sessionId, "idle");
          this.broadcast(sessionId, { type: "session_status", sessionId, status: "idle", error: errorMsg });
        }
      }
    } finally {
      // Cleanup
      if (agentUnsub) {
        agentUnsub();
      }
      agentSession?.dispose();
      // Identity guard: only delete runtime if no newer loop has replaced ours.
      const current = this.runtimes.get(sessionId);
      if (current && current.abortController === ac) {
        this.runtimes.delete(sessionId);
      }
    }
  }

  private async finalizeSession(sessionId: string): Promise<void> {
    // Guard: archiving is a terminal admin action — never let the agent loop
    // overwrite an archived session back to a live status.
    const current = await this.sessionService.getSession(sessionId);
    if (current?.status === "archived") return;
    await this.sessionService.updateStatus(sessionId, "idle");
    this.broadcast(sessionId, { type: "idle", sessionId } as Record<string, unknown>);
    // Session is terminal — prune any lingering subscribers so they don't accumulate.
    this.broadcaster.clearSession(sessionId);
    // Terminal state: persist first, then drop in-memory ctx — partial results
    // must survive (契约 2026-08-01: 先写再 clear)。
    await persistSessionCtx(sessionId);
    clearSessionCtx(sessionId);
  }

  // ─── Abort ────────────────────────────────────────────────────────

  async abortSession(sessionId: string): Promise<boolean> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) {
      return this.sessionService.abortSession(sessionId);
    }
    rt.abortController.abort();
    if (rt.agentSession) {
      rt.agentSession.abort();
    }
    await this.sessionService.abortSession(sessionId);
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /**
   * Abort all sessions and wait for in-flight runLoops to settle.
   * Tests MUST await this before deleting shared temp dirs.
   */
  async destroy(): Promise<void> {
    const loops = [...this.runLoops.values()];
    for (const [, rt] of this.runtimes) {
      rt.abortController.abort();
      if (rt.agentSession) {
        rt.agentSession.dispose();
      }
      // 终止确认中的会话:abortSession 会 reject pending promise,
      // 否则 runLoop 卡在 await prompt() 上,Promise.allSettled 无限等待。
      await this.sessionService.abortSession(rt.sessionId);
    }
    this.runtimes.clear();
    this.broadcaster.clear();
    await Promise.allSettled(loops);
    this.runLoops.clear();
  }
}
