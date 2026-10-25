import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { commentVersionDir, compareMc } from "@cfpa/review-core/domain/path";
import { env, repo } from "../env.ts";
import { paths } from "../paths.ts";
import { ttlCache } from "../ttl.ts";
import { gh } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import { mods } from "../mods/index.ts";
import { prdata } from "../prdata.ts";
import { getCheckReport, isRefreshing, refreshInfoComment } from "../bot/index.ts";
import { track } from "../bot/pending.ts";
import { llm } from "../agent/index.ts";
import { parseRoleSelector } from "../agent/llm-providers.ts";
import { loadPack, packSummary } from "../harness/pack.ts";
import { reviewBrief } from "../harness/review/brief.ts";
import { rowsOf, type RowsOptions } from "../harness/review/rows.ts";
import { termsOf } from "../harness/review/terms.ts";
import { prDetail } from "../views/pr.ts";
import { compareWorkspace } from "../views/workspace.ts";
import { specialPairContent, specialPairs } from "../views/special.ts";
import { specialPageOf } from "../harness/review/special.ts";
import { crossVersionKeys } from "../views/cross-version.ts";
import { textCompare } from "../views/text.ts";
import { currentUser, requireAdmin } from "./auth.ts";
import type { AppContext, AppEnv } from "./auth.ts";
import { HttpError } from "../errors.ts";
import { isUpstreamNotFound, notFound, parseBody, parseQuery } from "./errors.ts";
import type { PublicEnv, SystemStatus, TextCompareRequest } from "@cfpa/contracts/api";

const glossaryBin = process.platform === "win32" ? "packtrans-glossary.exe" : "packtrans-glossary";
const glossaryAvailable =
  existsSync(join(paths.root, "runtime", "bin", glossaryBin)) || Bun.which("packtrans-glossary") !== null;

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
const rowsQuery = z.object({
  filter: z.enum(["reviewable", "changed", "flagged", "all"]).optional(),
  workspace: z.string().min(1).optional(),
  prefix: z.string().min(1).optional(),
  keys: z.string().optional(),
  query: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  include: z.string().optional(),
  rebuild: z.enum(["1"]).optional(),
});
const briefQuery = rowsQuery.extend({ review: z.enum(["1"]).optional() });
const termsQuery = z.object({
  changed: z.enum(["1"]).optional(),
  q: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  rebuild: z.enum(["1"]).optional(),
});
const specialQuery = z.object({ key: z.string().min(1) });
const specialFilesQuery = z.object({
  include: z.enum(["text"]).optional(),
  keys: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
const packQuery = z.object({ rebuild: z.enum(["1"]).optional() });

export function prNumber(c: AppContext): number {
  const raw = c.req.param("n");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "PR 编号无效", "invalid_pr");
  return n;
}

export async function withPull<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUpstreamNotFound(err)) throw notFound("PR 不存在");
    throw err;
  }
}

prRoutes.get("/me", (c) => c.json(currentUser(c)));

prRoutes.get("/env", (c) => c.json({ github: gh.mode } satisfies PublicEnv));

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
    glossary: glossaryAvailable,
    llm: {
      default: parseRoleSelector(config.roles.default ?? "").endpoint || config.endpoints[0]?.id,
      roles: Object.keys(config.roles).filter((role) => role !== "default"),
    },
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

prRoutes.get("/prs/:n/pack", async (c) => {
  await requireAdmin(c);
  const { rebuild } = parseQuery(c, packQuery);
  const n = prNumber(c);
  return c.json(await withPull(async () => packSummary(await loadPack(n, rebuild === "1"))));
});

