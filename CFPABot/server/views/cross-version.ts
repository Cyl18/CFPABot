import { parseLang } from "@cfpa/review-core/domain/langfile";
import { alignKeys } from "@cfpa/review-core/domain/diff";
import type { CrossVersionInput } from "@cfpa/review-core/domain/diff";
import { parseLangPath, compareMc } from "@cfpa/review-core/domain/path";
import type { LangFormat, LangPath } from "@cfpa/review-core/domain/path";
import { gh } from "../github/client.ts";
import type { GhFile, GhPull } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import { prdata } from "../prdata.ts";
import { ttlCache } from "../ttl.ts";
import type { CrossVersionKeysResult } from "@cfpa/contracts/api";

export interface CrossVersionOpts {
  namespace?: string;
  pr?: number;
  versions?: readonly string[];
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
  opts: CrossVersionOpts,
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

async function crossVersionBuild(slug: string, opts: CrossVersionOpts): Promise<CrossVersionBuild> {
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

export async function crossVersionKeys(slug: string, opts: CrossVersionOpts): Promise<CrossVersionKeysResult> {
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
