// src/api/sessions.ts
// Agent session REST routes — calls SessionService only.
//   GET    /sessions                        -> list all sessions (admin)
//   POST   /sessions                        -> create (admin)
//   GET    /sessions/:sessionId/messages    -> transcript messages (JSONL-projected)
//   GET    /sessions/:sessionId             -> detail metadata (no messages)
//   POST   /sessions/:sessionId/messages    -> continue (admin)
//   POST   /sessions/:sessionId/abort       -> abort (admin)
//   GET    /sessions/:sessionId/stream      -> SSE event stream (admin)
//   POST   /sessions/:sessionId/confirm     -> confirm pending action (admin)
//   POST   /sessions/:sessionId/reject      -> reject pending action (admin)
//   POST   /sessions/:sessionId/archive     -> archive (admin)

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware, requireAuth, requireAdmin } from "./auth.js";
import { createSessionFlowContext } from "./flow-context.js";
import type { FileStore, FlowContext, Logger, EntryConfig } from "@/types.js";
import type { GitHubClient } from "@/client/github/index.js";
import { MAX_BODY_SIZE } from "./frontend/helpers.js";
import type { AppVariables } from "./frontend/helpers.js";
import type { SessionService } from "@/agent/session-service.js";
import type { PiSessionManager } from "@/agent/session-manager.js";
import { parseLlmEndpoints } from "@/agent/llm-endpoints.js";
import { type ThinkingLevel } from "@/agent/llm-types.js";
import { validateSessionModelPair } from "@/agent/llm-registry.js";
import { SSE_HEARTBEAT_INTERVAL_MS, SSE_STREAM_SLEEP_MS } from "@/constants.js";
import { readTranscriptMessages, countTranscriptMessages } from "@/agent/pi-transcript-reader.js";
import { loadSessionCtx } from "@/agent/ctx-store.js";
import { getSessionCtx } from "@/agent/session-ctx.js";

export type SessionsRouter = Hono<{ Variables: AppVariables }>;

interface SessionRouteDeps {
  githubClient: GitHubClient;
  config: EntryConfig;
  logger: Logger;
  fileStore: FileStore;
  sessionService: SessionService;
  agentSessionManager: PiSessionManager;
}
export function createSessionsRouter(deps: SessionRouteDeps): SessionsRouter {
  const flowContextMiddleware: MiddlewareHandler = async (c, next) => {
  c.set("flowContext", createSessionFlowContext(deps.githubClient, deps.config, deps.logger, "agent", deps.fileStore));
  await next();
};

const sessionsRouter = new Hono<{ Variables: AppVariables }>();
sessionsRouter.use("*", authMiddleware);
sessionsRouter.use("*", requireAuth);
sessionsRouter.use("*", requireAdmin);
sessionsRouter.use("*", flowContextMiddleware);

/** Validate prNumber: must be a positive integer when provided. Returns error message or null. */
function validatePrNumber(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return "prNumber must be a positive integer";
  }
  return null;
}

// ─── GET /sessions ──────────────────────────────────────────────────

