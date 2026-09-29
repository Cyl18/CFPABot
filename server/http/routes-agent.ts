import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { agent } from "../agent/index.ts";
import { requireAdmin } from "./auth.ts";
import type { AppEnv } from "./auth.ts";
import { notFound, parseBody } from "./errors.ts";
import type { CreateSessionRequest, ReviewDraft, SessionEvent } from "../../shared/api.ts";

export const sessionRoutes = new Hono<AppEnv>();

const createSchema = z.object({
  prNumber: z.number().int().positive().optional(),
  message: z.string().optional(),
  review: z.boolean().optional(),
  model: z.string().optional(),
});

const messageSchema = z.object({ text: z.string().min(1) });

const draftSchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  verdict: z.enum(["approve", "changes", "reject"]),
  summary: z.string(),
  comments: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      line: z.number().int().positive(),
      key: z.string(),
      severity: z.enum(["critical", "major", "minor", "neutral"]),
      mqm: z.string(),
      en: z.string().optional(),
      zh: z.string().optional(),
      body: z.string(),
      suggestion: z.string().optional(),
      covers: z.array(z.string()).optional(),
      suspected: z.boolean().optional(),
    }),
  ),
});

sessionRoutes.use("*", async (c, next) => {
  await requireAdmin(c);
  await next();
});

sessionRoutes.get("/", async (c) => c.json(await agent.list()));

sessionRoutes.post("/", async (c) => {
  const user = await requireAdmin(c);
  const body = await parseBody<CreateSessionRequest>(c, createSchema);
  return c.json(await agent.create({ ...body, createdBy: user.login, source: "web" }));
});

sessionRoutes.get("/:id", async (c) => {
  const session = await agent.get(c.req.param("id"));
  if (!session) throw notFound("会话不存在");
  return c.json(session);
});

sessionRoutes.post("/:id/messages", async (c) => {
  const { text } = await parseBody(c, messageSchema);
  await agent.send(c.req.param("id"), text);
  return c.json({ ok: true });
});

sessionRoutes.post("/:id/abort", async (c) => {
  await agent.abort(c.req.param("id"));
  return c.json({ ok: true });
});

sessionRoutes.post("/:id/archive", async (c) => {
  await agent.archive(c.req.param("id"));
  return c.json({ ok: true });
});

sessionRoutes.put("/:id/draft", async (c) => {
  const draft = await parseBody<Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">>(c, draftSchema);
  return c.json(await agent.saveDraft(c.req.param("id"), draft));
});

sessionRoutes.post("/:id/publish", async (c) => {
  const user = await requireAdmin(c);
  return c.json(await agent.publish(c.req.param("id"), user.login));
});

sessionRoutes.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  const session = await agent.get(id);
  if (!session) throw notFound("会话不存在");
  return streamSSE(c, async (stream) => {
    const unsubscribe = agent.subscribe(id, (event: SessionEvent) => {
      void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => undefined);
    });
    const timer = setInterval(() => {
      const ping: SessionEvent = { type: "ping" };
      void stream.writeSSE({ data: JSON.stringify(ping) }).catch(() => undefined);
    }, 15_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });
    clearInterval(timer);
    unsubscribe();
  });
});
