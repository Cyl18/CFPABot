import type { Workspace } from "@cfpa/contracts/api";
import { parseLangPath, type Locale } from "@cfpa/review-core/domain/path";

export function workspaceParam(slug: string, version: string, namespace: string): string {
  return `${slug}/${version}/${namespace}`;
}

export type { Locale };

/** 每个 locale 只有一份文件进比较视图，canonical 文件名优先；规则来自 review-core，与服务端同源。 */
export function pickCompareFiles(files: readonly { path: string }[], workspace: Workspace): Partial<Record<Locale, string>> {
  const picked: Partial<Record<Locale, string>> = {};
  const fallback: Partial<Record<Locale, string>> = {};
  for (const file of files) {
    const parsed = parseLangPath(file.path);
    if (parsed === null || parsed.locale === null) continue;
    if (parsed.slug !== workspace.slug || parsed.version !== workspace.version || parsed.namespace !== workspace.namespace) continue;
    const base = parsed.fileName.slice(0, parsed.fileName.lastIndexOf(".")).toLowerCase();
    if (base === parsed.locale) {
      picked[parsed.locale] ??= file.path;
    } else {
      fallback[parsed.locale] ??= file.path;
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