function rowsOptionsOf(data: z.infer<typeof rowsQuery>): RowsOptions {
  const keys = (data.keys ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const include = new Set((data.include ?? "terms,threads,duplicates").split(",").map((name) => name.trim()));
  const all = include.has("all");
  return {
    filter: data.filter ?? "reviewable",
    ...(data.workspace === undefined ? {} : { workspace: data.workspace }),
    ...(data.prefix === undefined ? {} : { prefix: data.prefix }),
    ...(keys.length === 0 ? {} : { keys }),
    ...(data.query === undefined ? {} : { query: data.query }),
    ...(data.offset === undefined ? {} : { offset: data.offset }),
    ...(data.limit === undefined ? {} : { limit: data.limit }),
    rebuild: data.rebuild === "1",
    include: {
      terms: all || include.has("terms"),
      threads: all || include.has("threads"),
      duplicates: all || include.has("duplicates"),
      patch: all || include.has("patch"),
    },
  };
}

prRoutes.get("/prs/:n/brief", async (c) => {
  const data = parseQuery(c, briefQuery);
  const n = prNumber(c);
  return c.json(
    await withPull(() =>
      reviewBrief(n, {
        review: data.review === "1",
        rows: { ...rowsOptionsOf(data), limit: data.limit ?? 120 },
      }),
    ),
  );
});

prRoutes.get("/prs/:n/rows", async (c) => {
  const data = parseQuery(c, rowsQuery);
  const n = prNumber(c);
  return c.json(await withPull(() => rowsOf(n, rowsOptionsOf(data))));
});

prRoutes.get("/prs/:n/terms", async (c) => {
  const data = parseQuery(c, termsQuery);
  const n = prNumber(c);
  const queries = [...(c.req.queries("term") ?? []), ...(data.q === undefined ? [] : [data.q])];
  return c.json(
    await withPull(() =>
      termsOf(n, {
        queries,
        changed: data.changed === "1" || queries.length === 0,
        ...(data.offset === undefined ? {} : { offset: data.offset }),
        ...(data.limit === undefined ? {} : { limit: data.limit }),
        rebuild: data.rebuild === "1",
      }),
    ),
  );
});

prRoutes.post("/prs/:n/refresh", async (c) => {
  await requireAdmin(c);
  const n = prNumber(c);
  track(`pr:${n}`, () => refreshInfoComment(n, { force: true, refreshPacker: true }));
  return c.json({ ok: true }, 202);
});

prRoutes.get("/prs/:n/refresh/status", (c) => c.json({ running: isRefreshing(prNumber(c)) }));

prRoutes.get("/prs/:n/compare", async (c) => {
  const key = parseQuery(c, workspaceQuery);
  const n = prNumber(c);
  return c.json(await withPull(() => compareWorkspace(n, key, prdata.fileSource())));
});

prRoutes.get("/prs/:n/special-files", async (c) => {
  const data = parseQuery(c, specialFilesQuery);
  const n = prNumber(c);
  const keys = [
    ...(data.keys ?? "").split(","),
    ...(c.req.queries("keys") ?? []).flatMap((raw) => raw.split(",")),
    ...(c.req.queries("key") ?? []),
  ]
    .map((key) => key.trim())
    .filter(Boolean);
  return c.json(
    await withPull(() =>
      specialPageOf(n, {
        keys,
        withText: data.include === "text",
        ...(data.offset === undefined ? {} : { offset: data.offset }),
        ...(data.limit === undefined ? {} : { limit: data.limit }),
      }),
    ),
  );
});

prRoutes.get("/prs/:n/special", async (c) => c.json(await withPull(() => specialPairs(prNumber(c)))));

prRoutes.get("/prs/:n/special/content", async (c) => {
  const { key } = parseQuery(c, specialQuery);
  const content = await withPull(() => specialPairContent(prNumber(c), key, prdata.fileSource()));
  if (content === null) throw notFound("特殊文件不存在");
  return c.json(content);
});

prRoutes.get("/versions/:slug/keys", async (c) => {
  const { namespace, pr, versions } = parseQuery(c, versionsQuery);
  return c.json(
    await crossVersionKeys(
      c.req.param("slug"),
      { namespace, pr, versions: versionSelection(versions) },
      prdata.fileSource(),
    ),
  );
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
  modName: string | null;
  modDomain: string;
  curseForgeLink: string | null;
  versions: BakaXlVersion[];
}

const bakaXlCache = ttlCache<{ modlist: BakaXlMod[]; lastUpdate: string }>(60_000, 4);

prRoutes.get("/BakaXL/ModList", async (c) => {
  const payload = await bakaXlCache.wrap("modlist", async () => {
    const list = await mirror.modList();
    const modlist: BakaXlMod[] = [];
    for (const mod of list.mods) {
      if (mod.slug === "1UNKNOWN" || mod.slug.startsWith("0-")) continue;
      const rows: (BakaXlVersion & { domain: string })[] = [];
      for (const entry of mod.versions) {
        const dir = commentVersionDir(entry.version);
        if (dir === null) continue;
        for (const domain of entry.zhDomains ?? []) {
          rows.push({
            version: dir.mc,
            loader: dir.loader === "fabric" ? "Fabric" : "Forge",
            repoLink: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/projects/assets/${mod.slug}/${entry.version}/${domain}/lang/`,
            domain,
          });
        }
      }
      rows.sort(
        (a, b) =>
          compareMc(a.version, b.version) ||
          (a.loader === "Fabric" ? 1 : 0) - (b.loader === "Fabric" ? 1 : 0) ||
          a.domain.localeCompare(b.domain),
      );
      const first = rows[0];
      if (first === undefined) continue;
      const cfMatched = mod.cfSlug !== undefined && mod.cfSlug === mod.slug;
      modlist.push({
        modSlug: mod.slug,
        modName: cfMatched ? (mod.name ?? null) : null,
        modDomain: first.domain,
        curseForgeLink: cfMatched ? (mod.cfUrl ?? null) : null,
        versions: rows.map(({ version, loader, repoLink }) => ({ version, loader, repoLink })),
      });
    }
    return { modlist, lastUpdate: list.updatedAt ?? new Date().toISOString() };
  });
  return c.json(payload);
});

prRoutes.get("/BMCL/ModList", (c) => c.redirect("/api/BakaXL/ModList", 301));
