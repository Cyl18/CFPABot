import { Hono } from "hono";
import { z } from "zod";
import { commentVersionDir, compareMc, invalidVersionError, parseLangPath } from "../domain/path.ts";
import { env, repo } from "../env.ts";
import { gh } from "../github/client.ts";
import type { GhFile } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import * as cf from "../mods/curseforge.ts";
import { mappingMissingMessage, mods } from "../mods/index.ts";
import { checkReportPath } from "../paths.ts";
import { prdata } from "../prdata.ts";
import type { RelatedPr } from "../../shared/api.ts";
import type { AppContext, AppEnv } from "./auth.ts";
import { HttpError, parseQuery } from "./errors.ts";

export const utilsRoutes = new Hono<AppEnv>();

const TEXT = { "Content-Type": "text/plain; charset=utf-8" } as const;
const USER_AGENT = "CFPAAgent2 (github.com/CFPAOrg)";

function prId(c: AppContext, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "PR 编号无效", "invalid_pr");
  return n;
}

utilsRoutes.get("/Utils/PathValidation", async (c) => {
  const pr = Number(c.req.query("pr") ?? "");
  if (!Number.isInteger(pr) || pr <= 0) throw new HttpError(400, "PR 编号无效", "invalid_pr");
  const { files } = await prdata.files(pr);
  const lines = files
    .filter((file) => file.status !== "removed" && file.path.includes("lang") && [...file.path].some((ch) => !/[0-9a-z_\-./]/.test(ch)))
    .map((file) => `${file.path}\n`);
  return c.text(lines.join(""), 200, TEXT);
});

utilsRoutes.get("/Utils/Report/:pr/:sha", async (c) => {
  const pr = Number(c.req.param("pr"));
  const sha = c.req.param("sha");
  if (!Number.isInteger(pr) || pr <= 0 || !/^[0-9a-f]{7}$/i.test(sha)) {
    throw new HttpError(400, "参数无效", "invalid_param");
  }
  const text = await Bun.file(checkReportPath(pr, sha))
    .text()
    .catch(() => null);
  if (text === null) return c.text("", 404);
  return c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

const modIdQuery = z.object({ slug: z.string().min(1), versionString: z.string().min(1) });

utilsRoutes.get("/Utils/ModID", async (c) => {
  const { slug, versionString } = parseQuery(c, modIdQuery);
  const addon = await mods.resolveByMapping(slug);
  if (addon === null) throw new Error(`找不到 ${slug} 的 CurseForge 映射`);
  if (commentVersionDir(versionString) === null) throw invalidVersionError(versionString);
  return c.text(await mods.cfLangDomain(addon.raw, versionString), 200, TEXT);
});

utilsRoutes.get("/Utils/ModName/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    if (slug.startsWith("modrinth-")) {
      const real = slug.slice("modrinth-".length);
      const project = await mods.modrinthProject(real);
      if (project === null) {
        return c.text(
          `Modrinth.Exceptions.ModrinthApiException\nAn error occurred while communicating with Modrinth API (HTTP 404 NotFound)\nRequest: GET https://api.modrinth.com/v2/project/${real}`,
          418,
          TEXT,
        );
      }
      return c.text(project.name, 200, TEXT);
    }
    const addon = await mods.resolveByMapping(slug);
    if (addon === null) return c.text(`CFPABot.Exceptions.CheckException\n${mappingMissingMessage(slug)}`, 418, TEXT);
    return c.text(addon.name, 200, TEXT);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return c.text(`${name}\n${err instanceof Error ? err.message : String(err)}`, 418, TEXT);
  }
});

utilsRoutes.get("/Utils/AddMapping/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`输入字符串的格式不正确：${id}`);
    const addon = await cf.getMod(numeric);
    if (addon === null) throw new Error(`找不到 CurseForge 模组 ${id}`);
    await mods.mappings.set(addon.slug, numeric);
    return c.text(`成功添加 Mapping：${addon.slug} => ${id}`, 200, TEXT);
  } catch (err) {
    return c.text(`失败：${err instanceof Error ? err.message : String(err)}`, 200, TEXT);
  }
});

utilsRoutes.get("/Utils/GetAllModFilesInRepo", async (c) => {
  const [list, mappingList] = await Promise.all([mirror.modList(), mods.mappings.list()]);
  const ids = new Map(mappingList.map((entry) => [entry.slug, entry.curseforgeId]));
  return c.json(
    list.mods.flatMap((mod) => {
      const cfid = ids.get(mod.slug);
      if (cfid === undefined) return [];
      const versions = [...new Set(mod.versions.map((entry) => commentVersionDir(entry.version)?.label ?? entry.version))].sort(
        (a, b) => compareMc(a, b) || (a.endsWith("-fabric") ? 1 : 0) - (b.endsWith("-fabric") ? 1 : 0),
      );
      return [{ slug: mod.slug, cfid, versions }];
    }),
  );
});

