// src/agent/llm-config-schema.ts
// TypeBox schemas for the LLM endpoint config PUT body (llm-endpoints.json).
//
// The schema validates structure — types, required fields, protocol enum,
// positive-integer limits. Business rules schemas cannot express (absolute
// URL validity, trim-to-empty rejection, defaults cross-references, apiKey
// merge) stay in llm-config-store.ts as the second validation stage — the
// same schema + auxValidate split as the omp config-file pattern.

import { Type } from "typebox";
import { KNOWN_PROTOCOLS } from "./llm-types.js";

/** Protocol field: null/"" mean "use default"; unknown values are rejected. */
export const ProtocolFieldSchema = Type.Union([
  Type.Null(),
  Type.Literal(""),
  ...KNOWN_PROTOCOLS.map((p) => Type.Literal(p)),
]);

export const LlmEndpointInputSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  baseUrl: Type.String(),
  apiKey: Type.Optional(Type.String()),
  protocol: Type.Optional(ProtocolFieldSchema),
  inputLimit: Type.Optional(Type.Integer({ minimum: 1 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ModelRefSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  // Loose: non-empty whitelisted levels are kept by the business layer;
  // unknown/empty values are silently dropped (legacy behavior).
  thinkingLevel: Type.Optional(Type.String()),
});

export const LlmDefaultsSchema = Type.Object({
  sessionModel: Type.Optional(ModelRefSchema),
  reviewModelSet: Type.Optional(Type.Array(ModelRefSchema)),
});

export const LlmConfigBodySchema = Type.Object({
  endpoints: Type.Array(LlmEndpointInputSchema),
  defaults: Type.Optional(LlmDefaultsSchema),
});
