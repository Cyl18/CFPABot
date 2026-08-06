// src/api/frontend/helpers.ts
// Shared types, config, and utility functions for frontend route modules.

import { loadEntryConfigSync } from "@/config.js";
import type { FlowContext } from "@/types.js";

// ---- Types ----

export type AppVariables = {
  user: {
    login: string;
    id: number;
    avatar: string;
  } | null;
  /** Decrypted OAuth token for GitHub API calls (set by authMiddleware) */
  oauthToken?: string;
  isAdmin: boolean;
  isContributor: boolean;
  /** Agent session FlowContext (set by sessions routes) */
  flowContext?: FlowContext;
};


export interface ModlistEntry {
  slug: string;
  name: string;
  cfId: number;
  versions: string[];
  description: string;
}

// ---- Config ----

export const config = loadEntryConfigSync();
/** Maximum request body size for API endpoints (10 MB). */
export const MAX_BODY_SIZE = 10 * 1024 * 1024;

// ---- Cache helpers ----

/** Evict the oldest entry from a Map when it exceeds maxSize (FIFO eviction by insertion order). */
export function evictCache<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size >= maxSize) {
    const key = cache.keys().next().value;
    if (key !== undefined) cache.delete(key);
  }
}
