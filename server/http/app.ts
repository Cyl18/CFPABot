import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { env, isDev } from "../env.ts";
import { logger } from "../log.ts";
import { authMiddleware } from "./auth.ts";
import type { AppEnv } from "./auth.ts";
import { authRoutes } from "./auth-routes.ts";
import { prRoutes } from "./routes-pr.ts";
import { sessionRoutes } from "./routes-agent.ts";
import { adminRoutes } from "./routes-admin.ts";
import { utilsRoutes } from "./routes-utils.ts";
import { webhookRoutes } from "./webhook.ts";
import { serveStatic } from "./static.ts";
import { HttpError, errorResponse, jsonError } from "./errors.ts";
import type { Context } from "hono";

const log = logger("http");

function allowedOrigins(c: Context<AppEnv>): Set<string> {
  const origins = new Set<string>([env.PUBLIC_URL, new URL(c.req.url).origin]);
  if (isDev) {
    origins.add(`http://localhost:${env.PORT}`);
    origins.add(`http://127.0.0.1:${env.PORT}`);
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return origins;
}

async function csrfGuard(c: Context<AppEnv>): Promise<void> {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) return;
  const origin = c.req.header("origin");
  if (origin && allowedOrigins(c).has(origin.replace(/\/+$/, ""))) return;
  throw new HttpError(403, "跨站请求被拒绝", "csrf");
}

export const app = new Hono<AppEnv>({ strict: false });

app.use("*", secureHeaders());
app.use("/api/*", async (c, next) => {
  await csrfGuard(c);
  await next();
});
app.use("/api/*", authMiddleware);

app.get("/healthz", (c) => c.text("OK"));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n", 200, { "Content-Type": "text/plain; charset=utf-8" }));

app.route("/auth", authRoutes);
app.route("/api", webhookRoutes);
app.route("/api", prRoutes);
app.route("/api", utilsRoutes);
app.route("/api/sessions", sessionRoutes);
app.route("/api/admin", adminRoutes);

app.notFound(async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/auth/")) return jsonError(c, 404, "未找到", "not_found");
  return serveStatic(c);
});

app.onError((err, c) => {
  const { status, body } = errorResponse(err, c.req.path);
  if (status >= 500) log.error("请求处理失败", { method: c.req.method, path: c.req.path, err });
  else if (!(err instanceof HttpError)) log.warn("请求被拒绝", { method: c.req.method, path: c.req.path, err });
  return c.json(body, status);
});
