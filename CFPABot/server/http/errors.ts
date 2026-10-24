import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { ApiError } from "@cfpa/contracts/api";
import { HttpError } from "../errors.ts";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function jsonError(c: Context, status: ContentfulStatusCode, message: string, code?: string): Response {
  const body: ApiError = code ? { error: message, code } : { error: message };
  return c.json(body, status);
}

export function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw new HttpError(400, zodMessage(result.error), "invalid_query");
  return result.data;
}

export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大", "body_too_large");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "请求体不是有效的 JSON", "invalid_json");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, zodMessage(result.error), "invalid_body");
  return result.data;
}

export function errorResponse(err: unknown): { status: ContentfulStatusCode; body: ApiError } {
  if (err instanceof HttpError) {
    if (err.status >= 500) return { status: err.status, body: err.code ? { error: "Internal Server Error", code: err.code } : { error: "Internal Server Error" } };
    return { status: err.status, body: err.code ? { error: err.message, code: err.code } : { error: err.message } };
  }
  const status = upstreamStatus(err);
  if (status !== null && status < 500) {
    return { status, body: { error: err instanceof Error ? err.message : "请求失败" } };
  }
  return { status: status ?? 500, body: { error: "Internal Server Error" } };
}

function upstreamStatus(err: unknown): ContentfulStatusCode | null {
  if (!err || typeof err !== "object" || !("status" in err)) return null;
  const status = err.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) return null;
  return status as ContentfulStatusCode;
}

export function isUpstreamNotFound(err: unknown): boolean {
  return upstreamStatus(err) === 404;
}

export function notFound(message = "未找到"): HttpError {
  return new HttpError(404, message, "not_found");
}
