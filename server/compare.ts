import { extname } from "node:path";
import { parseLang, guessFormat } from "./domain/langfile.ts";
import { compareLang, compareTwo, crossVersion } from "./domain/diff.ts";
import { buildLangPath, parseLangPath, compareMc, langPathFor, workspacesOf } from "./domain/path.ts";
import type { LangFormat, LangPath, Locale } from "./domain/path.ts";
import { gh } from "./github/client.ts";
import type { GhFile, GhPull } from "./github/client.ts";
import { mods } from "./mods/index.ts";
import { mirror } from "./mirror.ts";
import { prdata } from "./prdata.ts";
import type {
  CompareResult,
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
    body: pull.body,
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
  const jarEntries = parseLang(jarLang.content, jarLang.format).entries;
  const prEntries = prText === null ? null : parseLang(prText, prFormat).entries;

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

export async function crossVersionResult(slug: string, opts: { namespace?: string; pr?: number }): Promise<CrossVersionResult> {
  const namespace = opts.namespace ?? slug;
  const all = await mirror.langFiles();
  const byVersion = new Map<string, { en?: LangPath; zh?: LangPath }>();
  for (const file of all) {
    if (file.slug !== slug || file.namespace !== namespace) continue;
    if (file.locale !== "en_us" && file.locale !== "zh_cn") continue;
    const slot = byVersion.get(file.version) ?? {};
    if (file.locale === "en_us") slot.en ??= file;
    else slot.zh ??= file;
    byVersion.set(file.version, slot);
  }

  const overlay = new Map<string, { en?: OverlayText; zh?: OverlayText }>();
  let prNumber: number | undefined;
  if (opts.pr !== undefined) {
    const { pull, files } = await prdata.files(opts.pr);
    prNumber = opts.pr;
    const headTexts = await Promise.all(
      files.map(async (file) => {
        const parsed = parseLangPath(file.path);
        if (!parsed || parsed.slug !== slug || parsed.namespace !== namespace) return null;
        const locale = parsed.locale;
        if (locale !== "en_us" && locale !== "zh_cn") return null;
        if (file.status === "removed") return null;
        const text = await gh.getFile(file.path, pull.headSha);
        if (text === null) return null;
        return { version: parsed.version, locale, format: parsed.format, text };
      }),
    );
    for (const hit of headTexts) {
      if (!hit) continue;
      const slot = overlay.get(hit.version) ?? {};
      slot[hit.locale === "en_us" ? "en" : "zh"] = { text: hit.text, format: hit.format };
      overlay.set(hit.version, slot);
      if (!byVersion.has(hit.version)) byVersion.set(hit.version, {});
    }
  }

  const versions = [...byVersion.keys()].sort(compareMc);
  const inputs = await Promise.all(
    versions.map(async (version) => {
      const slot = byVersion.get(version) ?? {};
      const patch = overlay.get(version);
      const enText = patch?.en?.text ?? (slot.en ? await mirror.read(slot.en.path) : null);
      const zhText = patch?.zh?.text ?? (slot.zh ? await mirror.read(slot.zh.path) : null);
      const en = enText === null ? undefined : parseLang(enText, patch?.en?.format ?? slot.en?.format ?? "json").entries;
      const zh = zhText === null ? undefined : parseLang(zhText, patch?.zh?.format ?? slot.zh?.format ?? "json").entries;
      return { version, ...(en === undefined ? {} : { en }), ...(zh === undefined ? {} : { zh }) };
    }),
  );

  return { slug, namespace, versions, rows: crossVersion(inputs), ...(prNumber === undefined ? {} : { prNumber }) };
}

export function textCompare(req: TextCompareRequest): TextCompareResult {
  const left = parseLang(req.left.content, guessFormat(req.left.content));
  const right = parseLang(req.right.content, guessFormat(req.right.content));
  return {
    rows: compareTwo(left.entries, right.entries),
    errors: [...left.errors.map((e) => `${req.left.name}: ${e}`), ...right.errors.map((e) => `${req.right.name}: ${e}`)],
  };
}
