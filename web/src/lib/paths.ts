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
