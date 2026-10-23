import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";

export interface ResourceParts {
  path: string;
  query: URLSearchParams;
}

export interface PrParts extends ResourceParts {
  number: number;
}

/** `scheme://a/b` 里的 `a/b`：authority 是路径第一段，不是主机名。 */
export function resourcePath(url: InternalUrl): string {
  const raw = `${url.rawHost}${url.pathname}`;
  try {
    return decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    return raw.replace(/^\/+/, "");
  }
}

export function partsOf(url: InternalUrl): ResourceParts {
  return { path: resourcePath(url), query: url.searchParams };
}

export function prPartsOf(url: InternalUrl): PrParts {
  const number = Number(url.rawHost);
  if (!Number.isInteger(number) || number <= 0) throw new Error("pr:// 需要 PR 编号：pr://<n>/...");
  return { number, path: resourcePath(url).split("/").slice(1).join("/"), query: url.searchParams };
}
