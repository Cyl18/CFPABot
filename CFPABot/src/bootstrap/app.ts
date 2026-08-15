// src/bootstrap/app.ts
// Create Hono app with middleware and mount sub-routes.
// Extracted from legacy createHonoApp(config).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import type { EntryConfig } from "../config.js";
import { oauth } from "../api/oauth.js";
import { frontendRouter, protectedFrontend } from "../api/frontend.js";
import type { SessionsRouter } from "../api/sessions.js";
import { bmclModlistRouter } from "../api/bmcl-modlist.js";

/**
 * Create CSRF origin options shared by production and tests.
 * Accepts same-origin unconditionally; in development also allows any
 * http(s)://localhost|127.0.0.1 Vite origin (5173, 5174, …).
 */
export function createCSRFOptions(environment: "development" | "production"): Parameters<typeof csrf>[0] {
  return {
    origin: (origin, c) => {
      const urlOrigin = new URL(c.req.url).origin;
      if (origin === urlOrigin) return true;
      if (environment === "development") {
        try {
          const o = new URL(origin);
          if (
            (o.hostname === "localhost" || o.hostname === "127.0.0.1") &&
            (o.protocol === "http:" || o.protocol === "https:")
          ) {
            return true;
          }
        } catch {
          return false;
        }
      }
      return false;
    },
  };
}

/**
 * Create Hono app with all middleware and mounted routes.
 * Returned app is ready to be served via Bun.serve.
 */
export interface CreateHonoAppRoutes {
  webhookRouter: Hono;
  sessionsRouter: SessionsRouter;
}

export async function createHonoApp(config: EntryConfig, routes: CreateHonoAppRoutes): Promise<Hono> {
  // strict:false — accept both /api/sessions and /api/sessions/ for collection roots.
  // Hono's default strict=true treats them as distinct; frontend historically used trailing slash.
  const app = new Hono({ strict: false });

  // Middleware - CORS + security headers for all API routes
  app.use("/api/*", cors(), secureHeaders());
  app.use("/api/frontend/*", csrf(createCSRFOptions(config.environment)));
  // CSRF protection for cookie-authenticated browser mutation routes.
  // Hono csrf() auto-allows GET/HEAD and skips non-form content types (JSON etc.),
  // so webhook POST (JSON, no browser Origin) and JSON API calls pass through.
  // text/plain IS a form-like type and DOES get checked — browsers can submit
  // form-data with text/plain via <form enctype="text/plain">.
  app.use("/api/sessions/*", csrf(createCSRFOptions(config.environment)));

  // ---- Non-API routes ----

  app.get("/healthcheck", (c) => c.text("OK"));

  app.get("/robots.txt", (c) =>
    c.text("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain" },
    }),
  );

  // Serve frontend static assets (built by Vite -> public/assets/)
  app.get("/assets/*", async (c) => {
    const url = new URL(c.req.url);
    const filePath = `./public${url.pathname}`;
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return c.notFound();

    const ext = filePath.split('.').pop() || '';
    const contentTypes: Record<string, string> = {
      js: 'application/javascript',
      css: 'text/css',
      map: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    // 仅对含内容 hash 的文件名(index-abc12345.js 等)长缓存;
    // 无 hash 的文件内容可能原地更新,no-cache 避免浏览器拿到过期版本
    const baseName = url.pathname.split('/').pop() ?? '';
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    const hasContentHash = /[-.][a-f0-9]{8,}$/i.test(nameWithoutExt);
    return new Response(file, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': ext === 'map' || !hasContentHash ? 'no-cache' : 'public, max-age=31536000',
      },
    });
  });
  // Serve frontend HTML (public/index.html) - production SPA entry
  // In dev, public/ is empty; frontend runs on Vite dev server (port 5173)
  const indexHtml = Bun.file("public/index.html");
  if (config.environment === "production") {
    // Fail-fast: production must have a built frontend
    if (!(await indexHtml.exists())) {
      throw new Error(
        "生产模式下缺少 public/index.html，前端构建产物不存在。请先执行 bun run build 构建前端。",
      );
    }
    app.get("/", async (c) => c.html(await indexHtml.text()));
    app.get("/index.html", async (c) => c.html(await indexHtml.text()));
  }

  // ---- Mount route modules ----
  app.route("/api/oauth", oauth);
  app.route("/api", routes.webhookRouter);
  app.route("/api/frontend", frontendRouter);
  app.route("/api/frontend", protectedFrontend);
  app.route("/api", bmclModlistRouter);
  app.route("/api/sessions", routes.sessionsRouter);

  return app;
}
