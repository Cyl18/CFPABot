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
