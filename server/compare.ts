import { extname } from "node:path";
import { parseLang, guessFormat } from "./domain/langfile.ts";
import type { ParsedLang } from "./domain/langfile.ts";
import { alignKeys, compareLang, compareTwo, inHunks } from "./domain/diff.ts";
import type { CrossVersionInput } from "./domain/diff.ts";
import { parseFlatten, specialFormat } from "./domain/flatten.ts";
import type { FlattenParsed } from "./domain/flatten.ts";
import { buildLangPath, parseLangPath, compareMc, langPathFor, workspacesOf } from "./domain/path.ts";
import type { LangFormat, LangPath, Locale } from "./domain/path.ts";
import { planSpecial, resolveDerived, resolveSpecial } from "./domain/special.ts";
import type { PlannedSide, SpecialPlan } from "./domain/special.ts";
import { gh } from "./github/client.ts";
import type { GhFile, GhPull } from "./github/client.ts";
import { mirror } from "./mirror.ts";
import { prdata } from "./prdata.ts";
import { commentableHunks } from "./review.ts";
import { ttlCache } from "./ttl.ts";
import type {
  CompareResult,
  CompareReview,
  CrossVersionKeysResult,
  PrDetail,
  PrState,
  PrSummary,
  SpecialKeyRow,
  SpecialPair,
  SpecialPairContent,
  SpecialParsed,
  SpecialText,
  TextCompareRequest,
  TextCompareResult,
} from "../shared/api.ts";

export interface WorkspaceKey {
  slug: string;
  version: string;
  namespace: string;
}

const SPECIAL_MAX_BYTES = 200 * 1024;
const BINARY_EXT: Record<string, true> = {
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".bmp": true,
  ".dds": true, ".tga": true, ".psd": true, ".ogg": true, ".wav": true, ".mp3": true, ".mp4": true,
  ".webm": true, ".zip": true, ".jar": true, ".7z": true, ".rar": true, ".gz": true, ".class": true,
  ".ttf": true, ".otf": true, ".woff": true, ".woff2": true, ".nbt": true, ".mca": true, ".mcr": true,
  ".bin": true, ".exe": true, ".dll": true, ".so": true, ".dylib": true, ".pdf": true, ".sqlite": true,
};
const ASSET_PATH = /^projects\/(?:assets\/|\d[^/]*\/assets\/)/;
const README_FILE = /^readme(\.[a-z0-9]+)?$/i;
const MANUAL_SEGMENT = /(^|\/)_?(zh_cn|en_us)(\/|$)/i;

// 只认模组资源目录：新布局 projects/assets/<模组>/<版本>/、旧布局 projects/<版本>/assets/<模组>/；仓库工具链和 README 占位说明不是译文内容。
export function isSpecialPath(path: string): boolean {
  if (!ASSET_PATH.test(path)) return false;
  if (parseLangPath(path)) return false;
  if (BINARY_EXT[extname(path).toLowerCase()]) return false;
  if (README_FILE.test(path.slice(path.lastIndexOf("/") + 1))) return false;
  // .flatten.json5 是模组语言源文件，语言词元在文件名里而不是路径段里。
  if (path.endsWith(".json5")) return true;
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
    if (file.status === "removed") continue;
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
    workspaces: workspacesOf(files),
    specialFiles: files.filter((file) => isSpecialPath(file.path)).map((file) => file.path),
    related: prdata.related(n),
  };
}

interface LangSide {
  format: LangFormat;
  base: string | null;
  head: string | null;
}

interface LangRead {
  path: string;
  text: string;
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
  const readAny = async (paths: string[], ref: string, label: string): Promise<LangRead | null> => {
    for (const path of paths) {
      const text = await readOne(path, ref);
      if (text !== null) return { path, text };
    }
    missing.push(label);
    return null;
  };

  const en = pickLang(files, key, "en_us");
  const zh = pickLang(files, key, "zh_cn");
  const format = en?.format ?? zh?.format ?? "json";

