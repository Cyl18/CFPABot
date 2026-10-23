export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL = 10 * 60 * 1000;
const STORAGE_KEY = "cfpa.models-dev.index.v1";
const TIMEOUT_MS = 15_000;

export interface ModelsDevLimitInfo {
  context?: number;
  input?: number;
  output?: number;
}

export interface ModelsDevReasoningOption {
  type?: string;
  values?: readonly string[];
}

export interface ModelsDevModel {
  id: string;
  limit?: ModelsDevLimitInfo;
  reasoning?: boolean;
  reasoning_options?: readonly ModelsDevReasoningOption[];
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevIndex = Record<string, ModelsDevProvider>;

export interface FlatModelEntry {
  providerKey: string;
  model: ModelsDevModel;
}

export interface ModelsDevPersist {
  entries: FlatModelEntry[];
  fetchedAt: number;
}

export interface ModelLimits {
  contextWindow?: number;
  maxOutput?: number;
}

export interface ThinkingOption {
  value: string;
  label: string;
}

const THINKING_LABELS: Record<string, string> = {
  off: "关闭思考",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

const FULL_THINKING_OPTIONS: readonly ThinkingOption[] = [
  { value: "", label: "默认" },
  ...Object.entries(THINKING_LABELS).map(([value, label]) => ({ value, label })),
];

export function flattenModelsDevIndex(index: ModelsDevIndex): FlatModelEntry[] {
  const entries: FlatModelEntry[] = [];
  for (const [providerKey, provider] of Object.entries(index)) {
    if (!provider || typeof provider !== "object" || !provider.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== "object") continue;
      const id = model.id || modelId;
      if (!id) continue;
      if (!model.limit && model.reasoning !== true && !model.reasoning_options) continue;
      entries.push({
        providerKey,
        model: {
          id,
          ...(model.limit ? { limit: model.limit } : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          ...(model.reasoning_options ? { reasoning_options: model.reasoning_options } : {}),
        },
      });
    }
  }
  return entries;
}

function loadFromStorage(): ModelsDevPersist | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelsDevPersist;
    return parsed && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function saveToStorage(entries: FlatModelEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, fetchedAt: Date.now() } satisfies ModelsDevPersist));
  } catch {
    // localStorage quota is best-effort; memory cache still works.
  }
}

export function loadModelsDevCache(): FlatModelEntry[] | null {
  return loadFromStorage()?.entries ?? null;
}

let cache: FlatModelEntry[] | null = null;
let expiresAt = 0;
let inFlight: Promise<FlatModelEntry[] | null> | null = null;

export async function fetchModelsDevModels(): Promise<FlatModelEntry[] | null> {
  const now = Date.now();
  if (cache && now < expiresAt) return cache;
  const persisted = loadFromStorage();
  if (persisted && now < persisted.fetchedAt + CACHE_TTL) {
    cache = persisted.entries;
    expiresAt = persisted.fetchedAt + CACHE_TTL;
    return cache;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
      const entries = flattenModelsDevIndex((await response.json()) as ModelsDevIndex);
      cache = entries;
      expiresAt = Date.now() + CACHE_TTL;
      saveToStorage(entries);
      return entries;
    } catch (error) {
      if (cache) return cache;
      if (persisted) return persisted.entries;
      throw error;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function pickModelEntry(index: readonly FlatModelEntry[] | null, modelId: string, provider?: string): FlatModelEntry | undefined {
  if (!index || modelId === "") return undefined;
  const matches = index.filter((entry) => entry.model.id === modelId);
  if (matches.length === 0) return undefined;
  return (provider ? matches.find((entry) => entry.providerKey === provider) : undefined) ?? matches[0];
}

export function pickModelLimits(
  index: readonly FlatModelEntry[] | null,
  modelId: string,
  provider?: string,
): ModelLimits | undefined {
  const limit = pickModelEntry(index, modelId, provider)?.model.limit;
  if (!limit) return undefined;
  const contextWindow = limit.context ?? limit.input;
  const maxOutput = limit.output;
  if (contextWindow === undefined && maxOutput === undefined) return undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
  };
}

export function thinkingOptionsFor(
  index: readonly FlatModelEntry[] | null,
  modelId: string,
  provider?: string,
): readonly ThinkingOption[] {
  const entry = pickModelEntry(index, modelId, provider);
  if (!entry) return FULL_THINKING_OPTIONS;
  if (entry.model.reasoning === false) return [{ value: "", label: "默认（该模型不支持思考）" }];
  const values = new Set<string>();
  for (const option of entry.model.reasoning_options ?? []) {
    if (option.type !== "effort") continue;
    for (const raw of option.values ?? []) {
      const value = raw === "none" ? "off" : raw === "default" ? "" : raw;
      if (value !== "" && THINKING_LABELS[value] !== undefined) values.add(value);
    }
  }
  if (values.size === 0) return FULL_THINKING_OPTIONS;
  return [{ value: "", label: "默认" }, ...[...values].map((value) => ({ value, label: THINKING_LABELS[value] ?? value }))];
}

export function withCurrentThinking(options: readonly ThinkingOption[], value: string | undefined): readonly ThinkingOption[] {
  if (!value || options.some((option) => option.value === value)) return options;
  return [...options, { value, label: `${value}（当前）` }];
}
