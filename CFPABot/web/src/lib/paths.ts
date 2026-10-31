import type { Workspace } from "@cfpa/contracts/api";
import { langFormatFor, parseLangPath, type Locale, type LangPath } from "@cfpa/review-core/domain/path";

export function workspaceParam(slug: string, version: string, namespace: string): string {
  return `${slug}/${version}/${namespace}`;
}

export type { Locale };

/** 每个 locale 只有一份文件进比较视图，规则与服务端 pickLocale 相同。 */
export function pickCompareFiles(files: readonly { path: string }[], workspace: Workspace): Partial<Record<Locale, string>> {
  const expected = (locale: Locale) => `${locale}.${langFormatFor(workspace.version)}`;
  const picked: Partial<Record<Locale, string>> = {};
  for (const locale of ["en_us", "zh_cn"] as const) {
    const candidates = files
      .map((file) => parseLangPath(file.path))
      .filter(
        (entry): entry is LangPath =>
          entry !== null &&
          entry.locale === locale &&
          entry.slug === workspace.slug &&
          entry.version === workspace.version &&
          entry.namespace === workspace.namespace,
      );
    const rank = (entry: LangPath): number => {
      const want = expected(locale);
      if (entry.fileName === want) return 0;
      if (entry.fileName.toLowerCase() === want) return 1;
      return entry.format === langFormatFor(workspace.version) ? 2 : 3;
    };
    const best = [...candidates].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))[0];
    if (best !== undefined) picked[locale] = best.path;
  }
  return picked;
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
