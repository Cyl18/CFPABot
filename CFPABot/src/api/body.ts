// src/api/body.ts
// Schema-first JSON request bodies + uniform error envelopes for HTTP endpoints.
//
// Flow-backed endpoints already get this boundary from the Flow engine
// (engine/validate.ts decodeOrThrow → FlowError(INVALID_INPUT)). This module
// is the same boundary for endpoints that bypass the engine: parse → validate
// → one error envelope, replacing the hand-rolled `c.req.json()` try/catch +
// typeof field checks that used to live per route.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Static, TSchema } from "typebox";
import { FlowError } from "@/types.js";
import { decodeOrThrow } from "@/engine/validate.js";
import { MAX_BODY_SIZE } from "./frontend/helpers.js";

/** Request-body failures: carries the HTTP status to emit. */
export class HttpBodyError extends Error {
  readonly status: ContentfulStatusCode;
  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "HttpBodyError";
    this.status = status;
  }
}

/** Narrow an arbitrary numeric status to Hono's literal union. */
function isContentfulStatus(status: number): status is ContentfulStatusCode {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

/**
 * Parse + size-guard + schema-validate a JSON request body.
 * Throws HttpBodyError (400/413) for transport-level failures and
 * FlowError(INVALID_INPUT) (via decodeOrThrow) for schema mismatches —
 * both are rendered by sendApiError().
 */
export async function parseBody<T extends TSchema>(
  c: Context,
  schema: T,
): Promise<Static<T>> {
  const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_SIZE) throw new HttpBodyError(413, "请求体过大");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpBodyError(400, "请求体不是有效的 JSON");
  }
  return decodeOrThrow(schema, raw, "input");
}

/** FlowError code → HTTP status. */
export function flowErrorToStatusCode(
  err: FlowError,
): 400 | 403 | 409 | 429 | 503 | 504 | 500 {
  switch (err.code) {
    case "INVALID_INPUT":
      return 400;
    case "SCOPE_VIOLATION":
      return 403;
    case "CONFLICT":
      return 409;
    case "UPSTREAM_RATE_LIMITED":
      return 429;
    case "UPSTREAM_UNAVAILABLE":
      return 503;
    case "TIMEOUT":
      return 504;
    case "CONFIRMATION_REQUIRED":
    case "STALE_HEAD":
    case "FAILED":
      return 500;
    case "REVIEW_PUBLISH_DISABLED":
      return 503;
  }
}

/**
 * Uniform error → Response envelope ({ error, code?, detail? }).
 * FlowError carries its machine-readable code; HttpBodyError its status;
 * anything else becomes a generic 500 with an optional prefix.
 */
export function sendApiError(
  c: Context,
  err: unknown,
  options?: { prefix?: string },
): Response {
  if (err instanceof FlowError) {
    const status = flowErrorToStatusCode(err);
    return c.json(
      { error: err.publicMessage, code: err.code, detail: err.message },
      status,
    );
  }
  if (err instanceof HttpBodyError) {
    return c.json({ error: err.message }, err.status);
  }
  // Errors carrying a numeric HTTP status (e.g. LlmCallError from upstream
  // failures) keep it; anything else becomes a generic 500.
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    const message = err instanceof Error ? err.message : String(err);
    if (isContentfulStatus(err.status)) {
      return c.json({ error: message }, err.status);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  const prefix = options?.prefix ? `${options.prefix}: ` : "";
  return c.json({ error: prefix + message }, 500);
}
