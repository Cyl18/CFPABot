// src/client/terminology/types.ts
// Minimal domain interfaces for terminology lookup.
// No DB schema, registry, snapshot/version subsystem, or mock data.
// Spec: docs/specs/08-translation-review-agent.md §9.1
// Delta: docs/specs/09-translation-review-delta.md §5.5, §12

/** Source identifier for a terminology provider. */
export type TerminologySource = "community" | "vanilla";

/**
 * Terminology provider — adapter for external dictionary sources.
 * Not configured → the provider is absent from the injected array.
 * Never returns empty results for an unconfigured source.
 */
export interface TerminologyProvider {
  readonly source: TerminologySource;
  lookup(input: {
    terms: string[];
    context: {
      runId: string;
      mcVersion?: string;
    };
  }): Promise<TermMatch[]>;
}

/** A single term match from a terminology provider. */
export interface TermMatch {
  /** The term that was looked up (as passed in the request). */
  sourceTerm: string;
  /** One or more known translations for this term. */
  translations: string[];
  /** Which provider returned this match. */
  source: TerminologySource;
  /** Provider-specific metadata; schema defined by the adapter, not consumed by Flow code. */
  metadata?: unknown;
}
