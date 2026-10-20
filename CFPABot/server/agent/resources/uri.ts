export interface UriSelector {
  from: number;
  to?: number;
}

interface UriBase {
  path: string;
  query: URLSearchParams;
  selector?: UriSelector;
}

export interface RepoUri extends UriBase {
  scheme: "repo";
}

export interface PrUri extends UriBase {
  scheme: "pr";
  number: number;
}

export interface GhUri extends UriBase {
  scheme: "gh";
}

export interface LocalUri extends UriBase {
  scheme: "local";
}

export interface SkillUri extends UriBase {
  scheme: "skill";
}

export interface HelpUri {
  scheme: "help";
  path: string;
  query: URLSearchParams;
}

export type ResourceUri = RepoUri | PrUri | GhUri | LocalUri | SkillUri | HelpUri;

interface UriParts {
  path: string;
  query: URLSearchParams;
  selector?: UriSelector;
}

const SELECTOR = /:(\d+)(?:-(\d*))?$/;

function parseParts(trimmed: string, scheme: string): UriParts {
  const rest = trimmed.slice(scheme.length + 3);
  const queryAt = rest.indexOf("?");
  const pathname = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1));

  let selector: UriSelector | undefined;
  const match = SELECTOR.exec(pathname);
  if (match !== null) {
    const from = Number(match[1]);
    const to = match[2] === undefined || match[2] === "" ? undefined : Number(match[2]);
    if (from > 0 && (to === undefined || to >= from)) {
      selector = to === undefined ? { from } : { from, to };
    }
  }

  // 先剥 selector 再解码，`%3A` 才是「文件名里的冒号」的逃生门。
  const raw = selector === undefined ? pathname : pathname.slice(0, match?.index ?? pathname.length);
  const path = decodeURIComponent(raw.replace(/^\/+/, ""));
  return { path, query, ...(selector === undefined ? {} : { selector }) };
}

export function parseUri(raw: string): ResourceUri {
  const trimmed = raw.trim();
  if (trimmed.startsWith("repo://")) return { scheme: "repo", ...parseParts(trimmed, "repo") };
  if (trimmed.startsWith("gh://")) return { scheme: "gh", ...parseParts(trimmed, "gh") };
  if (trimmed.startsWith("local://")) return { scheme: "local", ...parseParts(trimmed, "local") };
  if (trimmed.startsWith("skill://")) return { scheme: "skill", ...parseParts(trimmed, "skill") };
  if (trimmed.startsWith("pr://")) {
    const parts = parseParts(trimmed, "pr");
    const slash = parts.path.indexOf("/");
    const head = slash === -1 ? parts.path : parts.path.slice(0, slash);
    const number = Number(head);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("pr:// 需要 PR 编号：pr://<n>/...");
    }
    return { scheme: "pr", number, ...parts, path: slash === -1 ? "" : parts.path.slice(slash + 1) };
  }
  if (trimmed.startsWith("help://")) {
    const { path, query } = parseParts(trimmed, "help");
    return { scheme: "help", path, query };
  }
  throw new Error("不支持的 scheme。当前支持 repo://、pr://、gh://、local://、skill:// 与 help://。");
}

export function uriSegments(uri: ResourceUri): string[] {
  return uri.path.split("/").filter(Boolean);
}
