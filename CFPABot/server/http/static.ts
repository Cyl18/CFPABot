import { resolve, sep } from "node:path";
import type { Context } from "hono";
import { paths } from "../paths.ts";

const HASHED_ASSET = /[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export async function serveStatic(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return notFound(c);
  }
  if (rel.endsWith("/")) rel += "index.html";
  const full = resolve(paths.public, `.${rel}`);
  if (full !== paths.public && !full.startsWith(`${paths.public}${sep}`)) return notFound(c);

  const file = Bun.file(full);
  if (await file.exists()) {
    const name = full.slice(full.lastIndexOf(sep) + 1);
    return new Response(file, {
      headers: { "Cache-Control": HASHED_ASSET.test(name) ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }

  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const index = Bun.file(resolve(paths.public, "index.html"));
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    if (url.pathname === "/") return c.text("CFPAAgent2 服务运行中；前端尚未构建（bun run build）。", 404);
  }
  return notFound(c);
}

function notFound(c: Context): Response {
  return c.req.path.startsWith("/api/") ? c.json({ error: "Not Found" }, 404) : c.text("404 Not Found", 404);
}
