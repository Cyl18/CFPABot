// src/flows/_shared/review/term-projection.ts
// PURE: Filter a term asset to only terms relevant to a specific set of batch items.
// Workers receive this projection, never the full TermAsset.
// No I/O, no side effects. Defines its own minimal input interfaces to
// avoid importing agent/review-run domain types.
// Spec: docs/specs/08-translation-review-agent.md §9.3
// Delta: docs/specs/09-translation-review-delta.md §12

// ─── Minimal pure-data interfaces for projection ──────────────────────
// These mirror a subset of agent/review-run types structurally.
// TermAsset (from agent domain) is structurally assignable to
// ProjectableTermAsset — consumers pass the domain TermAsset directly.

export interface ProjectableTermCandidate {
  term: string;
  confidence: "high" | "medium" | "low";
  context: string;
  source: string;
}

export interface ProjectableTermMatch {
  sourceTerm: string;
  translations: string[];
}

export interface ProjectableTermAsset {
  termAssetId: string;
  /** Run this asset was produced for (for validation). */
  runId?: string;
  difficultTerms: ProjectableTermCandidate[];
  communityMatches: ProjectableTermMatch[];
  vanillaMatches: ProjectableTermMatch[];
  consistencyCandidates: ProjectableTermCandidate[];
}

export interface BatchTermProjection {
  termAssetId: string;
  difficultTerms: ProjectableTermCandidate[];
  communityMatches: ProjectableTermMatch[];
  vanillaMatches: ProjectableTermMatch[];
  consistencyCandidates: ProjectableTermCandidate[];
}

export interface ProjectBatchTermsOptions {
  asset: ProjectableTermAsset;
  batchItemIds: string[];
  itemTexts: Map<string, string>;
}

/**
 * Maximum entries per category. Prevents a provider or PR content from
 * blowing up the prompt. Conservative mid-teen limits.
 */
const MAX_DIFFICULT_TERMS = 20;
const MAX_CONSISTENCY_CANDIDATES = 15;
const MAX_COMMUNITY_MATCHES = 15;
const MAX_VANILLA_MATCHES = 15;

/**
 * Maximum length for candidate term/context and match sourceTerm/translation strings.
 * Truncation appends "…" within the limit so the stored length == maxLen.
 */
const MAX_TERM_LENGTH = 40;
const MAX_CONTEXT_LENGTH = 120;
const MAX_SOURCE_TERM_LENGTH = 40;
const MAX_TRANSLATION_LENGTH = 60;
const MAX_TRANSLATIONS_PER_MATCH = 5;

const CONFIDENCE_RANK: Record<string, number> = {
  high: 0, medium: 1, low: 2,
};

/** Truncate string to maxLen chars appending "…" if over. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * Tokenize text into normalized tokens.
 * Keeps all non-empty tokens so multi-word phrases like "Eye of Ender"
 * produce ["eye", "of", "ender"] for contiguous matching.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-zA-Z0-9]+/).filter((t) => t.length > 0);
}

// ─── Exported type guard for projection input ──────────────────────────

export interface ValidationError {
  field: string;
  detail: string;
}

/**
 * Validate that a raw object matches ProjectableTermAsset shape.
 * Returns empty array on success, non-empty on failure.
 */
export function validateProjectableTermAsset(
  raw: unknown,
  expectedAssetId?: string,
  expectedRunId?: string,
): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!raw || typeof raw !== "object") return [{ field: "root", detail: "not an object" }];
  const o = raw as Record<string, unknown>;

  if (o.schemaVersion !== 1) {
    errs.push({ field: "schemaVersion", detail: "must be 1" });
  }
  if (typeof o.termAssetId !== "string" || (expectedAssetId !== undefined && o.termAssetId !== expectedAssetId)) {
    errs.push({ field: "termAssetId", detail: "missing or mismatch" });
  }
  if (typeof o.runId !== "string" || (expectedRunId !== undefined && o.runId !== expectedRunId)) {
    errs.push({ field: "runId", detail: "missing or mismatch" });
  }

  const checkCandidates = (arr: unknown, field: string) => {
    if (!Array.isArray(arr)) { errs.push({ field, detail: "not an array" }); return; }
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i] as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object") { errs.push({ field: `${field}[${i}]`, detail: "not an object" }); continue; }
      if (typeof c.term !== "string") errs.push({ field: `${field}[${i}].term`, detail: "missing or not a string" });
      if (typeof c.context !== "string") errs.push({ field: `${field}[${i}].context`, detail: "missing or not a string" });
      if (!["high", "medium", "low"].includes(c.confidence as string)) errs.push({ field: `${field}[${i}].confidence`, detail: "invalid" });
      if (c.source !== undefined && typeof c.source !== "string") errs.push({ field: `${field}[${i}].source`, detail: "not a string" });
    }
  };
  const checkMatches = (arr: unknown, field: string) => {
    if (!Array.isArray(arr)) { errs.push({ field, detail: "not an array" }); return; }
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i] as Record<string, unknown> | undefined;
      if (!m || typeof m !== "object") { errs.push({ field: `${field}[${i}]`, detail: "not an object" }); continue; }
      if (typeof m.sourceTerm !== "string") errs.push({ field: `${field}[${i}].sourceTerm`, detail: "missing or not a string" });
      if (!Array.isArray(m.translations)) errs.push({ field: `${field}[${i}].translations`, detail: "not an array" });
      else {
        for (let j = 0; j < m.translations.length; j++) {
          if (typeof m.translations[j] !== "string") errs.push({ field: `${field}[${i}].translations[${j}]`, detail: "not a string" });
        }
      }
    }
  };

  checkCandidates(o.difficultTerms, "difficultTerms");
  checkMatches(o.communityMatches, "communityMatches");
  checkMatches(o.vanillaMatches, "vanillaMatches");
  checkCandidates(o.consistencyCandidates, "consistencyCandidates");

  return errs;
}

