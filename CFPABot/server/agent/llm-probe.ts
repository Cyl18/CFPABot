import type { ProbeModelsRequest } from "../../shared/api.ts";
import { normalizeBaseUrl } from "./llm-providers.ts";

const PROBE_TIMEOUT_MS = 15_000;

export function parseModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const ids = new Set<string>();
  const collect = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = "id" in entry && typeof entry.id === "string" ? entry.id : undefined;
      const name = "name" in entry && typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : undefined;
      const value = id ?? name;
      if (value) ids.add(value);
    }
  };
  if ("data" in body) collect(body.data);
  if ("models" in body) collect(body.models);
  return [...ids].sort();
}

export async function probeModels(
  request: ProbeModelsRequest,
  storedKey: (endpointId: string) => string | undefined,
): Promise<string[]> {
  const apiKey = request.apiKey?.trim() || (request.endpointId ? storedKey(request.endpointId) : undefined) || "";
  const base = normalizeBaseUrl(request.baseUrl, request.protocol);
  const url = request.protocol === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (request.protocol === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (request.protocol === "google-generative-ai") {
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
  return parseModels(await response.json());
}
