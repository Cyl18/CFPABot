export interface RepoUri {
  scheme: "repo";
  path: string;
  query: URLSearchParams;
  selector?: { from: number; to?: number };
}

export interface LocalUri {
  scheme: "local";
  path: string;
  query: URLSearchParams;
  selector?: { from: number; to?: number };
}

export interface HelpUri {
  scheme: "help";
  path: string;
  query: URLSearchParams;
  selector?: undefined;
}

export type ResourceUri = RepoUri | LocalUri | HelpUri;

interface UriParts {
  path: string;
  query: URLSearchParams;
  selector?: { from: number; to?: number };
}

const SELECTOR = /:(\d+)(?:-(\d*))?$/;

function parseParts(trimmed: string, scheme: "repo" | "local" | "help"): UriParts {
  const rest = trimmed.slice(scheme.length + 3);
  const queryAt = rest.indexOf("?");
  let pathname = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1));

  let selector: UriParts["selector"];
  const match = SELECTOR.exec(pathname);
  if (match !== null) {
    const from = Number(match[1]);
    const to = match[2] === undefined || match[2] === "" ? undefined : Number(match[2]);
    if (from > 0 && (to === undefined || to >= from)) {
      selector = to === undefined ? { from } : { from, to };
      pathname = pathname.slice(0, match.index);
    }
  }

  const path = decodeURIComponent(pathname.replace(/^\/+/, ""));
  return { path, query, ...(selector === undefined ? {} : { selector }) };
}

export function parseUri(raw: string): ResourceUri {
  const trimmed = raw.trim();
  if (trimmed.startsWith("repo://")) return { scheme: "repo", ...parseParts(trimmed, "repo") };
  if (trimmed.startsWith("local://")) return { scheme: "local", ...parseParts(trimmed, "local") };
  if (trimmed.startsWith("help://")) {
    const { path, query } = parseParts(trimmed, "help");
    return { scheme: "help", path, query };
  }
  throw new Error("不支持的 scheme。当前支持 repo://、local:// 与 help://。");
}

export function uriSegments(uri: ResourceUri): string[] {
  return uri.path.split("/").filter(Boolean);
}
