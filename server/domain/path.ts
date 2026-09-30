import type { Workspace } from "../../shared/api.ts";

export type Locale = "en_us" | "zh_cn";
export type LangFormat = "json" | "lang";

export interface LangPath {
  path: string;
  slug: string;
  version: string;
  namespace: string;
  fileName: string;
  locale: Locale | null;
  format: LangFormat;
  legacy: boolean;
}

export interface VersionDir {
  dir: string;
  mc: string;
  loader: "forge" | "fabric";
}

export type ModRef =
  | { provider: "curseforge"; slug: string }
  | { provider: "modrinth"; slug: string }
  | { provider: "none"; slug: string };

export function parseLangPath(path: string): LangPath | null {
  const parts = path.split("/");
  if (parts.length !== 7) return null;
  const p0 = parts[0] as string;
  const p1 = parts[1] as string;
  const p2 = parts[2] as string;
  const p3 = parts[3] as string;
  const p4 = parts[4] as string;
  const p5 = parts[5] as string;
  const p6 = parts[6] as string;
  if (p0 !== "projects" || p5 !== "lang") return null;

  let slug: string;
  let version: string;
  let legacy: boolean;
  if (p1 === "assets") {
    legacy = false;
    slug = p2;
    version = p3;
  } else if (p2 === "assets") {
    legacy = true;
    version = p1;
    slug = p3;
  } else {
    return null;
  }
  const namespace = p4;

  const dot = p6.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = p6.slice(dot + 1).toLowerCase();
  if (ext !== "json" && ext !== "lang") return null;
  const base = p6.slice(0, dot).toLowerCase();
  const locale: Locale | null = base === "en_us" ? "en_us" : base === "zh_cn" ? "zh_cn" : null;

  return {
    path,
    slug,
    version,
    namespace,
    fileName: p6,
    locale,
    format: ext === "lang" ? "lang" : "json",
    legacy,
  };
}

export function buildLangPath(
  slug: string,
  version: string,
  namespace: string,
  locale: Locale,
  format?: LangFormat,
): string {
  return `projects/assets/${slug}/${version}/${namespace}/lang/${locale}.${format ?? langFormatFor(version)}`;
}

const VERSION_DIR_RE = /^(\d+\.\d+(?:\.\d+)?)(-fabric)?$/;

export function parseVersionDir(dir: string): VersionDir | null {
  const m = VERSION_DIR_RE.exec(dir);
  if (!m) return null;
  return { dir, mc: m[1] as string, loader: m[2] ? "fabric" : "forge" };
}

export function langFormatFor(versionDir: string): LangFormat {
  const parsed = parseVersionDir(versionDir);
  return parsed !== null && parsed.mc === "1.12.2" ? "lang" : "json";
}

export function mcMatches(dirMc: string, gameVersion: string): boolean {
  const dir = dirMc.replace(/-fabric$/i, "").trim();
  const game = gameVersion.trim();
  if (dir === "" || game === "") return false;
  if (dir === game) return true;
  const segs = dir.split(".");
  if (segs.length >= 3) return false;
  return game.startsWith(`${dir}.`);
}

