import { extname } from "node:path";
import { parseLang, guessFormat } from "./domain/langfile.ts";
import { alignKeys, compareLang, compareTwo, crossVersion, withLiteralNewlines } from "./domain/diff.ts";
import type { CrossVersionInput } from "./domain/diff.ts";
import { buildLangPath, parseLangPath, compareMc, langPathFor, workspacesOf } from "./domain/path.ts";
import type { LangFormat, LangPath, Locale } from "./domain/path.ts";
import { gh } from "./github/client.ts";
import type { GhFile, GhPull } from "./github/client.ts";
import { mods } from "./mods/index.ts";
import { mirror } from "./mirror.ts";
import { prdata } from "./prdata.ts";
import { ttlCache } from "./ttl.ts";
import type {
  CompareResult,
  CrossVersionKeysResult,
  CrossVersionResult,
  ModSourceResult,
  PrDetail,
  PrState,
  PrSummary,
  RowStatus,
  SpecialFile,
  TextCompareRequest,
  TextCompareResult,
} from "../shared/api.ts";

export interface WorkspaceKey {
  slug: string;
  version: string;
  namespace: string;
}

const SPECIAL_LIMIT = 100;
const SPECIAL_MAX_BYTES = 200 * 1024;
const BINARY_EXT: Record<string, true> = {
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".bmp": true,
  ".dds": true, ".tga": true, ".psd": true, ".ogg": true, ".wav": true, ".mp3": true, ".mp4": true,
  ".webm": true, ".zip": true, ".jar": true, ".7z": true, ".rar": true, ".gz": true, ".class": true,
  ".ttf": true, ".otf": true, ".woff": true, ".woff2": true, ".nbt": true, ".mca": true, ".mcr": true,
  ".bin": true, ".exe": true, ".dll": true, ".so": true, ".dylib": true, ".pdf": true, ".sqlite": true,
};
const MANUAL_SEGMENT = /(^|\/)_?(zh_cn|en_us)(\/|$)/i;

export function isSpecialPath(path: string): boolean {
  if (parseLangPath(path)) return false;
  if (BINARY_EXT[extname(path).toLowerCase()]) return false;
  if (path.endsWith(".json") || path.endsWith(".lang") || path.includes("/lang/")) return MANUAL_SEGMENT.test(path);
  return true;
}

export function prStateOf(pull: GhPull): PrState {
  if (pull.state === "open") return "open";
  return pull.merged ? "merged" : "closed";
}

function slugsOf(files: GhFile[]): string[] {
  const slugs = new Set<string>();
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (parsed) slugs.add(parsed.slug);
  }
  return [...slugs].sort();
}

function summaryOf(pull: GhPull, files: GhFile[]): PrSummary {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.author,
    state: prStateOf(pull),
    draft: pull.draft,
    labels: pull.labels,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    headSha: pull.headSha,
    slugs: slugsOf(files),
  };
}

export async function prDetail(n: number): Promise<PrDetail> {
  const { pull, files } = await prdata.files(n);
  return {
    ...summaryOf(pull, files),
    htmlUrl: pull.htmlUrl,
    baseRef: pull.baseRef,
    baseSha: pull.baseSha,
    headRef: pull.headRef,
    headRepo: pull.headRepoOwner && pull.headRepoName ? `${pull.headRepoOwner}/${pull.headRepoName}` : "",
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    })),
    workspaces: workspacesOf(files.map((file) => file.path)),
    specialFiles: files.filter((file) => isSpecialPath(file.path)).map((file) => file.path),
    related: prdata.related(n),
  };
}

interface LangSide {
  format: LangFormat;
  base: string | null;
  head: string | null;
}

function pickLang(files: GhFile[], key: WorkspaceKey, locale: Locale): LangSide | null {
  const preferred = `projects/assets/${key.slug}/${key.version}/${key.namespace}/lang/${locale}.`;
  let found: GhFile | null = null;
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (!parsed) continue;
    if (parsed.slug !== key.slug || parsed.version !== key.version || parsed.namespace !== key.namespace) continue;
    if (parsed.locale !== locale) continue;
    if (file.path.startsWith(preferred)) {
      found = file;
      break;
    }
    found ??= file;
  }
  if (!found) return null;
  const parsed = parseLangPath(found.path);
  return {
    format: parsed?.format ?? "json",
    base: found.status === "added" ? null : found.status === "renamed" ? found.previousPath ?? found.path : found.path,
    head: found.status === "removed" ? null : found.path,
  };
}

async function readLang(path: string, locale: Locale, ref: string): Promise<string | null> {
  for (const candidate of langPathFor(path, locale)) {
    const text = await gh.getFile(candidate, ref);
    if (text !== null) return text;
  }
  return null;
}

