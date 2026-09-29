import { Hono } from "hono";
import { z } from "zod";
import { logger, recentLogs } from "../log.ts";
import { mirror } from "../mirror.ts";
import { mods } from "../mods/index.ts";
import { prdata } from "../prdata.ts";
import { llm } from "../agent/index.ts";
import { requireAdmin } from "./auth.ts";
import type { AppEnv } from "./auth.ts";
import { HttpError, parseBody, parseQuery } from "./errors.ts";
import type { LlmConfigUpdate, ProbeModelsRequest } from "../../shared/api.ts";

export const adminRoutes = new Hono<AppEnv>();

const log = logger("admin");

const logsQuery = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

const mappingSchema = z.object({
  slug: z.string().min(1),
  curseforgeId: z.number().int().positive(),
});

const llmUpdateSchema = z.object({
  endpoints: z.array(
    z.object({
      id: z.string().min(1),
      provider: z.string().min(1),
      protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]),
      baseUrl: z.string().min(1),
      apiKey: z.string().optional(),
      model: z.string().min(1),
      contextWindow: z.number().int().positive().optional(),
      maxOutput: z.number().int().positive().optional(),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    }),
  ),
  agent: z.string().optional(),
  reviewers: z.array(z.string()),
});

const llmTestSchema = z.object({ endpointId: z.string().min(1) });

const probeSchema = z.object({
  baseUrl: z.string().min(1),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]),
  apiKey: z.string().optional(),
  endpointId: z.string().optional(),
});

adminRoutes.use("*", async (c, next) => {
  await requireAdmin(c);
  await next();
});

adminRoutes.get("/logs", (c) => {
  const { level, limit } = parseQuery(c, logsQuery);
  return c.json(recentLogs(limit, level));
});

adminRoutes.get("/mappings", async (c) => {
  const [list, mappings] = await Promise.all([mirror.modList(), mods.mappings.list()]);
  const known = new Set(mappings.map((entry) => entry.slug));
  return c.json({ mappings, unmapped: list.mods.map((mod) => mod.slug).filter((slug) => !known.has(slug)) });
});

adminRoutes.put("/mappings", async (c) => {
  const { slug, curseforgeId } = await parseBody(c, mappingSchema);
  await mods.mappings.set(slug, curseforgeId);
  mods.invalidate(slug);
  return c.json({ ok: true });
});

adminRoutes.post("/cache/:what", (c) => {
  const what = c.req.param("what");
  const background = (name: string, task: () => Promise<unknown>): void => {
    void task().catch((err: unknown) => log.error(`${name} 刷新失败`, { err }));
  };
  if (what === "prs") background("PR 缓存", () => prdata.refreshAll());
  else if (what === "mirror") background("镜像", () => mirror.sync());
  else if (what === "mappings") background("映射", () => mods.mappings.scan());
  else throw new HttpError(400, "未知的缓存类型", "invalid_cache");
  return c.json({ ok: true });
});

adminRoutes.get("/llm", async (c) => c.json(await llm.view()));

adminRoutes.put("/llm", async (c) => {
  const update = await parseBody<LlmConfigUpdate>(c, llmUpdateSchema);
  return c.json(await llm.update(update));
});

adminRoutes.post("/llm/test", async (c) => {
  const { endpointId } = await parseBody(c, llmTestSchema);
  return c.json(await llm.test(endpointId));
});

adminRoutes.post("/llm/probe", async (c) => {
  const request = await parseBody<ProbeModelsRequest>(c, probeSchema);
  return c.json({ models: await llm.probe(request) });
});