export function compareMc(a: string, b: string): number {
  const xs = a.replace(/-fabric$/i, "").trim().split(".");
  const ys = b.replace(/-fabric$/i, "").trim().split(".");
  const n = Math.max(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? "0";
    const y = ys[i] ?? "0";
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      return Number(x) < Number(y) ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}

export function workspacesOf(paths: string[]): Workspace[] {
  const byKey = new Map<string, Workspace>();
  for (const raw of paths) {
    const parsed = parseLangPath(raw);
    if (!parsed || parsed.locale === null) continue;
    const key = `${parsed.slug}\u0000${parsed.version}\u0000${parsed.namespace}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.files.push(raw);
    } else {
      byKey.set(key, {
        slug: parsed.slug,
        version: parsed.version,
        namespace: parsed.namespace,
        files: [raw],
      });
    }
  }
  return [...byKey.values()];
}

export function modRefOf(slug: string): ModRef {
  if (slug === "1UNKNOWN" || slug.startsWith("0-")) return { provider: "none", slug };
  if (slug.startsWith("modrinth-")) return { provider: "modrinth", slug: slug.slice("modrinth-".length) };
  return { provider: "curseforge", slug };
}

export function langPathFor(path: string, locale: Locale): string[] {
  const names = locale === "en_us" ? ["en_us", "en_US"] : ["zh_cn", "zh_CN"];
  return names.map((name) => path.replace(/[^/]*$/, (file) => file.replace(/^(?:zh_cn|zh_CN|en_us|en_US)(?=\.)/, name)));
}

const MC_ORDER = ["1.12", "1.16", "1.18", "1.19", ...Array.from({ length: 21 }, (_, i) => `1.${20 + i}`), "26.1"];

export interface CommentVersionDir {
  dir: string;
  mc: string;
  loader: "forge" | "fabric";
  index: number;
  label: string;
}

export function commentVersionDir(dir: string): CommentVersionDir | null {
  if (dir === "1.12.2") return { dir, mc: "1.12", loader: "forge", index: 0, label: "1.12" };
  const match = /^(\d+\.\d+)(-fabric)?$/.exec(dir);
  const mc = match?.[1];
  if (mc === undefined) return null;
  const index = MC_ORDER.indexOf(mc);
  if (index < 0 || mc === "1.12") return null;
  const loader = match?.[2] ? ("fabric" as const) : ("forge" as const);
  if (loader === "fabric" && mc === "1.19") return null;
  return { dir, mc, loader, index, label: dir };
}

export function invalidVersionError(versionString: string): Error {
  return new Error(
    `Specified argument was out of the range of valid values. (Parameter 'version')\nActual value was ${versionString}.`,
  );
}

export function standardVersionOf(dir: string): string {
  return dir === "1.12.2" ? "1.12.2" : dir.replace(/-fabric$/, "");
}

export interface CommentModPath {
  slug: string;
  versionString: string;
  domain: string;
}

export function commentModPathOf(path: string): CommentModPath | null {
  const parts = path.split("/");
  if (parts.length < 7 || parts[0] !== "projects") return null;
  const slug = parts[2] as string;
  const versionString = parts[3] as string;
  const domain = parts[4] as string;
  if (commentVersionDir(versionString) === null) throw invalidVersionError(versionString);
  return { slug, versionString, domain };
}

export function modInfosOf(paths: readonly string[]): CommentModPath[] {
  const seen = new Set<string>();
  const infos: CommentModPath[] = [];
  for (const path of paths) {
    const info = commentModPathOf(path);
    if (info === null || info.slug === "1UNKNOWN") continue;
    const key = `${info.domain}\u0000${info.slug}\u0000${info.versionString}`;
    if (seen.has(key)) continue;
    seen.add(key);
    infos.push(info);
  }
  return infos;
}

export interface DiffModPath {
  slug: string;
  dir: string;
  domain: string;
}

export function diffModPathOf(path: string): DiffModPath | null {
  const parts = path.split("/");
  if (parts.length < 7 || parts[0] !== "projects") return null;
  const standard = parts[1] === "assets";
  const dir = (standard ? parts[3] : parts[1]) as string;
  const slug = (standard ? parts[2] : parts[3]) as string;
  const domain = parts[4] as string;
  if (commentVersionDir(dir) === null) throw invalidVersionError(dir);
  return { slug, dir, domain };
}

export function diffModPathsOf(paths: readonly string[]): DiffModPath[] {
  const seen = new Set<string>();
  const out: DiffModPath[] = [];
  for (const path of paths) {
    const parsed = diffModPathOf(path);
    if (parsed === null) continue;
    const key = `${parsed.dir}\u0000${parsed.slug}\u0000${parsed.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}