export async function compareWorkspace(n: number, key: WorkspaceKey): Promise<CompareResult> {
  const { pull, files } = await prdata.files(n);
  const missing: string[] = [];
  const reads = new Map<string, Promise<string | null>>();
  const readOne = (path: string, ref: string): Promise<string | null> => {
    const cacheKey = `${ref}\u0000${path}`;
    let pending = reads.get(cacheKey);
    if (!pending) {
      pending = gh.getFile(path, ref);
      reads.set(cacheKey, pending);
    }
    return pending;
  };
  const readAny = async (paths: string[], ref: string, label: string): Promise<string | null> => {
    for (const path of paths) {
      const text = await readOne(path, ref);
      if (text !== null) return text;
    }
    missing.push(label);
    return null;
  };

  const en = pickLang(files, key, "en_us");
  const zh = pickLang(files, key, "zh_cn");
  const format = en?.format ?? zh?.format ?? "json";

  const readSide = (side: LangSide | null, locale: Locale): { base: Promise<string | null>; head: Promise<string | null> } => {
    const pathsFor = (path: string | null): string[] => {
      const fallback = buildLangPath(key.slug, key.version, key.namespace, locale, format);
      return langPathFor(path ?? fallback, locale);
    };
    return {
      base: readAny(pathsFor(side?.base ?? null), pull.baseSha, `${locale} (base)`),
      head: readAny(pathsFor(side?.head ?? null), pull.headSha, `${locale} (head)`),
    };
  };

  const enText = readSide(en, "en_us");
  const zhText = readSide(zh, "zh_cn");
  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([enText.base, zhText.base, enText.head, zhText.head]);

  const base = {
    en: baseEnText === null ? null : parseLang(baseEnText, en?.format ?? format),
    zh: baseZhText === null ? null : parseLang(baseZhText, zh?.format ?? format),
  };
  const head = {
    en: headEnText === null ? null : parseLang(headEnText, en?.format ?? format),
    zh: headZhText === null ? null : parseLang(headZhText, zh?.format ?? format),
  };

  return {
    workspace: { slug: key.slug, version: key.version, namespace: key.namespace },
    baseSha: pull.baseSha,
    headSha: pull.headSha,
    format,
    rows: compareLang(base, head),
    missing,
  };
}

export async function modSource(n: number, key: WorkspaceKey): Promise<ModSourceResult> {
  const { pull, files } = await prdata.files(n);
  const mod = await mods.resolve(key.slug);
  if (!mod) {
    return { workspace: key, source: null, rows: [], note: `未找到 Mod ${key.slug} 的下载信息` };
  }
  const file = await mods.pickFile(mod, key.version);
  if (!file) {
    return {
      workspace: key,
      source: { provider: mod.provider, fileName: mod.slug, fileUrl: mod.url },
      rows: [],
      note: `未找到适用于 ${key.version} 的 Mod 文件`,
    };
  }
  const source = { provider: mod.provider, fileName: file.fileName, fileUrl: file.url ?? mod.url };
  const jar = await mods.readJar(file);
  if (!jar) {
    return { workspace: key, source, rows: [], note: "无法下载或解析该 Mod 文件" };
  }
  const jarLang = jar.lang.find((entry) => entry.locale === "en_us" && entry.domain === key.namespace) ?? jar.lang.find((entry) => entry.locale === "en_us");
  if (!jarLang) {
    return { workspace: key, source, rows: [], note: "该 Mod 文件不包含英文语言文件" };
  }

  const prSide = pickLang(files, key, "en_us");
  const prFormat = prSide?.format ?? jarLang.format;
  const prPath = prSide?.head ?? buildLangPath(key.slug, key.version, key.namespace, "en_us", prFormat);
  const prText = prSide?.head === null ? null : await readLang(prPath, "en_us", pull.headSha);
  const jarEntries = withLiteralNewlines(parseLang(jarLang.content, jarLang.format).entries);
  const prEntries = prText === null ? null : withLiteralNewlines(parseLang(prText, prFormat).entries);

  const keys = new Set<string>([...jarEntries.keys(), ...(prEntries?.keys() ?? [])]);
  const rows = [...keys].sort().map((k) => {
    const pr = prEntries?.get(k);
    const jar = jarEntries.get(k);
    let status: RowStatus;
    if (pr === undefined) status = "remove";
    else if (jar === undefined) status = "add";
    else status = pr === jar ? "same" : "modify";
    return { key: k, ...(pr === undefined ? {} : { pr }), ...(jar === undefined ? {} : { mod: jar }), status };
  });

  return {
    workspace: key,
    source,
    rows,
    ...(prEntries === null ? { note: "PR 中未找到该工作区的英文语言文件" } : {}),
  };
}

interface Capped {
  text: string | null;
  truncated: boolean;
}

