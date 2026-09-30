import { statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "../env.ts";
import { paths } from "../paths.ts";
import { ttlCache } from "../ttl.ts";
import { gh } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import { mods } from "../mods/index.ts";
import { prdata } from "../prdata.ts";
import { getCheckReport, refreshInfoComment } from "../bot/index.ts";
import { llm } from "../agent/index.ts";
import { compareWorkspace, crossVersionKeys, modSource, prDetail, specialFiles, textCompare } from "../compare.ts";
import { currentUser, requireAdmin } from "./auth.ts";
import type { AppContext, AppEnv } from "./auth.ts";
import { HttpError, isUpstreamNotFound, notFound, parseBody, parseQuery } from "./errors.ts";
import type { SystemStatus, TextCompareRequest } from "../../shared/api.ts";

export const prRoutes = new Hono<AppEnv>();

const stateQuery = z.object({ state: z.enum(["open", "closed", "merged", "all"]).default("open") });
const workspaceQuery = z.object({
  slug: z.string().min(1),
  version: z.string().min(1),
  namespace: z.string().min(1),
});
const versionsQuery = z.object({
  namespace: z.string().min(1).optional(),
  pr: z.coerce.number().int().positive().optional(),
  versions: z.string().optional(),
});

function versionSelection(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return list.length === 0 ? undefined : list;
}

const textCompareSchema = z.object({
  left: z.object({ name: z.string().min(1), content: z.string().max(5_000_000) }),
  right: z.object({ name: z.string().min(1), content: z.string().max(5_000_000) }),
});
const modsQuery = z.object({ q: z.string().optional() });

function prNumber(c: AppContext): number {
  const raw = c.req.param("n");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "PR 编号无效", "invalid_pr");
  return n;
}

async function withPull<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUpstreamNotFound(err)) throw notFound("PR 不存在");
    throw err;
  }
}

prRoutes.get("/me", (c) => c.json(currentUser(c)));

async function rateLimitOrNull(): Promise<{ remaining: number; limit: number; resetAt: string } | null> {
  const timeout = Bun.sleep(5000).then(() => null);
  return Promise.race([gh.rateLimit().catch(() => null), timeout]);
}

prRoutes.get("/status", async (c) => {
  await requireAdmin(c);
  const [rateLimit, config, mappings] = await Promise.all([
    rateLimitOrNull(),
    llm.view(),
    mods.mappings.list(),
  ]);
  const modList = await mirror.modList().catch(() => null);
  const status: SystemStatus = {
    github: { mode: gh.mode, ...(rateLimit ? { rateLimit } : {}) },
    webhook: Boolean(env.GITHUB_WEBHOOK_SECRET),
    curseforge: Boolean(env.CURSEFORGE_API_KEY),
    glossary: Boolean(env.GLOSSARY_BIN),
    llm: { agent: config.agent, reviewers: config.reviewers },
    prCache: prdata.stats(),
    modList: { updatedAt: modList?.updatedAt ?? null, count: modList?.mods.length ?? 0 },
    mappings: { count: mappings.length, updatedAt: mappingsUpdatedAt() },
  };
  return c.json(status);
});

function mappingsUpdatedAt(): string | null {
  try {
    return statSync(join(paths.state, "mappings.json")).mtime.toISOString();
  } catch {
    return null;
  }
}

prRoutes.get("/prs", async (c) => {
  const { state } = parseQuery(c, stateQuery);
  return c.json(await prdata.list(state));
});

prRoutes.get("/prs/:n", async (c) => c.json(await withPull(() => prDetail(prNumber(c)))));

prRoutes.get("/prs/:n/checks", async (c) => c.json(await withPull(() => getCheckReport(prNumber(c)))));

prRoutes.post("/prs/:n/refresh", async (c) => {
  await requireAdmin(c);
  await withPull(() => refreshInfoComment(prNumber(c), { force: true }));
  return c.json({ ok: true });
});

prRoutes.get("/prs/:n/compare", async (c) => {
  const key = parseQuery(c, workspaceQuery);
  const n = prNumber(c);
  return c.json(await withPull(() => compareWorkspace(n, key)));
});

prRoutes.get("/prs/:n/mod-source", async (c) => {
  const key = parseQuery(c, workspaceQuery);
  const n = prNumber(c);
  return c.json(await withPull(() => modSource(n, key)));
});

prRoutes.get("/prs/:n/special", async (c) => c.json(await withPull(() => specialFiles(prNumber(c)))));

prRoutes.get("/versions/:slug/keys", async (c) => {
  const { namespace, pr, versions } = parseQuery(c, versionsQuery);
  return c.json(await crossVersionKeys(c.req.param("slug"), { namespace, pr, versions: versionSelection(versions) }));
});

prRoutes.post("/compare/text", async (c) => {
  const body = await parseBody<TextCompareRequest>(c, textCompareSchema);
  return c.json(textCompare(body));
});

prRoutes.get("/mods", async (c) => {
  const { q } = parseQuery(c, modsQuery);
  const list = await mirror.modList();
  if (!q) return c.json(list);
  const needle = q.trim().toLowerCase();
  return c.json({
    ...list,
    mods: list.mods.filter((mod) => mod.slug.toLowerCase().includes(needle) || (mod.name ?? "").toLowerCase().includes(needle)),
  });
});

interface BakaXlVersion {
  version: string;
  loader: string;
  repoLink: string;
}

interface BakaXlMod {
  modSlug: string;
  modName: string;
  modDomain: string;
  curseForgeLink: string;
  versions: BakaXlVersion[];
}

const bakaXlCache = ttlCache<{ modlist: BakaXlMod[]; lastUpdate: string }>(60_000, 4);

prRoutes.get("/BakaXL/ModList", async (c) => {
  const payload = await bakaXlCache.wrap("modlist", async () => {
    const list = await mirror.modList();
    return {
      modlist: list.mods.map((mod) => ({
        modSlug: mod.slug,
        modName: mod.name ?? mod.slug,
        modDomain: mod.slug,
        curseForgeLink: `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`,
        versions: mod.versions.map((entry) => ({
          version: entry.version,
          loader: "Forge",
          repoLink: `projects/assets/${mod.slug}/${entry.version}`,
        })),
      })),
      lastUpdate: list.updatedAt ?? new Date().toISOString(),
    };
  });
  return c.json(payload);
});

prRoutes.get("/BMCL/ModList", (c) => c.redirect("/api/BakaXL/ModList", 301));
