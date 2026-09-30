export type SearchPatch = Readonly<Record<string, string | undefined>>;

export type PrListSearch = { state?: string; q?: string; labels?: string };

export type ModsSearch = { q?: string };

export type VersionsSearch = { namespace?: string; view?: string; versions?: string; kind?: string; q?: string; kq?: string };

export type PrSearch = {
  ws?: string;
  slug?: string;
  ns?: string;
  status?: string;
  mode?: string;
  overlay?: string;
  file?: string;
  layout?: string;
  view?: string;
  versions?: string;
  kind?: string;
  prOnly?: string;
  q?: string;
  kq?: string;
};

// 默认编解码器会把 "1.16" 这类值转义成 %221.16%22，这里统一按字符串原样往返。
export function parseSearch(searchStr: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(searchStr));
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
