import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { compareMc, parseLangPath, type LangPath } from "./domain/path.ts";
import { repo } from "./env.ts";
import { runGit } from "./git.ts";
import { logger } from "./log.ts";
import { getModsByIds } from "./mods/curseforge.ts";
import { mappings } from "./mods/mappings.ts";
import { paths } from "./paths.ts";
import { readJson, writeJson, withLock } from "./store.ts";
import type { ModEntry, ModList } from "../shared/api.ts";

const log = logger("mirror");
const MIRROR_URL = `https://github.com/${repo.owner}/${repo.name}.git`;
const MODLIST_PATH = join(paths.cache, "modlist.json");
const ID_BATCH = 50;

function git(args: string[], cwd = paths.mirror): Promise<string> {
  return runGit(cwd, args, null);
}

async function headSha(): Promise<string | null> {
  if (!(await stat(join(paths.mirror, ".git")).catch(() => null))) return null;
  try {
    return (await git(["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

async function ensureMirror(): Promise<void> {
  if (await stat(join(paths.mirror, ".git")).catch(() => null)) return;
  await rm(paths.mirror, { recursive: true, force: true });
  await git(
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      repo.defaultBranch,
      MIRROR_URL,
      paths.mirror,
    ],
    paths.root,
  );
}

async function curseforgeNames(ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    try {
      for (const mod of await getModsByIds(batch)) names.set(mod.id, mod.name);
    } catch (err) {
      log.warn("获取 CurseForge 模组名称失败", { err });
      break;
    }
  }
  return names;
}

export const mirror = {
  async sync(): Promise<{ headSha: string; changed: boolean }> {
    return withLock("mirror", async () => {
      const before = await headSha();
      await ensureMirror();
      if (before !== null) {
        await git(["fetch", "--depth", "1", "origin", repo.defaultBranch]);
        await git(["update-ref", `refs/heads/${repo.defaultBranch}`, "FETCH_HEAD"]);
      }
      const after = await headSha();
      return { headSha: after ?? "", changed: after !== before };
    });
  },

  headSha,

  async langFiles(): Promise<LangPath[]> {
    const out = await git(["ls-tree", "-r", "--name-only", "HEAD"]);
    const files: LangPath[] = [];
    for (const line of out.split("\n")) {
      const path = line.trim();
      if (!path) continue;
      const parsed = parseLangPath(path);
      if (parsed) files.push(parsed);
    }
    return files;
  },

  async read(path: string): Promise<string | null> {
    try {
      return await git(["show", `HEAD:${path}`]);
    } catch {
      return null;
    }
  },

  async modList(): Promise<ModList> {
    const head = await headSha();
    const cached = await readJson<ModList>(MODLIST_PATH);
    if (cached && head !== null && cached.headSha === head) return cached;

    const grouped = new Map<string, Map<string, Set<string>>>();
    for (const file of await mirror.langFiles()) {
      const versions = grouped.get(file.slug) ?? new Map<string, Set<string>>();
      const namespaces = versions.get(file.version) ?? new Set<string>();
      namespaces.add(file.namespace);
      versions.set(file.version, namespaces);
      grouped.set(file.slug, versions);
    }

    const mappingList = await mappings.list();
    const idsBySlug = new Map(mappingList.map((entry) => [entry.slug, entry.curseforgeId]));
    const names = await curseforgeNames([...new Set(idsBySlug.values())]);

    const mods: ModEntry[] = [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([slug, versions]) => {
        const curseforgeId = idsBySlug.get(slug);
        const name = curseforgeId === undefined ? undefined : names.get(curseforgeId);
        return {
          slug,
          ...(name ? { name } : {}),
          ...(curseforgeId === undefined ? {} : { curseforgeId }),
          versions: [...versions.entries()]
            .sort((a, b) => compareMc(a[0], b[0]))
            .map(([version, namespaces]) => ({ version, namespaces: [...namespaces].sort() })),
        };
      });

    const result: ModList = { updatedAt: new Date().toISOString(), headSha: head, mods };
    await writeJson(MODLIST_PATH, result);
    return result;
  },
};