  const readSide = (side: LangSide | null, locale: Locale): { base: Promise<LangRead | null>; head: Promise<LangRead | null> } => {
    const read = (path: string | null, ref: string, label: string): Promise<LangRead | null> =>
      path === null ? Promise.resolve(null) : readAny(langPathFor(path, locale), ref, label);
    if (side !== null) {
      return {
        base: read(side.base, pull.baseSha, `${locale} (base)`),
        head: read(side.head, pull.headSha, `${locale} (head)`),
      };
    }
    const guessed = langPathFor(buildLangPath(key.slug, key.version, key.namespace, locale, format), locale);
    return {
      base: readAny(guessed, pull.baseSha, `${locale} (base)`),
      head: readAny(guessed, pull.headSha, `${locale} (head)`),
    };
  };

  const enText = readSide(en, "en_us");
  const zhText = readSide(zh, "zh_cn");
  const [baseEnText, baseZhText, headEnText, headZhText] = await Promise.all([enText.base, zhText.base, enText.head, zhText.head]);

  const base = {
    en: baseEnText === null ? null : parseLang(baseEnText.text, en?.format ?? format),
    zh: baseZhText === null ? null : parseLang(baseZhText.text, zh?.format ?? format),
  };
  const head = {
    en: headEnText === null ? null : parseLang(headEnText.text, en?.format ?? format),
    zh: headZhText === null ? null : parseLang(headZhText.text, zh?.format ?? format),
  };

  return {
    workspace: { slug: key.slug, version: key.version, namespace: key.namespace },
    baseSha: pull.baseSha,
    headSha: pull.headSha,
    format,
    rows: compareLang(base, head),
    missing,
    review: compareReview(headZhText, head.zh, files),
  };
}