sessionsRouter.get("/", async (c) => {
  const svc = deps.sessionService;
  const list = await Promise.all(
    (await svc.listSessions()).filter((s) => s.status !== "archived").map(async (s) => {
      const messageCount = s.piSessionFile
        ? await countTranscriptMessages(s.piSessionFile)
        : (s.messages?.length ?? 0);
      return {
        sessionId: s.sessionId,
        source: s.source,
        createdBy: s.createdBy,
        prNumber: s.prNumber,
        status: s.status,
        objective: s.objective,
        modelProvider: s.modelProvider,
        modelId: s.modelId,
        messageCount,
        hasPendingConfirmation: s.pendingConfirmation !== undefined,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    }),
  );
  return c.json(list);
});


// ─── GET /sessions/:sessionId/messages ─────────────────────────────
// Registered BEFORE /:sessionId so the static "messages" segment wins
// the Hono router's static > param priority.

sessionsRouter.get("/:sessionId/review-state", async (c) => {
  const sessionId = c.req.param("sessionId");
  const svc = deps.sessionService;
  const session = await svc.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  // 内存优先（运行中会话的最新状态），盘文件补充（终态/重启后的持久化真相源）。
  const disk = await loadSessionCtx(sessionId);
  const mem = getSessionCtx(sessionId);
  const ctx = Object.keys(mem).length > 0 ? mem : (disk ?? {});

  return c.json({
    sessionId,
    pr: ctx.pr ?? null,
    reviewTable: ctx.reviewTable ?? [],
    finalTable: ctx.finalTable ?? [],
    termsDistilled: ctx.termsDistilled ?? null,
    manualAligned: ctx.manualAligned ?? [],
    dictCount: Array.isArray(ctx.dict) ? ctx.dict.length : 0,
    alignedCount: Array.isArray(ctx.aligned) ? ctx.aligned.length : 0,
    reviewsCount: Array.isArray(ctx.reviews) ? ctx.reviews.length : 0,
    draft: ctx.draft ?? null,
  });
});

sessionsRouter.get("/:sessionId/messages", async (c) => {
  const sessionId = c.req.param("sessionId");
  const svc = deps.sessionService;
  const session = await svc.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (!session.piSessionFile) {
    return c.json({ messages: session.messages ?? [] });
  }
  const messages = await readTranscriptMessages(session.piSessionFile);
  return c.json({ messages });
});

sessionsRouter.get("/:sessionId", async (c) => {
  const session = await deps.sessionService.getSession(c.req.param("sessionId"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  // Detail metadata only — full transcript is served via /messages.
  const messageCount = session.piSessionFile
    ? await countTranscriptMessages(session.piSessionFile)
    : (session.messages?.length ?? 0);
  const {
    sessionId: _id,
    source,
    createdBy,
    repo,
    prNumber,
    baseSha,
    headSha,
    objective,
    status,
    modelProvider,
    modelId,
    thinkingLevel,
    createdAt,
    updatedAt,
    archivedAt,
  } = session;
  return c.json({
    sessionId: _id,
    source,
    createdBy,
    repo,
    prNumber,
    baseSha,
    headSha,
    objective,
    status,
    modelProvider,
    modelId,
    thinkingLevel,
    createdAt,
    updatedAt,
    archivedAt,
    messageCount,
    hasPendingConfirmation: session.pendingConfirmation !== undefined,
    pendingConfirmation: session.pendingConfirmation ?? null,
  });
});

sessionsRouter.post("/", async (c) => {
  if (parseInt(c.req.header("content-length") ?? "0", 10) > MAX_BODY_SIZE) {
    return c.json({ error: "请求体过大" }, 413);
  }

  const body = await c.req.json<{
    message?: string;
    objective?: string;
    prNumber?: number;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  }>();

  if (!body.message && !body.objective) {
    return c.json({ error: "message or objective is required" }, 400);
  }

  // Validate prNumber: must be a positive integer when provided
  const prNumErr = validatePrNumber(body.prNumber);
  if (prNumErr) {
    return c.json({ error: prNumErr }, 400);
  }

  // Validate model selection via shared helper
  const endpoints = parseLlmEndpoints();
  const validationError = validateSessionModelPair(
    body.modelProvider, body.modelId, endpoints,
  );
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const user = c.var.user;
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const ctx = c.var.flowContext;
  if (!ctx) return c.json({ error: "Server context not available" }, 500);

  const svc = deps.sessionService;

  // Resolve PR scope upfront — fail before creating the session if GitHub
  // is unreachable, rather than creating a session with undefined scope.
  let baseSha: string | undefined;
  let headSha: string | undefined;
  if (body.prNumber) {
    try {
      const pr = await deps.githubClient.getPullRequest(body.prNumber);
      baseSha = pr.base.sha;
      headSha = pr.head.sha;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.logger.warn({ err: detail, prNumber: body.prNumber }, "Failed to fetch PR data for frontend session");
      return c.json({ error: `无法获取 PR #${body.prNumber} 信息，请稍后重试`, detail }, 502);
    }
  }

  const session = await svc.createSession({
    source: "frontend",
    createdBy: { login: user.login, githubId: user.id },
    repo: { owner: ctx.repo.owner, name: ctx.repo.name },
    prNumber: body.prNumber,
    baseSha,
    headSha,
    objective: body.objective ?? body.message ?? "",
    modelProvider: body.modelProvider,
    modelId: body.modelId,
    thinkingLevel: body.thinkingLevel,
  });


  if (body.message) {
    await svc.addMessage(session.sessionId, "user", body.message);
  }

  try {
    await deps.agentSessionManager.startSession(session.sessionId, ctx);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // startSession failed before runLoop (e.g. startRunning rejected).
    // Session stays idle — not orphaned in a live state.
    await svc.addMessage(session.sessionId, "system", `Agent 启动失败: ${errorMsg}`).catch(() => {});
    return c.json({
      sessionId: session.sessionId,
      status: "idle",
      createdAt: session.createdAt,
      error: errorMsg,
    });
  }
  return c.json({ sessionId: session.sessionId, status: "running", createdAt: session.createdAt });
});

sessionsRouter.post("/:sessionId/messages", async (c) => {
  if (parseInt(c.req.header("content-length") ?? "0", 10) > MAX_BODY_SIZE) {
    return c.json({ error: "请求体过大" }, 413);
  }
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ message: string }>();
  if (!body.message) return c.json({ error: "message is required" }, 400);

  const session = await deps.sessionService.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  if (session.status === "archived") {
    return c.json({ error: "Session is archived" }, 400);
  }
  if (session.status === "running" || session.pendingConfirmation !== undefined) {
    return c.json({ error: "Session is currently not accepting messages" }, 409);
  }

  const ctx = c.var.flowContext;
  if (!ctx) return c.json({ error: "Context not available" }, 500);

  try {
    await deps.agentSessionManager.continueSession(sessionId, ctx, body.message);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  return c.json({ success: true });
});
sessionsRouter.post("/:sessionId/abort", async (c) => {
  const sessionId = c.req.param("sessionId");
  const svc = deps.sessionService;

  const session = await svc.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  if (session.status === "archived") {
    return c.json({ error: "Session is archived" }, 400);
  }

    const aborted = await deps.agentSessionManager.abortSession(sessionId);
  return c.json({ success: aborted, sessionId });
});

sessionsRouter.post("/:sessionId/confirm", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ toolCallId: string }>();
  if (!body.toolCallId) return c.json({ error: "toolCallId is required" }, 400);

  const session = await deps.sessionService.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.status === "archived") {
    return c.json({ error: "Session is archived" }, 400);
  }

  try {
    const result = await deps.sessionService.confirmAction(sessionId, body.toolCallId);
    if (!result) return c.json({ error: "No matching pending confirmation found" }, 404);
    return c.json({ success: true, flowName: result.flowName, inputHash: result.inputHash });
  } catch (err) {
    deps.logger.error({ err: String(err), sessionId, toolCallId: body.toolCallId }, "Confirm action execution failed");
    return c.json({
      error: "Action execution failed",
      detail: err instanceof Error ? err.message : String(err),
      code: err && typeof err === "object" && "code" in err ? String((err as Record<string, unknown>).code) : "FAILED",
    }, 500);
  }
});

