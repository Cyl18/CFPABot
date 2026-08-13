// src/flows/info-comment/state.ts
// InfoCommentState persistence: read, write, migrate, invalidate.
// Uses FileStore atomic write (temp + rename) with revision checking.
// Path: runtime/state/info-comments/{owner}/{repo}/{prNumber}.json

import type { FileStore, Logger } from "@/types.js";
import type {
  InfoCommentState,
  InfoCommentSectionStates,
  SectionState,
  PublicError,
} from "../_shared/types.js";
import crypto from "node:crypto";
import { INFO_COMMENTS_DIR } from "../../runtime-paths.js";

// ─── Constants ──────────────────────────────────────────────────────
const CURRENT_SCHEMA_VERSION = 1 as const;
const STATE_DIR_PREFIX = INFO_COMMENTS_DIR;

// ─── Path helpers ───────────────────────────────────────────────────

export function infoCommentStatePath(owner: string, name: string, prNumber: number): string {
  return `${STATE_DIR_PREFIX}/${owner}/${name}/${prNumber}.json`;
}

// ─── Read ───────────────────────────────────────────────────────────

export async function loadInfoCommentState(
  store: FileStore,
  owner: string,
  name: string,
  prNumber: number,
): Promise<InfoCommentState | null> {
  const path = infoCommentStatePath(owner, name, prNumber);
  const raw = await store.read<InfoCommentState>(path);
  if (!raw) return null;

  // Schema version check — mismatch triggers full rebuild
  if ((raw as unknown as Record<string, unknown>).schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return null;
  }

  return raw;
}

// ─── Write with revision check ──────────────────────────────────────

export interface SaveStateOptions {
  expectedRevision?: number;
}

export interface SaveStateResult {
  saved: boolean;
  actualRevision: number;
}

/**
 * Save state with optional expectedRevision check.
 * Uses FileStore's atomic write (temp file + rename).
 *
 * When expectedRevision is provided and doesn't match the stored revision,
 * the write is skipped and actualRevision returns the stored value.
 * Caller should re-read and retry.
 */
export async function saveInfoCommentState(
  store: FileStore,
  owner: string,
  name: string,
  prNumber: number,
  state: InfoCommentState,
  options?: SaveStateOptions,
): Promise<SaveStateResult> {
  const path = infoCommentStatePath(owner, name, prNumber);

  // Check expected revision
  if (options?.expectedRevision !== undefined) {
    const current = await loadInfoCommentState(store, owner, name, prNumber);
    if (current && current.revision !== options.expectedRevision) {
      return { saved: false, actualRevision: current.revision };
    }
  }

  await store.write(path, state);
  return { saved: true, actualRevision: state.revision };
}

// ─── Create initial pending state ───────────────────────────────────

export function createPendingState(
  repo: string,
  prNumber: number,
  headSha: string,
): InfoCommentState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 1,
    repo,
    prNumber,
    headSha,
    updatedAt: new Date().toISOString(),
    sections: {
      mods: { status: "pending" },
      artifacts: { status: "pending" },
      checks: { status: "pending" },
      translationDiff: { status: "pending" },
    },
  };
}

// ─── Build next revision state ──────────────────────────────────────

/**
 * Build a new state object by merging existing state with updated sections.
 * Increments revision, updates headSha and updatedAt.
 */
export function buildNextState(
  existing: InfoCommentState,
  headSha: string,
  sections: Partial<InfoCommentSectionStates>,
): InfoCommentState {
  return {
    ...existing,
    revision: existing.revision + 1,
    headSha,
    updatedAt: new Date().toISOString(),
    sections: {
      ...existing.sections,
      ...sections,
    },
  };
}

// ─── Invalidate sections for force refresh ──────────────────────────

/**
 * Set the listed sections (or all) back to pending, clearing their data.
 * Used by force_refresh to invalidate caches.
 */
export function invalidateSections(
  state: InfoCommentState,
  sectionNames?: Array<keyof InfoCommentSectionStates>,
): InfoCommentState {
  const sections = { ...state.sections } as InfoCommentSectionStates;
  const names = sectionNames ?? (["mods", "artifacts", "checks", "translationDiff"] as const);

  for (const name of names) {
    // Set to pending — clear data, hash, error
    (sections as unknown as Record<string, SectionState<unknown>>)[name] = { status: "pending" };
  }

  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: new Date().toISOString(),
    sections,
  };
}

// ─── Incorporate a collector result into state ──────────────────────

/**
 * Convert a SectionResult (from collector) into a SectionState (with timestamp)
 * and return the updated section slice.
 */
export function sectionResultToState<T>(
  result: { status: "ready" | "empty" | "error"; data?: T; inputHash: string; error?: PublicError },
): SectionState<T> {
  const now = new Date().toISOString();
  switch (result.status) {
    case "ready":
      return { status: "ready", data: result.data as T, inputHash: result.inputHash, updatedAt: now };
    case "empty":
      return { status: "empty", inputHash: result.inputHash, updatedAt: now };
    case "error":
      return { status: "error", error: result.error!, inputHash: result.inputHash, updatedAt: now };
  }
}

// ─── Input hash helpers ─────────────────────────────────────────────

/** Build a simple sha-256 hex hash from the concatenated inputs. */
export function hashInputs(...parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const p of parts) {
    hash.update(p);
  }
  return hash.digest("hex");
}

/** Check if a section's input hash matches, indicating unchanged inputs. */
export function sectionInputUnchanged(
  section: SectionState<unknown>,
  currentInputHash: string,
): boolean {
  if (section.status === "pending") return false;
  return section.inputHash === currentInputHash;
}
