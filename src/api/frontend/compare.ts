// src/api/frontend/compare.ts
// Compare tool routes: GET /compare/:prId, POST /compare/upload,
// GET /compare/:prId/special-diff, POST /compare/:prId/workspace, and GET /compare/:prId/workspaces.
// Thin HTTP adapters - all business logic delegated to compare_* Flows via executeFlow().

import { Hono } from "hono";
import { MAX_BODY_SIZE, evictCache, type AppVariables } from "./helpers.js";
import { buildUserFlowContext } from "@/api/flow-context.js";
import { getSharedRegistry } from "@/engine/registry-store.js";
import { executeFlow } from "@/engine/execute.js";
import { COMPARE_SOURCES_CACHE_TTL_MS } from "@/constants.js";
import { sendApiError } from "../body.js";

export const compareRouter = new Hono<{ Variables: AppVariables }>();

// In-process cache for GET /compare/:prId results (sources list is expensive to build).
// Invalidate via invalidateCompareSourcesCache() when a PR changes.
const compareSourcesCache = new Map<string, { data: unknown; fetchedAt: number }>();
const MAX_ENTRIES = 200;

export function invalidateCompareSourcesCache(prNumber: number): void {
  const prefix = `${prNumber}-`;
  for (const key of compareSourcesCache.keys()) {
    if (key.startsWith(prefix)) compareSourcesCache.delete(key);
  }
}

// ---- GET /compare/:prId ----
compareRouter.get("/compare/:prId", async (c) => {
  const prId = parseInt(c.req.param("prId"), 10);
  if (isNaN(prId)) {
    return c.json({ error: "Invalid PR ID" }, 400);
  }
  const modIdFilter = c.req.query("modId");
  const cacheKey = `${prId}-${modIdFilter || ""}`;
  const cached = compareSourcesCache.get(cacheKey);
  if (cached) {
    compareSourcesCache.delete(cacheKey);
    compareSourcesCache.set(cacheKey, cached);
    if (Date.now() - cached.fetchedAt < COMPARE_SOURCES_CACHE_TTL_MS) {
      return c.json(cached.data);
    }
  }

  const token = c.get("oauthToken");
  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const flow = getSharedRegistry().get("compare_get_sources");
    const result = await executeFlow(flow, ctx, {
      prNumber: prId,
      ...(modIdFilter ? { modIdFilter } : {}),
    });

    compareSourcesCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    evictCache(compareSourcesCache, MAX_ENTRIES);

    return c.json(result);
  } catch (err) {
    return sendApiError(c, err);
  }
});

// ---- POST /compare/upload ----
compareRouter.post("/compare/upload", async (c) => {
  const uploadContentLength = parseInt(c.req.header("content-length") ?? "0", 10);
  if (uploadContentLength > MAX_BODY_SIZE) return c.json({ error: "请求体过大" }, 413);

  const formData = await c.req.formData();
  const fileA = formData.get("fileA");
  const fileB = formData.get("fileB");

  if (!fileA || !(fileA instanceof File)) return c.json({ error: "fileA is required (multipart file)" }, 400);
  if (!fileB || !(fileB instanceof File)) return c.json({ error: "fileB is required (multipart file)" }, 400);

  const token = c.get("oauthToken");
  if (!token) return c.json({ error: "Authentication required" }, 401);

  try {
    const [textA, textB] = await Promise.all([fileA.text(), fileB.text()]);
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const flow = getSharedRegistry().get("compare_upload");
    const result = await executeFlow(flow, ctx, {
      textA,
      textB,
      nameA: fileA.name,
      nameB: fileB.name,
    });
    return c.json(result);
  } catch (err) {
    return sendApiError(c, err, { prefix: "Upload compare failed" });
  }
});

// ---- GET /compare/:prId/special-diff ----
compareRouter.get("/compare/:prId/special-diff", async (c) => {
  const prId = parseInt(c.req.param("prId"), 10);
  if (isNaN(prId)) return c.json({ error: "Invalid PR ID" }, 400);

  const token = c.get("oauthToken");
  if (!token) return c.json({ error: "Authentication required" }, 401);

  try {
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const flow = getSharedRegistry().get("compare_special_diff");
    const result = await executeFlow(flow, ctx, { prNumber: prId });
    return c.json(result);
  } catch (err) {
    return sendApiError(c, err, { prefix: "Special diff failed" });
  }
});

// ---- GET /compare/:prId/workspaces ----
compareRouter.get("/compare/:prId/workspaces", async (c) => {
  const prId = parseInt(c.req.param("prId"), 10);
  if (isNaN(prId)) return c.json({ error: "Invalid PR ID" }, 400);

  const token = c.get("oauthToken");
  if (!token) return c.json({ error: "Authentication required" }, 401);

  try {
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const flow = getSharedRegistry().get("compare_list_workspaces");
    const result = await executeFlow(flow, ctx, { prNumber: prId });
    return c.json(result);
  } catch (err) {
    return sendApiError(c, err);
  }
});
// ---- GET /compare/versions/:slug?namespace=&pr= ----
// Cross-version consistency matrix for a fixed (slug, namespace) on the main branch.
compareRouter.get("/compare/versions/:slug", async (c) => {
  const slug = c.req.param("slug");
  const namespace = c.req.query("namespace") ?? slug;
  const prQuery = c.req.query("pr");
  const prNumber = prQuery !== undefined ? parseInt(prQuery, 10) : undefined;
  if (prNumber !== undefined && isNaN(prNumber)) {
    return c.json({ error: "Invalid pr query parameter" }, 400);
  }
  if (!slug) return c.json({ error: "slug is required" }, 400);

  const token = c.get("oauthToken");
  if (!token) return c.json({ error: "Authentication required" }, 401);

  try {
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const flow = getSharedRegistry().get("compare_cross_version");
    const result = await executeFlow(flow, ctx, {
      slug,
      namespace,
      ...(prNumber !== undefined ? { prNumber } : {}),
    });
    return c.json(result);
  } catch (err) {
    return sendApiError(c, err);
  }
});

// ---- POST /compare/:prId/workspace ----
compareRouter.post("/compare/:prId/workspace", async (c) => {
  const doContentLength = parseInt(c.req.header("content-length") ?? "0", 10);
  if (doContentLength > MAX_BODY_SIZE) return c.json({ error: "请求体过大" }, 413);

  const prId = parseInt(c.req.param("prId"), 10);
  if (isNaN(prId)) return c.json({ error: "Invalid PR ID" }, 400);

  const body = await c.req.json<{
    slug: string;
    version: string;
    namespace: string;
  }>();

  if (!body.slug || !body.version || !body.namespace) {
    return c.json({ error: "slug, version, namespace are required" }, 400);
  }

  const token = c.get("oauthToken");
  if (!token) return c.json({ error: "Authentication required" }, 401);

  try {
    const ctx = buildUserFlowContext(token, c.get("user") ?? undefined);
    const flow = getSharedRegistry().get("compare_workspace");
    const result = await executeFlow(flow, ctx, {
      prNumber: prId,
      slug: body.slug,
      version: body.version,
      namespace: body.namespace,
    });
    return c.json(result);
  } catch (err) {
    return sendApiError(c, err);
  }
});
