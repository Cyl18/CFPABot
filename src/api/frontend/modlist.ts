// src/api/frontend/modlist.ts
// Mod list route: GET /modlist
// Reads from runtime/cache/modlist.json (produced by modlist-refresh cron).
// Falls back to modlist_build Flow only when cache is missing.
// Route-level in-memory cache (short TTL) preserved.
// Business logic (cache-fallback decision + output shape mapping) delegated to modlist_get Flow.

import { Hono } from "hono";
import { executeFlow } from "@/engine/execute.js";
import { getSharedRegistry } from "@/engine/registry-store.js";
import { buildUserFlowContext, getApiLogger } from "@/api/flow-context.js";
import { type ModlistGetOutput } from "@/flows/cache/modlist_get.js";
import {
  type AppVariables,
  type ModlistEntry,
} from "./helpers.js";

export const modlistRouter = new Hono<{ Variables: AppVariables }>();

// ---- Modlist in-memory cache (short TTL) ----
let modlistCache: { data: ModlistEntry[]; fetchedAt: number } | null = null;
const MODLIST_TTL_MS = 5 * 60 * 1000;

// ---- GET /modlist ----
modlistRouter.get("/modlist", async (c) => {
  if (modlistCache && Date.now() - modlistCache.fetchedAt < MODLIST_TTL_MS) {
    return c.json(modlistCache.data);
  }

  try {
    const ctx = buildUserFlowContext(c.get("oauthToken"), undefined);
    const registry = getSharedRegistry();
    const flow = registry.get("modlist_get");
    const result = await executeFlow(flow, ctx, { token: c.get("oauthToken") }) as ModlistGetOutput;

    modlistCache = { data: result.entries, fetchedAt: Date.now() };
    return c.json(result.entries);
  } catch (err) {
    getApiLogger().error({ err }, "[modlist] modlist_get failed");
    // 500 不泄漏内部错误详情 — 仅返回通用信息
    return c.json({ error: "modlist_get failed" }, 500);
  }
});
