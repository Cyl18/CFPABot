// 契约测试: PUT /admin/llm-endpoints 的 HTTP 行为。
// 用前置中间件伪造 isAdmin 绕过 requireAdmin(它只读 c.get("isAdmin")),
// 直发 app.request 验证 parseBody → sendApiError 的 400/413 路径。
// 只测失败路径 — 合法 body 会写 config/llm-endpoints.json, 不碰。

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminLlmRouter } from "../api/frontend/admin-llm.js";
import type { AppVariables } from "../api/frontend/helpers.js";

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  c.set("isAdmin", true);
  await next();
});
app.route("/", adminLlmRouter);

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("PUT /admin/llm-endpoints", () => {
  test("invalid JSON body → 400 (HttpBodyError path, not 500)", async () => {
    const res = await app.request("/", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: "not-json{{",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("JSON");
  });

  test("structurally invalid body → 400 (schema path)", async () => {
    const res = await app.request("/", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoints: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  test("business-rule failure (blank provider) → 400 without touching disk", async () => {
    const res = await app.request("/", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        endpoints: [{ provider: "  ", modelId: "gpt-4o", baseUrl: "https://api.openai.com/v1" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("non-admin → 403 (requireAdmin still guards)", async () => {
    const guarded = new Hono<{ Variables: AppVariables }>();
    guarded.route("/", adminLlmRouter);
    const res = await guarded.request("/", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: "not-json",
    });
    expect(res.status).toBe(403);
  });
});
