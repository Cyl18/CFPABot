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

export interface LineRange {
  start: number;
  end: number | null;
}

/** 解析已由 omp 剥出的 `160-172` / `160` 选择器。 */
export function lineRangeOf(selector: string): LineRange | null {
  const at = /^(\d+)(?:-(\d+))?$/.exec(selector);
  if (at === null) return null;
  const start = Number(at[1]);
  const end = at[2] === undefined ? null : Number(at[2]);
  return { start: Math.max(1, start), end };
}

/** 选择器写在了查询前面（omp 剥不掉）时，只有 `:N`/`:N-M` 能在这里补；其它形态给明确出路。 */
const SELECTOR_SUFFIX = /^(?:raw|img|conflicts|\d[\d,+-]*|-\d+)$/;

/** `x.json:85-125` / `x.json:85` 剥出范围；omp 只在选择器紧贴 URL 结尾时才剥，写在查询前的在这里补。 */
export function splitLineSuffix(path: string): { path: string; range: LineRange | null } {
  const colon = path.lastIndexOf(":");
  if (colon <= 0) return { path, range: null };
  const suffix = path.slice(colon + 1);
  const range = lineRangeOf(suffix);
  if (range !== null) return { path: path.slice(0, colon), range };
  if (SELECTOR_SUFFIX.test(suffix)) {
    throw new Error(
      `":${suffix}" 写在查询前时只认 :N 或 :N-M；其它选择器要放到整条 URI 末尾，例如 pr://…/files/x.json?side=head:${suffix}。`,
    );
  }
  return { path, range: null };
}

/** 1-based，越界的端夹到文件内；start 超过总行数是调用方写错了范围，直接报。 */
export function sliceLines(text: string, range: LineRange): string {
  const lines = text.split("\n");
  if (range.start > lines.length) {
    throw new Error(`行范围超出文件：文件只有 ${lines.length} 行，请求从第 ${range.start} 行开始。`);
  }
  const end = Math.min(range.end ?? lines.length, lines.length);
  return lines.slice(range.start - 1, Math.max(end, range.start)).join("\n");
}
