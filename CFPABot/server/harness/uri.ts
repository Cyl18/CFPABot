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

/** 相对某个资源的下一页地址；保留当前查询的过滤条件，只改 offset。 */
export function nextPageUri(base: string, query: URLSearchParams, offset: number | null): string | null {
  if (offset === null) return null;
  const params = new URLSearchParams(query);
  params.set("offset", String(offset));
  return `${base}?${params.toString()}`;
}

/** 重复参数与逗号列表都接受；模型写 `key=a&key=b` 或 `keys=a,b` 都不用猜。 */
export function listParam(query: URLSearchParams, ...names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    for (const raw of query.getAll(name)) {
      for (const item of raw.split(",")) {
        const value = item.trim();
        if (value !== "") values.push(value);
      }
    }
  }
  return [...new Set(values)];
}

export function flagParam(query: URLSearchParams, name: string): boolean {
  const value = query.get(name);
  return value !== null && value !== "0" && value !== "false";
}
