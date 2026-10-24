import type { ContentfulStatusCode } from "hono/utils/http-status";

/** 与路由无关的错误类型：GitHub 层也能抛，由路由层统一映射成响应。 */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string | undefined;

  constructor(status: ContentfulStatusCode, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}