// ─── POST /sessions/:sessionId/archive ─────────────────────────────

sessionsRouter.post("/:sessionId/archive", async (c) => {
  const sessionId = c.req.param("sessionId");
  const svc = deps.sessionService;
  const mgr = deps.agentSessionManager;
  // Stop any in-flight agent loop first — otherwise finalizeSession could
  // overwrite the archived status back to a live one.
  if (await mgr.isRunning(sessionId)) {
    await mgr.abortSession(sessionId);
  }
  const archived = await svc.archiveSession(sessionId);
  if (!archived) return c.json({ error: "Session not found" }, 404);
  return c.json({
    success: true,
    sessionId,
    status: archived.status,
    archivedAt: archived.archivedAt,
  });
});


// ─── POST /sessions/:sessionId/reject ──────────────────────────────

sessionsRouter.post("/:sessionId/reject", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ toolCallId: string }>();
  if (!body.toolCallId) return c.json({ error: "toolCallId is required" }, 400);

  const session = await deps.sessionService.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.status === "archived") {
    return c.json({ error: "Session is archived" }, 400);
  }

  const rejected = await deps.sessionService.rejectAction(sessionId, body.toolCallId);
  if (!rejected) return c.json({ error: "No matching pending confirmation found" }, 404);

  return c.json({ success: true });
});

// ─── GET /sessions/:sessionId/stream (SSE) ─────────────────────────

sessionsRouter.get("/:sessionId/stream", (c) => {
  const sessionId = c.req.param("sessionId");
  const routeDeps = deps;
  const sessionPromise = routeDeps.sessionService.getSession(sessionId);

  return streamSSE(c, async (stream) => {
    const session = await sessionPromise;
    if (!session) {
      await stream.writeSSE({ data: JSON.stringify({ error: "Session not found" }), event: "error" });
      stream.close();
      return;
    }

    await stream.writeSSE({
      data: JSON.stringify({
        sessionId,
        type: "session_status",
        status: session.status,
        pendingConfirmation: session.pendingConfirmation ?? null,
      }),
    });

    // Heartbeat every 15s to keep SSE alive during long tool executions
    // (Bun.serve idleTimeout is disabled, but proxies may still drop idle connections).
    // An SSE comment (`: ping\n\n`) is invisible to clients but exercises the socket:
    // if the write fails we unsubscribe + close so broadcast() evicts the dead subscriber.
    const heartbeat = setInterval(() => {
      stream.writeSSE({ data: JSON.stringify({ type: "heartbeat", sessionId }) })
        .catch(() => {
          // Dead connection detected — tear down the stream so broadcast() evicts this subscriber.
          clearInterval(heartbeat);
          unsubscribe();
          stream.close().catch(() => {});
        });
    }, SSE_HEARTBEAT_INTERVAL_MS);

    const onAbort = () => {
      clearInterval(heartbeat);
      unsubscribe();
      stream.close().catch(() => {});
    };
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    const unsubscribe = deps.agentSessionManager.subscribe(sessionId, (event) => {
      // Throwing here lets broadcast() detect + evict this dead subscriber; the route's
      // streamSSE wrapper catches per-call errors, so throws are safe.
      stream.writeSSE({ data: JSON.stringify({ sessionId, ...event }) }).catch(() => {
        clearInterval(heartbeat);
        unsubscribe();
        stream.close().catch(() => {});
      });
    });

    while (!stream.closed) await stream.sleep(SSE_STREAM_SLEEP_MS);
    unsubscribe();
    clearInterval(heartbeat);
  });
});
  return sessionsRouter;
}