function cap(text: string | null): Capped {
  if (text === null) return { text: null, truncated: false };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= SPECIAL_MAX_BYTES) return { text, truncated: false };
  return { text: bytes.subarray(0, SPECIAL_MAX_BYTES).toString("utf8"), truncated: true };
}

export async function specialFiles(n: number): Promise<SpecialFile[]> {
  const { pull, files } = await prdata.files(n);
  const targets = files.filter((file) => isSpecialPath(file.path)).slice(0, SPECIAL_LIMIT);
  const reads = new Map<string, Promise<string | null>>();
  const read = (path: string | null, ref: string): Promise<string | null> => {
    if (!path) return Promise.resolve(null);
    const cacheKey = `${ref}\u0000${path}`;
    let pending = reads.get(cacheKey);
    if (!pending) {
      pending = gh.getFile(path, ref);
      reads.set(cacheKey, pending);
    }
    return pending;
  };
  return Promise.all(
    targets.map(async (file) => {
      const basePath = file.status === "added" ? null : file.status === "renamed" ? file.previousPath ?? file.path : file.path;
      const headPath = file.status === "removed" ? null : file.path;
      const [baseText, headText] = await Promise.all([read(basePath, pull.baseSha), read(headPath, pull.headSha)]);
      const base = cap(baseText);
      const head = cap(headText);
      return { path: file.path, status: file.status, base: base.text, head: head.text, truncated: base.truncated || head.truncated };
    }),
  );
}

interface OverlayText {
  text: string;
  format: LangFormat;
}

function namespaceVersions(files: readonly LangPath[], slug: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const file of files) {
    if (file.slug !== slug) continue;
    if (file.locale !== "en_us" && file.locale !== "zh_cn") continue;
    const versions = result.get(file.namespace) ?? new Set<string>();
    versions.add(file.version);
    result.set(file.namespace, versions);
  }
  return result;
}

function widestNamespace(candidates: Iterable<string>, versionsOf: Map<string, Set<string>>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const namespace of candidates) {
    const count = versionsOf.get(namespace)?.size ?? 0;
    if (count > bestCount || (count === bestCount && best !== null && namespace < best)) {
      best = namespace;
      bestCount = count;
    }
  }
  return best;
}

function changedKeys(base: Map<string, string> | undefined, head: Map<string, string> | undefined): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of head ?? []) {
    if (base?.get(key) !== value) keys.add(key);
  }
  return keys;
}

const CROSS_TTL_MS = 30 * 60_000;
const CROSS_CACHE_MAX = 16;

interface CrossVersionBuild {
  slug: string;
  namespace: string;
  namespaces: string[];
  versions: string[];
  activeVersions: string[];
  prVersions: string[];
  entries: CrossVersionInput[];
  prNumber?: number;
}

const crossCache = ttlCache<CrossVersionBuild>(CROSS_TTL_MS, CROSS_CACHE_MAX);

