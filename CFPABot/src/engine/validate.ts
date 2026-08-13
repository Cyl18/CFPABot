// src/engine/validate.ts
// TypeBox runtime validation helpers for Flow input/output.

import { Value } from "typebox/value";
import type { TSchema, Static } from "typebox";
import { FlowError } from "@/types.js";

/** Validate `data` against `schema` at runtime. Returns typed data when
 *  valid; throws `FlowError(INVALID_INPUT)` on mismatch. */
export function decodeOrThrow<T extends TSchema>(
  schema: T,
  data: unknown,
  label: "input" | "output",
): Static<T> {
  if (Value.Check(schema, data)) {
    // Value.Check narrows at runtime; the cast is safe after the check.
    return data as Static<T>;
  }
  const list: Array<{ keyword: string; schemaPath: string; instancePath: string; message: string }> = Value.Errors(schema, data);
  const detail = list
    .slice(0, 5)
    .map((e) => `${e.instancePath || '/'}: ${e.message}`)
    .join("; ");
  throw new FlowError({
    code: "INVALID_INPUT",
    message: `Flow ${label} validation failed: ${detail}`,
    retryable: false,
    details: { errorCount: list.length, sample: list.slice(0, 5) },
  });
}