// ─── Projection logic ──────────────────────────────────────────────────

/**
 * Deterministic pure projection: filter the term asset to only terms/matches
 * that are relevant to a specific set of batch items.
 * Worker batches receive this projection.
 */
export function projectBatchTerms(
  options: ProjectBatchTermsOptions,
): BatchTermProjection {
  const { asset, batchItemIds, itemTexts } = options;

  // ── Collect per-item token sequences for phrase matching ──────────
  // Keeps item boundaries so a phrase cannot match across two items.
  const perItemTokens = new Map<string, string[]>();
  for (const itemId of batchItemIds) {
    const text = itemTexts.get(itemId);
    if (!text) continue;
    perItemTokens.set(itemId, tokenize(text));
  }

  /** Check if a term phrase appears within any single item's tokens. */
  function matchesBatch(tokens: string[]): boolean {
    if (tokens.length === 0) return false;
    for (const itemTokens of perItemTokens.values()) {
      if (tokens.length === 1) {
        // Single token: simple membership (must be >= 3 chars to match)
        if (tokens[0]!.length >= 3 && itemTokens.includes(tokens[0]!)) return true;
      } else {
        // Multi-token phrase: sliding window
        for (let i = 0; i <= itemTokens.length - tokens.length; i++) {
          let match = true;
          for (let j = 0; j < tokens.length; j++) {
            if (itemTokens[i + j] !== tokens[j]) { match = false; break; }
          }
          if (match) return true;
        }
      }
    }
    return false;
  }

  /** Same tokenization for term phrase as batch text. */
  function termTokens(raw: string): string[] {
    return tokenize(raw);
  }

  // ── Dedup independently per category — also dedup translations ───

  function dedupCandidates(arr: ProjectableTermCandidate[]): ProjectableTermCandidate[] {
    const seen = new Set<string>();
    const result: ProjectableTermCandidate[] = [];
    for (const c of arr) {
      const key = c.term.toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(c); }
    }
    return result;
  }

  function dedupMatches(arr: ProjectableTermMatch[]): ProjectableTermMatch[] {
    const seen = new Set<string>();
    const result: ProjectableTermMatch[] = [];
    for (const m of arr) {
      const key = m.sourceTerm.toLowerCase();
      if (!seen.has(key)) {
        // Also dedup translations within the match
        const tseen = new Set<string>();
        const dedupedTranslations: string[] = [];
        for (const t of m.translations) {
          const tkey = t.toLowerCase();
          if (!tseen.has(tkey)) { tseen.add(tkey); dedupedTranslations.push(t); }
        }
        seen.add(key);
        result.push({ ...m, translations: dedupedTranslations });
      }
    }
    return result;
  }

  // Helper: sort by confidence then codepoint, slice + truncate
  function pickCandidates(arr: ProjectableTermCandidate[], max: number): ProjectableTermCandidate[] {
    return [...dedupCandidates(arr)]
      .sort((a, b) => {
        const rankA = CONFIDENCE_RANK[a.confidence] ?? 3;
        const rankB = CONFIDENCE_RANK[b.confidence] ?? 3;
        if (rankA !== rankB) return rankA - rankB;
        if (a.term < b.term) return -1;
        if (a.term > b.term) return 1;
        return 0;
      })
      .slice(0, max)
      .map((c) => ({
        ...c,
        term: truncate(c.term, MAX_TERM_LENGTH),
        context: truncate(c.context, MAX_CONTEXT_LENGTH),
      }));
  }

  function pickMatches(arr: ProjectableTermMatch[], max: number): ProjectableTermMatch[] {
    return [...dedupMatches(arr)]
      .sort((a, b) => {
        if (a.sourceTerm < b.sourceTerm) return -1;
        if (a.sourceTerm > b.sourceTerm) return 1;
        return 0;
      })
      .slice(0, max)
      .map((m) => ({
        ...m,
        sourceTerm: truncate(m.sourceTerm, MAX_SOURCE_TERM_LENGTH),
        translations: m.translations
          .slice(0, MAX_TRANSLATIONS_PER_MATCH)
          .map((t) => truncate(t, MAX_TRANSLATION_LENGTH)),
      }));
  }

  // ── Match using phrase tokenization per-item ──────────────────────

  // Filter difficult terms
  const difficultTerms = pickCandidates(
    asset.difficultTerms.filter((t) => matchesBatch(termTokens(t.term))),
    MAX_DIFFICULT_TERMS,
  );

  // Filter community matches
  const communityMatches = pickMatches(
    asset.communityMatches.filter((m) => matchesBatch(termTokens(m.sourceTerm))),
    MAX_COMMUNITY_MATCHES,
  );

  // Filter vanilla matches
  const vanillaMatches = pickMatches(
    asset.vanillaMatches.filter((m) => matchesBatch(termTokens(m.sourceTerm))),
    MAX_VANILLA_MATCHES,
  );

  // Filter consistency candidates: include if source itemId is in this batch
  // OR the candidate's term appears in batch text (multi-word aware)
  const consistencyCandidates = pickCandidates(
    asset.consistencyCandidates.filter((c) => {
      if (c.source && batchItemIds.includes(c.source)) return true;
      return matchesBatch(termTokens(c.term));
    }),
    MAX_CONSISTENCY_CANDIDATES,
  );

  return {
    termAssetId: asset.termAssetId,
    difficultTerms,
    communityMatches,
    vanillaMatches,
    consistencyCandidates,
  };
}
