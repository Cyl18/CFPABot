const USER_AGENT = "CFPAAgent2 (github.com/CFPAOrg)";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

export async function requestJson(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...options.headers },
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

export async function downloadBytes(url: string, maxBytes: number, timeoutMs = 120_000): Promise<Uint8Array | null> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  return bytes;
}
