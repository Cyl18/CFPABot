// Lightweight client-side mirror of backend parse-project-path.ts.
// Supports the two lang-file layouts we care about:
//   projects/assets/{slug}/{version}/{modDomain}/lang/{file}
//   projects/{version}/{slug}/{modDomain}/lang/{file}   (old format)
const PROJECT_PATH_RE =
  /^projects\/(?:(assets)\/)?([^/]+)\/([^/]+)\/([^/]+)\/lang\/(.+)$/;

const LANG_FILE_RE = /\/lang\/(zh_cn|en_us)\.(json|lang)$/i;

export interface ParsedWorkspacePath {
  slug: string;
  version: string;
  namespace: string;
  file: string;
  isOldFormat: boolean;
}

/** True when the path ends in a zh_cn / en_us lang file. */
export function isLangFilePath(path: string): boolean {
  return LANG_FILE_RE.test(path);
}

/**
 * Parse a language file path into workspace components.
 * Returns null when the path is not a recognized lang file layout.
 */
export function parseProjectPath(raw: string): ParsedWorkspacePath | null {
  if (!isLangFilePath(raw)) return null;

  const m = raw.match(PROJECT_PATH_RE);
  if (!m) return null;

  const hasAssets = m[1] === "assets";

  // With "assets": projects/assets/{slug}/{version}/{domain}/lang/{file}
  // Without:      projects/{version}/{slug}/{domain}/lang/{file}
  return hasAssets
    ? {
        slug: m[2]!,
        version: m[3]!,
        namespace: m[4]!,
        file: m[5]!,
        isOldFormat: false,
      }
    : {
        slug: m[3]!,
        version: m[2]!,
        namespace: m[4]!,
        file: m[5]!,
        isOldFormat: true,
      };
}

/** Build the Compare route a workspace link should point to (query param form). */
export function buildWorkspaceLink(prId: number, parsed: ParsedWorkspacePath): string {
  const params = new URLSearchParams({ slug: parsed.slug, version: parsed.version, namespace: parsed.namespace })
  return `/compare/${prId}?${params.toString()}`;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  added: { label: '新增', className: 'badge-green' },
  modified: { label: '修改', className: 'badge-amber' },
  removed: { label: '删除', className: 'badge-red' },
  renamed: { label: '重命名', className: 'badge-gray' },
  changed: { label: '修改', className: 'badge-amber' },
};

const DEFAULT_STATUS = { label: '其他', className: 'badge-gray' };

/** Map a GitHub file status string to {label, badge class}. */
export function statusBadge(status: string) {
  return STATUS_CONFIG[status] ?? DEFAULT_STATUS;
}

const INITIAL_VISIBLE = 30;

export { INITIAL_VISIBLE };
