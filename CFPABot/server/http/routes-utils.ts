import { Hono } from "hono";
import { z } from "zod";
import { commentVersionDir, compareMc, invalidVersionError, parseLangPath } from "@cfpa/review-core/domain/path";
import { env, repo } from "../env.ts";
import { gh } from "../github/client.ts";
import type { GhFile } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import * as cf from "../mods/curseforge.ts";
import { mappingMissingMessage, mods } from "../mods/index.ts";
import { checkReportPath } from "../paths.ts";
import { prdata } from "../prdata.ts";
import type { RelatedPr } from "@cfpa/contracts/api";
import type { AppContext, AppEnv } from "./auth.ts";
import { HttpError } from "../errors.ts";
import { parseQuery } from "./errors.ts";

export const utilsRoutes = new Hono<AppEnv>();

const TEXT = { "Content-Type": "text/plain; charset=utf-8" } as const;
const USER_AGENT = "CFPAAgent2 (github.com/CFPAOrg)";

interface LangLink {
  namespace: string;
  en: string | null;
  zh: string | null;
}

function prId(c: AppContext, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "PR 编号无效", "invalid_pr");
  return n;
}

function requireWebhookSecret(c: AppContext, code = "webhook_disabled"): void {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "未配置 GITHUB_WEBHOOK_SECRET", code);
  if (c.req.header("authorization") !== secret) throw new HttpError(401, "未授权", "unauthorized");
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
  if (commentVersionDir(versionString) === null) throw invalidVersionError(versionString);
  if (slug.startsWith("modrinth-")) {
    return c.text(await mods.modrinthLangDomain(slug.slice("modrinth-".length), versionString), 200, TEXT);
  }
  const addon = await mods.resolveByMapping(slug);
  if (addon === null) throw new Error(`找不到 ${slug} 的 CurseForge 映射`);
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
  requireWebhookSecret(c);
  const id = c.req.param("id");
  try {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`输入字符串的格式不正确：${id}`);
    const addon = await cf.getMod(numeric);
    if (addon === null) throw new Error(`找不到 CurseForge 模组 ${id}`);
    await mods.mappings.set(addon.slug, numeric);
    mods.invalidate(addon.slug);
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
  requireWebhookSecret(c, "token_disabled");
  const token = await gh.gitToken();
  if (token === null) throw new Error("GitHub 客户端未配置凭据");
  return c.text(token, 200, TEXT);
});

utilsRoutes.get("/CFPATools/PRRelation/:prid", async (c) => {
  const n = prId(c, "prid");
  const { pull, files } = await prdata.files(n);
  if (pull.state !== "open") return c.body(null, 418);

  const ownVersions = new Map<string, Set<string>>();
  const ownSlugs: string[] = [];
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (parsed === null || parsed.locale === null) continue;
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

  // 同一版本可能有多个 namespace：按 namespace 分组，不然只会拿到字典序靠前的那份。
  const linksOf = async (num: number, slug: string, version: string): Promise<LangLink[]> => {
    const { headSha, files: prFiles } = await filesOf(num);
    const base = `https://github.com/${repo.fullName}/raw/${headSha}/`;
    const grouped = new Map<string, { en?: string; zh?: string }>();
    for (const file of prFiles) {
      const parsed = parseLangPath(file.path);
      if (parsed === null || parsed.locale === null || parsed.slug !== slug || parsed.version !== version) continue;
      const slot = grouped.get(parsed.namespace) ?? {};
      if (parsed.locale === "en_us") slot.en ??= file.path;
      else slot.zh ??= file.path;
      grouped.set(parsed.namespace, slot);
    }
    return [...grouped].map(([namespace, slot]) => ({
      namespace,
      en: slot.en === undefined ? null : `${base}${encodeURIComponent(slot.en)}`,
      zh: slot.zh === undefined ? null : `${base}${encodeURIComponent(slot.zh)}`,
    }));
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
    const related = (
      await Promise.all(
        others.map(async (item) =>
          (
            await Promise.all(
              item.versions.map(async (version) =>
                (await linksOf(item.number, slug, version)).map((link) => ({ number: item.number, version, ...link })),
              ),
            )
          ).flat(),
        ),
      )
    ).flat();

    for (const version of versions) {
      for (const link of await linksOf(n, slug, version)) {
        const other = related
          .filter((entry) => entry.namespace === link.namespace)
          .map((entry) => ({ number: entry.number, enlink: entry.en, zhlink: entry.zh, version: entry.version }));
        modList.push({ type: "curseforge", id: slug, modid: link.namespace, enlink: link.en, zhlink: link.zh, version, other });
      }
    }
  }

  if (modList.length === 0) return c.body(null, 418);
  return c.json({ number: n, mod_list: modList });
});