async function buildCrossVersion(
  slug: string,
  opts: { namespace?: string; pr?: number; versions?: readonly string[] },
  head: string | null,
  prData: { pull: GhPull; files: GhFile[] } | null,
): Promise<CrossVersionBuild> {
  const prNumber = opts.pr;
  const all = await mirror.langFiles();
  const prLangs = (prData?.files ?? [])
    .filter((file) => file.status !== "removed")
    .map((file) => parseLangPath(file.path))
    .filter((parsed): parsed is LangPath => parsed !== null && parsed.slug === slug && (parsed.locale === "en_us" || parsed.locale === "zh_cn"));
  const versionsOf = namespaceVersions([...all, ...prLangs], slug);
  const namespaces = [...versionsOf.keys()].sort();
  const prNamespaces = new Set(prLangs.map((file) => file.namespace));
  const namespace =
    opts.namespace ?? widestNamespace(prNamespaces.size > 0 ? prNamespaces : namespaces, versionsOf) ?? slug;

  const byVersion = new Map<string, { en?: LangPath; zh?: LangPath }>();
  for (const file of all) {
    if (file.slug !== slug || file.namespace !== namespace) continue;
    if (file.locale !== "en_us" && file.locale !== "zh_cn") continue;
    const slot = byVersion.get(file.version) ?? {};
    if (file.locale === "en_us") slot.en ??= file;
    else slot.zh ??= file;
    byVersion.set(file.version, slot);
  }
  for (const parsed of prLangs) {
    if (parsed.namespace !== namespace || byVersion.has(parsed.version)) continue;
    byVersion.set(parsed.version, {});
  }

  const versions = [...byVersion.keys()].sort(compareMc);
  const wanted = opts.versions === undefined || opts.versions.length === 0 ? null : new Set(opts.versions);
  const kept = wanted === null ? versions : versions.filter((version) => wanted.has(version));
  const activeVersions = kept.length === 0 ? versions : kept;

  const basePaths: string[] = [];
  for (const version of activeVersions) {
    const slot = byVersion.get(version) ?? {};
    if (slot.en) basePaths.push(slot.en.path);
    if (slot.zh) basePaths.push(slot.zh.path);
  }
  const prPaths = prLangs
    .filter((parsed) => parsed.namespace === namespace && activeVersions.includes(parsed.version))
    .map((parsed) => parsed.path);
  const [baseTexts, prTexts] = await Promise.all([
    mirror.readMany(head ?? "HEAD", basePaths),
    prData === null ? null : gh.getFiles(prPaths, prData.pull.headSha),
  ]);

  const overlay = new Map<string, { en?: OverlayText; zh?: OverlayText }>();
  if (prTexts !== null) {
    for (const parsed of prLangs) {
      if (parsed.namespace !== namespace) continue;
      const text = prTexts.get(parsed.path);
      if (text === undefined) continue;
      const slot = overlay.get(parsed.version) ?? {};
      slot[parsed.locale === "en_us" ? "en" : "zh"] = { text, format: parsed.format };
      overlay.set(parsed.version, slot);
    }
  }

  const entries = activeVersions.map((version) => {
    const slot = byVersion.get(version) ?? {};
    const patch = overlay.get(version);
    const load = (file: LangPath | undefined): Map<string, string> | undefined => {
      if (!file) return undefined;
      const text = baseTexts.get(file.path);
      return text === undefined ? undefined : parseLang(text, file.format).entries;
    };
    const baseEn = load(slot.en);
    const baseZh = load(slot.zh);
    const en = patch?.en ? parseLang(patch.en.text, patch.en.format).entries : baseEn;
    const zh = patch?.zh ? parseLang(patch.zh.text, patch.zh.format).entries : baseZh;
    if (!patch) return { version, en, zh };
    const touched = changedKeys(baseEn, patch.en ? en : undefined);
    for (const key of changedKeys(baseZh, patch.zh ? zh : undefined)) touched.add(key);
    return { version, en, zh, touched };
  });

  return {
    slug,
    namespace,
    namespaces,
    versions,
    activeVersions,
    prVersions: [...overlay.keys()].sort(compareMc),
    entries,
    ...(prNumber === undefined ? {} : { prNumber }),
  };
}

async function crossVersionBuild(
  slug: string,
  opts: { namespace?: string; pr?: number; versions?: readonly string[] },
): Promise<CrossVersionBuild> {
  const [head, prData] = await Promise.all([mirror.headSha(), opts.pr === undefined ? null : prdata.files(opts.pr)]);
  const selection =
    opts.versions === undefined || opts.versions.length === 0 ? null : [...new Set(opts.versions)].sort(compareMc);
  const key = JSON.stringify([
    head,
    opts.pr ?? null,
    prData?.pull.headSha ?? null,
    slug,
    opts.namespace ?? null,
    selection,
  ]);
  return crossCache.wrap(key, () => buildCrossVersion(slug, opts, head, prData));
}

export async function crossVersionResult(
  slug: string,
  opts: { namespace?: string; pr?: number; versions?: readonly string[] },
): Promise<CrossVersionResult> {
  const build = await crossVersionBuild(slug, opts);
  const { keyCount, issues } = crossVersion(build.entries);
  return {
    slug: build.slug,
    namespace: build.namespace,
    namespaces: build.namespaces,
    versions: build.versions,
    activeVersions: build.activeVersions,
    prVersions: build.prVersions,
    keyCount,
    issues,
    ...(build.prNumber === undefined ? {} : { prNumber: build.prNumber }),
  };
}

export async function crossVersionKeys(
  slug: string,
  opts: { namespace?: string; pr?: number; versions?: readonly string[] },
  page: { q?: string; offset: number; limit: number },
): Promise<CrossVersionKeysResult> {
  const build = await crossVersionBuild(slug, opts);
  const needle = page.q?.trim().toLowerCase() ?? "";
  const rows = alignKeys(build.entries).filter(
    (row) =>
      needle === "" ||
      row.key.toLowerCase().includes(needle) ||
      row.cells.some((cell) => cell.en.toLowerCase().includes(needle) || cell.zh?.toLowerCase().includes(needle) === true),
  );
  return { total: rows.length, offset: page.offset, rows: rows.slice(page.offset, page.offset + page.limit) };
}

export function textCompare(req: TextCompareRequest): TextCompareResult {
  const left = parseLang(req.left.content, guessFormat(req.left.content));
  const right = parseLang(req.right.content, guessFormat(req.right.content));
  return {
    rows: compareTwo(left.entries, right.entries),
    errors: [...left.errors.map((e) => `${req.left.name}: ${e}`), ...right.errors.map((e) => `${req.right.name}: ${e}`)],
  };
}
