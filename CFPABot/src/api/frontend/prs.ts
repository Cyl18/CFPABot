// src/api/frontend/prs.ts
// PR list routes: GET /prs, POST /refresh-prs-cache.
// Thin HTTP adapter — delegates list + refresh to pr_list Flow.
// The flow coalesces concurrent refreshes; API layer just calls executeFlow.

import { requireAdmin } from "@/api/auth.js";
import { executeFlow } from "@/engine/execute.js";
import { buildUserFlowContext, getApiLogger } from "@/api/flow-context.js";
import { pr_list } from "@/flows/pr/pr_list.js";
import { Hono } from "hono";
import type { AppVariables } from "./helpers.js";

export const prsRouter = new Hono<{ Variables: AppVariables }>();

// ---- GET /prs ----
prsRouter.get("/prs", async (c) => {
  const token = c.get("oauthToken");
  const ctx = buildUserFlowContext(token, undefined);
  // Surface the complete set: default state=all, parse per_page (capped 500)
  // so the dashboard/PR list aren't silently truncated at 100.
  const rawState = (c.req.query("state") || "all").toLowerCase();
  const state = (["open", "closed", "all"].includes(rawState) ? rawState : "all") as "open" | "closed" | "all";
  const perPageRaw = Number.parseInt(c.req.query("per_page") || "500", 10);
  const pageSize = Number.isFinite(perPageRaw) ? Math.min(Math.max(perPageRaw, 1), 500) : 500;
  const result = await executeFlow<typeof pr_list.input, typeof pr_list.output>(
    pr_list,
    ctx,
    {
      state,
      sort: "updated_desc",
      format: "frontend",
      refreshIfEmpty: true,
      pageSize,
      source: "index",
    },
  );
  // Return flat frontend shape (matches web/src/lib/api.ts)
  return c.json((result as { frontendItems?: unknown[] }).frontendItems ?? []);
});

// ---- POST /refresh-prs-cache ----
prsRouter.post("/refresh-prs-cache", requireAdmin, async (c) => {
  const token = c.get("oauthToken");
  const ctx = buildUserFlowContext(token, undefined);
  // Fire-and-forget: the flow coalesces concurrent refreshes via fullListAndRefresh
  void executeFlow<typeof pr_list.input, typeof pr_list.output>(
    pr_list,
    ctx,
    {
      state: "open",
      sort: "updated_desc",
      format: "frontend",
      refreshIfEmpty: true,
      pageSize: 100,
      source: "index",
    },
  ).catch((err: unknown) => {
    // 静默失败会掩盖刷新异常 — 记录日志便于排查
    getApiLogger().error({ err: String(err) }, "[prs] 刷新 PR 缓存失败");
  });
  return c.json({ message: "缓存刷新已触发" });
});