utilsRoutes.get("/Utils/Diff/:prid", async (c) => {
  const n = prId(c, "prid");
  const url = `https://github.com/${repo.fullName}/pull/${n}.diff`;
  const token = await gh.gitToken().catch(() => null);
  const attempt = (withToken: boolean): Promise<Response> =>
    fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        ...(withToken && token !== null ? { authorization: `bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
  let res: Response;
  try {
    res = await attempt(true);
  } catch {
    res = await attempt(false);
  }
  if (!res.ok) res = await attempt(false);
  if (!res.ok) throw new Error(`获取 PR diff 失败：HTTP ${res.status}`);
  return c.text(await res.text(), 200, TEXT);
});

utilsRoutes.get("/Utils/GitHubToken", async (c) => {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "未配置 GITHUB_WEBHOOK_SECRET", "token_disabled");
  if (c.req.header("authorization") !== secret) throw new HttpError(401, "未授权", "unauthorized");
  const token = await gh.gitToken();
  if (token === null) throw new Error("GitHub 客户端未配置凭据");
  return c.text(token, 200, TEXT);
});

utilsRoutes.get("/CFPATools/PRRelation/:prid", async (c) => {
  const n = prId(c, "prid");
  const { pull, files } = await prdata.files(n);
  if (pull.state !== "open") return c.body(null, 418);

  const domains = new Map<string, string>();
  const ownVersions = new Map<string, Set<string>>();
  const ownSlugs: string[] = [];
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (parsed === null || parsed.locale === null) continue;
    const key = `${parsed.slug}\u0000${parsed.version}`;
    if (!domains.has(key)) domains.set(key, parsed.namespace);
    const versions = ownVersions.get(parsed.slug) ?? new Set<string>();
    versions.add(parsed.version);
    ownVersions.set(parsed.slug, versions);
    if (!ownSlugs.includes(parsed.slug)) ownSlugs.push(parsed.slug);
  }

  const relatedBySlug = new Map<string, RelatedPr[]>();
  for (const item of prdata.related(n)) {
    const list = relatedBySlug.get(item.slug) ?? [];
    list.push(item);
    relatedBySlug.set(item.slug, list);
  }

  const fileCache = new Map<number, { headSha: string; files: GhFile[] }>([[n, { headSha: pull.headSha, files }]]);
  const filesOf = async (num: number) => {
    const cached = fileCache.get(num);
    if (cached !== undefined) return cached;
    const data = await prdata.files(num);
    const entry = { headSha: data.pull.headSha, files: data.files };
    fileCache.set(num, entry);
    return entry;
  };
  const linksOf = async (num: number, slug: string, version: string): Promise<{ en: string | null; zh: string | null }> => {
    const { headSha, files: prFiles } = await filesOf(num);
    const matching = prFiles.filter((file) => file.path.includes(`/${version}/`) && file.path.includes(`/${slug}/`));
    const zh = matching.find((file) => file.path.includes("zh_cn"));
    const en = matching.find((file) => file.path.includes("en_us"));
    if (zh === undefined || en === undefined) return { en: null, zh: null };
    const base = `https://github.com/${repo.fullName}/raw/${headSha}/`;
    return { en: `${base}${encodeURIComponent(en.path)}`, zh: `${base}${encodeURIComponent(zh.path)}` };
  };

  const modList: {
    type: "curseforge";
    id: string;
    modid: string;
    enlink: string | null;
    zhlink: string | null;
    version: string;
    other: { number: number; enlink: string | null; zhlink: string | null; version: string }[];
  }[] = [];
  for (const slug of ownSlugs) {
    const versions = ownVersions.get(slug) ?? new Set<string>();
    const others = relatedBySlug.get(slug) ?? [];
    const other = await Promise.all(
      others.flatMap((item) =>
        item.versions.map(async (version) => {
          const links = await linksOf(item.number, slug, version);
          return { number: item.number, enlink: links.en, zhlink: links.zh, version };
        }),
      ),
    );
    const tuples = [
      ...[...versions].map((version) => ({ number: n, version })),
      ...others.flatMap((item) => item.versions.map((version) => ({ number: item.number, version }))),
    ];
    for (const tuple of tuples) {
      if (!versions.has(tuple.version)) continue;
      const domain = domains.get(`${slug}\u0000${tuple.version}`);
      if (domain === undefined) continue;
      const links = await linksOf(n, slug, tuple.version);
      modList.push({ type: "curseforge", id: slug, modid: domain, enlink: links.en, zhlink: links.zh, version: tuple.version, other });
    }
  }

  if (modList.length === 0) return c.body(null, 418);
  return c.json({ number: n, mod_list: modList });
});