function compareReview(read: LangRead | null, parsed: ParsedLang | null, files: GhFile[]): CompareReview | null {
  if (read === null || parsed === null) return null;
  const file = files.find((entry) => entry.path === read.path);
  if (file === undefined || file.status === "removed") return null;
  const hunks = commentableHunks(file, read.text);
  if (hunks.length === 0) return null;
  const lines = read.text.split("\n");
  const keys: CompareReview["keys"] = {};
  for (const [key, line] of parsed.lines) {
    if (!inHunks(line, hunks)) continue;
    keys[key] = { line, raw: (lines[line - 1] ?? "").replace(/\r$/, "") };
  }
  return { path: read.path, keys };
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

async function specialPlanFor(n: number): Promise<{ pull: GhPull; files: GhFile[]; plans: SpecialPlan[]; existing: ReadonlySet<string> }> {
  const { pull, files } = await prdata.files(n);
  const plans = planSpecial(files.filter((file) => isSpecialPath(file.path)));
  const derived: string[] = [];
  for (const plan of plans) {
    if (plan.kind === "single") continue;
    for (const side of [plan.en, plan.zh]) {
      if (side.file !== null) continue;
      derived.push(side.path);
      if (side.alternate !== undefined) derived.push(side.alternate);
    }
  }
  const rev = (await mirror.headSha()) ?? "HEAD";
  const existing = derived.length === 0 ? new Set<string>() : await mirror.existing(rev, derived);
  return { pull, files, plans: resolveDerived(plans, existing), existing };
}

export async function specialPairs(n: number): Promise<SpecialPair[]> {
  const { plans, existing } = await specialPlanFor(n);
  return resolveSpecial(plans, existing);
}

const emptyParsed = (): FlattenParsed => ({ entries: new Map(), lines: new Map() });

function specialParsedOf(format: string, en: SpecialText, zh: SpecialText): SpecialParsed | null {
  const read = (text: string | null): FlattenParsed | null => (text === null ? emptyParsed() : parseFlatten(text));
  const baseEn = read(en.base);
  const headEn = read(en.head);
  const baseZh = read(zh.base);
  const headZh = read(zh.head);
  if (baseEn === null || headEn === null || baseZh === null || headZh === null) return null;
  const rows: SpecialKeyRow[] = [];
  for (const row of compareLang({ en: baseEn, zh: baseZh }, { en: headEn, zh: headZh })) {
    const enLine = headEn.lines.get(row.key);
    const zhLine = headZh.lines.get(row.key);
    rows.push({
      ...row,
      ...(enLine === undefined ? {} : { enLine }),
      ...(zhLine === undefined ? {} : { zhLine }),
    });
  }
  return { format, rows };
}

export async function specialPairContent(n: number, key: string): Promise<SpecialPairContent | null> {
  const { pull, files, plans, existing } = await specialPlanFor(n);
  const entry = plans.find((plan) => plan.key === key);
  if (entry === undefined) return null;
  const reads = new Map<string, Promise<string | null>>();
  const read = (path: string | null, ref: string): Promise<string | null> => {
    if (path === null) return Promise.resolve(null);
    const cacheKey = `${ref}\u0000${path}`;
    let pending = reads.get(cacheKey);
    if (!pending) {
      pending = gh.getFile(path, ref);
      reads.set(cacheKey, pending);
    }
    return pending;
  };
  const textOf = async (side: PlannedSide): Promise<SpecialText> => {
    const file = side.file;
    let baseText: string | null;
    let headText: string | null;
    if (file === null) {
      const text = existing.has(side.path) ? await read(side.path, pull.headSha) : null;
      baseText = text;
      headText = text;
    } else {
      const basePath = file.status === "added" ? null : file.status === "renamed" ? file.previousPath ?? file.path : file.path;
      const headPath = file.status === "removed" ? null : file.path;
      [baseText, headText] = await Promise.all([read(basePath, pull.baseSha), read(headPath, pull.headSha)]);
    }
    const base = cap(baseText);
    const head = cap(headText);
    const prFile = files.find((entry) => entry.path === side.path);
    return {
      path: side.path,
      status: file === null ? (existing.has(side.path) ? "unchanged" : "missing") : file.status,
      ...(file?.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      base: base.text,
      head: head.text,
      truncated: base.truncated || head.truncated,
      hunks: prFile === undefined || prFile.status === "removed" ? null : commentableHunks(prFile, headText),
    };
  };
  if (entry.kind === "single") return { key: entry.key, kind: "single", file: await textOf(entry.file) };
  const [en, zh] = await Promise.all([textOf(entry.en), textOf(entry.zh)]);
  const format = specialFormat(entry.en.path);
  const parsed =
    format !== null && format === specialFormat(entry.zh.path) && !en.truncated && !zh.truncated
      ? specialParsedOf(format, en, zh)
      : null;
  return { key: entry.key, kind: "pair", en, zh, parsed };
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
  zhVersions: string[];
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
    prVersions: [...new Set(prLangs.filter((parsed) => parsed.namespace === namespace).map((parsed) => parsed.version))].sort(compareMc),
    zhVersions: versions.filter((version) => byVersion.get(version)?.zh !== undefined),
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

export async function crossVersionKeys(
  slug: string,
  opts: { namespace?: string; pr?: number; versions?: readonly string[] },
): Promise<CrossVersionKeysResult> {
  const build = await crossVersionBuild(slug, opts);
  return {
    slug: build.slug,
    namespace: build.namespace,
    namespaces: build.namespaces,
    versions: build.versions,
    activeVersions: build.activeVersions,
    prVersions: build.prVersions,
    zhVersions: build.zhVersions,
    rows: alignKeys(build.entries),
  };
}

export function textCompare(req: TextCompareRequest): TextCompareResult {
  const left = parseLang(req.left.content, guessFormat(req.left.content));
  const right = parseLang(req.right.content, guessFormat(req.right.content));
  return {
    rows: compareTwo(left.entries, right.entries),
    errors: [...left.errors.map((e) => `${req.left.name}: ${e}`), ...right.errors.map((e) => `${req.right.name}: ${e}`)],
  };
}
