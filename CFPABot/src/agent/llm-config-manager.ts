// src/agent/llm-config-manager.ts
// Unified LLM config cache manager — single owner for both endpoint parsing
// (llm-endpoints.ts) and the pi-ai model registry (llm-registry.ts).
// Replaces the two independent module-level caches that previously had to be
// invalidated separately.
//
// Public API:
//   LlmConfigManager.getInstance()  → singleton
//   .getEndpoints()                 → parsed LlmEndpoint[] (cached)
//   .getDefaults()                  → LlmDefaults | null (cached)
//   .getModels()                    → MutableModels (synced from endpoints)
//   .invalidate()                   → clears both caches
//   .refresh()                      → invalidate + lazy reload on next access

import type { MutableModels } from "@earendil-works/pi-ai";
import { readEndpointsFromDisk } from "./llm-endpoints.js";
import { buildModelsCollection, syncKey } from "./llm-registry.js";
import type { LlmEndpoint, LlmDefaults } from "./llm-types.js";

export class LlmConfigManager {
  private static instance: LlmConfigManager | null = null;

  private _endpoints: LlmEndpoint[] | null = null;
  private _defaults: LlmDefaults | null | undefined = undefined;
  private _models: MutableModels | null = null;
  private _lastSyncKey = "";

  private constructor() {}

  static getInstance(): LlmConfigManager {
    if (!LlmConfigManager.instance) {
      LlmConfigManager.instance = new LlmConfigManager();
    }
    return LlmConfigManager.instance;
  }

  /** Test seam — drop the singleton so a fresh instance is built next call. */
  static __resetInstance(): void {
    LlmConfigManager.instance = null;
  }

  /** Parse endpoints from disk/config. Cached after first call. */
  getEndpoints(): LlmEndpoint[] {
    if (this._endpoints === null) {
      const { endpoints, defaults } = readEndpointsFromDisk();
      this._endpoints = endpoints;
      // On ENOENT the helper returns null defaults; preserve the "unparsed"
      // sentinel so a subsequent getDefaults() still re-reads from disk.
      this._defaults = defaults;
    }
    return this._endpoints;
  }

  /** Parse defaults from disk/config. Cached alongside endpoints. */
  getDefaults(): LlmDefaults | null {
    // Ensure endpoints are parsed first (also populates _defaults).
    this.getEndpoints();
    return this._defaults ?? null;
  }

  /**
   * Synchronise the pi-ai Models collection.
   * Uses cached endpoints when called without arguments.
   * Rebuilds only when endpoints differ from the last sync.
   */
  syncModels(endpoints?: LlmEndpoint[]): MutableModels {
    const eps = endpoints ?? this.getEndpoints();
    if (this._models) {
      const key = syncKey(eps);
      if (key === this._lastSyncKey) return this._models;
    }
    const { models, key } = buildModelsCollection(eps, this._models ?? undefined);
    this._models = models;
    this._lastSyncKey = key;
    return models;
  }

  /** Return the pi-ai Models collection, lazily syncing on first call. */
  getModels(): MutableModels {
    if (!this._models) this.syncModels();
    return this._models!;
  }

  /** Clear both endpoint and model caches so the next access reloads from disk. */
  invalidate(): void {
    this._endpoints = null;
    this._defaults = undefined;
    this._models = null;
    this._lastSyncKey = "";
  }

  /** Invalidate then eagerly reload both caches from disk. */
  refresh(): void {
    this.invalidate();
    this.getEndpoints();
    this.getModels();
  }

  /** Test seam — set endpoints cache without touching defaults. */
  __setEndpointsForTest(eps: LlmEndpoint[] | null): void {
    this._endpoints = eps;
  }

  /** Test seam — set defaults cache without touching endpoints. */
  __setDefaultsForTest(defaults: LlmDefaults | null | undefined): void {
    this._defaults = defaults;
  }

  /** Test seam — replace the Models collection for injection testing. */
  __setModelsForTest(models: MutableModels | null): void {
    this._models = models;
    this._lastSyncKey = models ? "__test__" : "";
  }
}
