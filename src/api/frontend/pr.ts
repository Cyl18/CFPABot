// src/api/frontend/pr.ts
// PR routes: GET /pr/:number, GET /pr/:number/relations, GET /mod-files/:prid
// Thin HTTP adapter — business logic delegated to pr_get_detail, pr_find_related Flows.

import { Hono } from "hono";
import { evictCache, type AppVariables } from "./helpers.js";
import { getSharedRegistry } from "@/engine/registry-store.js";
import { executeFlow } from "@/engine/execute.js";
import { buildUserFlowContext } from "@/api/flow-context.js";

export const prRouter = new Hono<{ Variables: AppVariables }>();

const prDetailCache = new Map<number, { data: unknown; fetchedAt: number }>();
const PR_DETAIL_CACHE_TTL = 120 * 1000; // 2 minutes
const MAX_ENTRIES = 200;

export function invalidatePrCache(prNumber: number): void {
  prDetailCache.delete(prNumber);
}

// ---- GET /pr/:number ----
prRouter.get("/pr/:number", async (c) => {
  const prNumber = parseInt(c.req.param("number"), 10);
  if (isNaN(prNumber)) return c.json({ error: "Invalid PR number" }, 400);

  const cached = prDetailCache.get(prNumber);
  if (cached) {
    prDetailCache.delete(prNumber);
    prDetailCache.set(prNumber, cached);
    if (Date.now() - cached.fetchedAt < PR_DETAIL_CACHE_TTL)
      return c.json(cached.data);
  }

  try {
    const token = c.get("oauthToken");
    const registry = getSharedRegistry();
    const flow = registry.get("pr_get_detail");
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const result = await executeFlow(flow, ctx, { prNumber });

    prDetailCache.set(prNumber, { data: result, fetchedAt: Date.now() });
    evictCache(prDetailCache, MAX_ENTRIES);

    return c.json(result);
  } catch (err) {
    // 500 不泄漏内部错误详情 — 仅返回通用信息
    return c.json({ error: "Failed to get PR detail" }, 500);
  }
});

// ---- GET /pr/:number/relations ----
prRouter.get("/pr/:number/relations", async (c) => {
  const prNumber = parseInt(c.req.param("number"), 10);
  if (isNaN(prNumber)) {
    return c.json({ error: "Invalid PR number" }, 400);
  }

  try {
    const token = c.get("oauthToken");
    const registry = getSharedRegistry();
    const flow = registry.get("pr_find_related");
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);

    const result = await executeFlow(flow, ctx, { prNumber });
    return c.json(result);
  } catch (err) {
    return c.json({ error: "Failed to get PR relations" }, 500);
  }
});

// ---- GET /mod-files/:prid ----
prRouter.get("/mod-files/:prid", async (c) => {
  const prId = parseInt(c.req.param("prid"), 10);
  if (isNaN(prId)) {
    return c.json({ error: "Invalid PR ID" }, 400);
  }

  try {
    const token = c.get("oauthToken");
    const registry = getSharedRegistry();
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);

    // Use pr_get_context to get changed files
    const flow = registry.get("pr_get_context");
    const result = await executeFlow(flow, ctx, { prNumber: prId });

    return c.json(result);
  } catch (err) {
    return c.json({ error: "Failed to get mod files" }, 500);
  }
});
