import type { Workspace } from "@cfpa/contracts/api";

export interface ParsedLangFile {
  slug: string;
  version: string;
  namespace: string;
  legacy: boolean;
}

export function parseLangFile(path: string): ParsedLangFile | null {
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

  const dot = p6.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = p6.slice(dot + 1).toLowerCase();
  if (ext !== "json" && ext !== "lang") return null;

  return { slug, version, namespace: p4, legacy };
}

export function workspaceParam(slug: string, version: string, namespace: string): string {
  return `${slug}/${version}/${namespace}`;
}

export type Locale = "en_us" | "zh_cn";

/** 与 server/views/workspace.ts 的 pickLang 同规则：每个 locale 只有一份文件进比较视图，canonical 文件名优先。 */
export function pickCompareFiles(files: readonly { path: string }[], workspace: Workspace): Partial<Record<Locale, string>> {
  const picked: Partial<Record<Locale, string>> = {};
  const fallback: Partial<Record<Locale, string>> = {};
  for (const file of files) {
    const parsed = parseLangFile(file.path);
    if (!parsed || parsed.slug !== workspace.slug || parsed.version !== workspace.version || parsed.namespace !== workspace.namespace) continue;
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const base = name.slice(0, name.indexOf(".")).toLowerCase();
    const locale: Locale = base === "en_us" ? "en_us" : "zh_cn";
    if (base === "en_us" || base === "zh_cn") {
      picked[locale] ??= file.path;
    } else {
      fallback[locale] ??= file.path;
    }
  }
  return { ...fallback, ...picked };
}

export interface NamespaceGroup {
  namespace: string;
  workspaces: Workspace[];
}

export interface ModGroup {
  slug: string;
  namespaces: NamespaceGroup[];
}

export function groupWorkspaces(workspaces: readonly Workspace[]): ModGroup[] {
  const mods: ModGroup[] = [];
  for (const workspace of workspaces) {
    let mod = mods.find((item) => item.slug === workspace.slug);
    if (mod === undefined) {
      mod = { slug: workspace.slug, namespaces: [] };
      mods.push(mod);
    }
    let group = mod.namespaces.find((item) => item.namespace === workspace.namespace);
    if (group === undefined) {
      group = { namespace: workspace.namespace, workspaces: [] };
      mod.namespaces.push(group);
    }
    group.workspaces.push(workspace);
  }
  return mods;
}
