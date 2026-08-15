// src/api/frontend.ts
// Thin entry point for frontend API routes - mounts sub-routers from ./frontend/

import { Hono } from "hono";
import { Type } from "typebox";
import { authMiddleware, requireAuth, requireAdmin } from "./auth.js";
import { createUserTokenGitHubClient } from "@/client/github/index.js"
import {
  type AppVariables,
} from "./frontend/helpers.js";
import { getSharedRegistry } from "@/engine/registry-store.js";
import { getRecentLogs } from "@/logger.js";
import type { LogEntry } from "@/logger.js";
import { executeFlow } from "@/engine/execute.js";
import { buildUserFlowContext, getApiLogger } from "./flow-context.js";
import { parseBody, sendApiError } from "./body.js";


// ---- Sub-routers ----
import { prsRouter } from "./frontend/prs.js";
import { prRouter } from "./frontend/pr.js";
import { compareRouter } from "./frontend/compare.js";
import { modlistRouter } from "./frontend/modlist.js";
import { devRouter } from "./frontend/dev/index.js";
import { adminLlmRouter } from "./frontend/admin-llm.js";


// ================================================================
// Public Router (with optional auth — authMiddleware never rejects)
// ================================================================

export const frontendRouter = new Hono<{ Variables: AppVariables }>();

frontendRouter.use("*", authMiddleware);

// ---- GET /me ----
frontendRouter.get("/me", (c) => {
  const user = c.get("user");

  if (user) {
    return c.json({
      login: user.login,
      id: user.id,
      avatar: user.avatar,
      isAdmin: c.get("isAdmin") ?? false,
      isContributor: c.get("isContributor") ?? false,
    });
  }

  return c.json(null);
});
// (rate-limit moved to protectedFrontend requiring auth)

// Mount sub-routers
frontendRouter.route("/", prsRouter);
frontendRouter.route("/", prRouter);
frontendRouter.route("/", compareRouter);
frontendRouter.route("/", modlistRouter);
frontendRouter.route("/dev", devRouter);

// ================================================================
// Protected Router (requires valid auth via requireAuth)
// ================================================================

export const protectedFrontend = new Hono<{ Variables: AppVariables }>();

protectedFrontend.use("*", authMiddleware);
protectedFrontend.use("*", requireAuth);

// Mount protected sub-routers
protectedFrontend.route("/admin/llm-endpoints", adminLlmRouter);


// ---- GET /rate-limit — moved from public to require auth ----
protectedFrontend.get("/rate-limit", async (c) => {
  const client = createUserTokenGitHubClient(c.get("oauthToken"), getApiLogger());
  const data = await client.getRateLimit();
  return c.json(data);
});
// ---- POST /review/:prid ----
// Protected admin route: reply to a review thread via review_thread_reply Flow.
protectedFrontend.post("/review/:prid", requireAdmin, async (c) => {
  const prNumber = parseInt(c.req.param("prid"), 10);
  if (isNaN(prNumber)) return c.json({ error: "Invalid PR number" }, 400);

    const body = await parseBody(c, Type.Object({
    threadCommentId: Type.Number(),
    body: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(Type.String()),
  }));

  try {
    const registry = getSharedRegistry();
    const flow = registry.get("review_thread_reply");
    const token = c.get("oauthToken");
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);

    const result = await executeFlow(flow, ctx, {
      prNumber,
      threadCommentId: body.threadCommentId,
      body: body.body,
      sessionId: body.sessionId,
    });

    return c.json(result);
  } catch (err) {
    return sendApiError(c, err, { prefix: "Failed to reply to review thread" });
  }
});

// ---- GET /logs — admin-only log viewer, reads logger ring buffer ----
protectedFrontend.get("/logs", requireAdmin, async (c) => {
  const level = c.req.query("level");
  const limitStr = c.req.query("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const entries = getRecentLogs(limit, level || undefined);
  return c.json(entries);
});
