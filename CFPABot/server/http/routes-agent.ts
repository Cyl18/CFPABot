import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { agent } from "../agent/index.ts";
import { stopSubagent } from "../agent/subagents.ts";
import { requireAdmin } from "./auth.ts";
import type { AppEnv } from "./auth.ts";
import { notFound, parseBody } from "./errors.ts";
import { SCOPES, type CreateSessionRequest, type SessionEvent, type SessionListEvent } from "@cfpa/contracts/api";

export const sessionRoutes = new Hono<AppEnv>();

const createSchema = z.object({
  message: z.string().optional(),
  model: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  title: z.string().optional(),
  writeScope: z.enum(SCOPES).optional(),
  evalScope: z.enum(SCOPES).optional(),
  bashScope: z.enum(SCOPES).optional(),
});

const writeScopeSchema = z.object({ writeScope: z.enum(SCOPES) });
const evalScopeSchema = z.object({ evalScope: z.enum(SCOPES) });
const bashScopeSchema = z.object({ bashScope: z.enum(SCOPES) });
const configSchema = z.object({
  model: z.string().optional(),
  thinking: z.union([z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), z.null()]).optional(),
  prNumber: z.union([z.number().int().positive(), z.null()]).optional(),
});

const messageSchema = z.object({ text: z.string().min(1) });

sessionRoutes.use("*", async (c, next) => {
  await requireAdmin(c);
  await next();
});

sessionRoutes.get("/", async (c) => c.json(await agent.list()));

sessionRoutes.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = agent.subscribeAll(() => {
      const event: SessionListEvent = { type: "changed" };
      void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => undefined);
    });
    const timer = setInterval(() => {
      const ping: SessionListEvent = { type: "ping" };
      void stream.writeSSE({ data: JSON.stringify(ping) }).catch(() => undefined);
    }, 15_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });
    clearInterval(timer);
    unsubscribe();
  }),
);

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

sessionRoutes.get("/:id/artifact", async (c) => c.json(await agent.readArtifact(c.req.param("id"))));

sessionRoutes.get("/:id/files", async (c) => c.json(await agent.listFiles(c.req.param("id"))));

sessionRoutes.get("/:id/file", async (c) => c.json(await agent.readFile(c.req.param("id"), c.req.query("path") ?? "")));

sessionRoutes.patch("/:id/write-scope", async (c) => {
  const { writeScope } = await parseBody(c, writeScopeSchema);
  await agent.setWriteScope(c.req.param("id"), writeScope);
  return c.json({ ok: true });
});

sessionRoutes.patch("/:id/eval-scope", async (c) => {
  const { evalScope } = await parseBody(c, evalScopeSchema);
  await agent.setExecScope(c.req.param("id"), "evalScope", evalScope);
  return c.json({ ok: true });
});

sessionRoutes.patch("/:id/bash-scope", async (c) => {
  const { bashScope } = await parseBody(c, bashScopeSchema);
  await agent.setExecScope(c.req.param("id"), "bashScope", bashScope);
  return c.json({ ok: true });
});

sessionRoutes.patch("/:id/config", async (c) => {
  const patch = await parseBody(c, configSchema);
  await agent.setConfig(c.req.param("id"), patch);
  return c.json({ ok: true });
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

sessionRoutes.get("/:id/subagents/:agentId", async (c) => {
  const raw = Number(c.req.query("offset") ?? "0");
  const offset = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  return c.json(await agent.subagent(c.req.param("id"), c.req.param("agentId"), offset));
});

sessionRoutes.post("/:id/subagents/:agentId/abort", (c) =>
  c.json({ stopped: stopSubagent(c.req.param("agentId")) }),
);

sessionRoutes.post("/:id/archive", async (c) => {
  await agent.archive(c.req.param("id"));
  return c.json({ ok: true });
});

sessionRoutes.put("/:id/artifact", async (c) => {
  const input = await parseBody(c, z.unknown());
  return c.json(await agent.saveArtifact(c.req.param("id"), input));
});

sessionRoutes.post("/:id/publish", async (c) => {
  const user = await requireAdmin(c);
  return c.json(await agent.publishArtifact(c.req.param("id"), user.login));
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
