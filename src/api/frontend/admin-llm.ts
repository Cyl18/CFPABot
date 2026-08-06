// src/api/frontend/admin-llm.ts
// Admin sub-router for LLM endpoint configuration.
// Designed to be mounted under the protected frontend at /admin/llm-endpoints.
// All routes require admin auth; the router delegates to llm-config-store for I/O
// so no node:fs import lives in the API layer.
//
// Supports backward-compatible storage: config/llm-endpoints.json may be either an
// array (legacy) or an object { endpoints, defaults? }.

import {
  fetchProviderModels,
  ModelsProbeValidationError,
  ModelsProbeUpstreamError,
} from "@/client/llm-models.js";
import { Hono } from "hono";
import { Type } from "typebox";
import type { AppVariables } from "./helpers.js";
import { requireAdmin } from "@/api/auth.js";
import { loadConfig, saveConfig, ConfigValidationError } from "@/agent/llm-config-store.js";
import { parseLlmEndpoints } from "@/agent/llm-endpoints.js";
import { isKnownProtocol } from "@/agent/llm-types.js";
import { testLlmEndpoint } from "@/agent/llm-registry.js";
import { parseBody, sendApiError } from "@/api/body.js";

export const adminLlmRouter = new Hono<{ Variables: AppVariables }>();

// All routes require admin auth
adminLlmRouter.use("*", requireAdmin);

// ─── Body schemas (parseBody validates; business rules stay in handlers) ──

const TestBodySchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
});

const ProbeBodySchema = Type.Object({
  baseUrl: Type.Optional(Type.String()),
  apiKey: Type.Optional(Type.String()),
  protocol: Type.Optional(Type.String()),
  ref: Type.Optional(
    Type.Object({
      provider: Type.String(),
      modelId: Type.String(),
    }),
  ),
});

// GET /admin/llm-endpoints -- list endpoints (apiKey is always "", hasApiKey boolean) + defaults
adminLlmRouter.get("/", (c) => {
  const config = loadConfig();
  return c.json(config);
});

// PUT /admin/llm-endpoints -- validate, merge keys, persist
adminLlmRouter.put("/", async (c) => {
  try {
    // saveConfig does the deep validation (endpoints + defaults cross-refs);
    // parseBody with Type.Unknown() only guards JSON parse + body size here.
    const body = await parseBody(c, Type.Unknown());
    await saveConfig(body);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return c.json({ error: err.message }, 400);
    }
    return sendApiError(c, err);
  }
});

// POST /admin/llm-endpoints/test — send "你好" to a saved endpoint and report status.
// Body: { provider: string, modelId: string } → { ok: true, reply } | { ok: false, error }.
// Uses the stored apiKey (never exposed to the client).
// 400 on bad input / unknown endpoint, 502 on upstream failure or timeout.
adminLlmRouter.post("/test", async (c) => {
  try {
    const body = await parseBody(c, TestBodySchema);
    const provider = body.provider.trim();
    const modelId = body.modelId.trim();
    if (!provider || !modelId) {
      return c.json({ ok: false, error: "provider 和 modelId 必填" }, 400);
    }

    // parseLlmEndpoints() returns the stored config with real apiKeys — loadConfig()
    // strips key material and is only for GET responses.
    const ep = parseLlmEndpoints().find(
      (e) => e.provider === provider && e.modelId === modelId,
    );
    if (!ep) {
      return c.json({ ok: false, error: `端点 ${provider}/${modelId} 不在已保存的配置中` }, 400);
    }

    const reply = await testLlmEndpoint(ep);
    return c.json({ ok: true, reply: reply.slice(0, 200) });
  } catch (err) {
    return sendApiError(c, err);
  }
});

// POST /admin/llm-endpoints/probe-models — server-side proxy to provider /models.
// Two modes:
//   direct: { baseUrl, apiKey, protocol? }  — add-mode form values
//   ref:    { ref: { provider, modelId }, baseUrl?, apiKey?, protocol? } —
//           edit mode; direct fields override the stored endpoint, missing
//           values fall back to the stored config (apiKey is never echoed to
//           the client, so this is the only way to probe a saved endpoint
//           without re-typing the key).
// Never logs apiKey. 400 on bad input, 502 on upstream failure.
adminLlmRouter.post("/probe-models", async (c) => {
  try {
    const body = await parseBody(c, ProbeBodySchema);
    let baseUrl = body.baseUrl?.trim() ?? "";
    let apiKey = body.apiKey ?? "";
    let protocol =
      body.protocol && isKnownProtocol(body.protocol) ? body.protocol : undefined;

    if (body.ref) {
      const refProvider = body.ref.provider.trim();
      const refModelId = body.ref.modelId.trim();
      if (!refProvider || !refModelId) {
        return c.json({ error: "ref 需要 provider 和 modelId" }, 400);
      }
      const stored = parseLlmEndpoints().find(
        (e) => e.provider === refProvider && e.modelId === refModelId,
      );
      if (!stored) {
        return c.json({ error: `端点 ${refProvider}/${refModelId} 不在已保存的配置中` }, 400);
      }
      if (!baseUrl) baseUrl = stored.baseUrl;
      if (!apiKey) apiKey = stored.apiKey;
      if (!protocol) protocol = stored.protocol;
    }

    const models = await fetchProviderModels(baseUrl, apiKey, protocol);
    return c.json({ models });
  } catch (err) {
    if (err instanceof ModelsProbeValidationError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof ModelsProbeUpstreamError) {
      return c.json(
        { error: "无法拉取端点模型", detail: err.message },
        502,
      );
    }
    return sendApiError(c, err);
  }
});
