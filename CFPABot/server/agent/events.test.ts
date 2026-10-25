import { describe, expect, test } from "bun:test";
import { statusEventOf } from "./events.ts";

describe("retry status", () => {
  test("重试开始时给出次数与等待时间", () => {
    const event = statusEventOf({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 13_000,
      errorMessage: "429 Upstream request failed",
    });
    expect(event).toEqual({
      type: "status",
      status: "running",
      note: "上游请求失败，约 13 秒后自动重试（第 2/5 次）",
    });
  });

  test("重试成功后清除提示，失败交给收尾的 idle 事件", () => {
    expect(statusEventOf({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual({
      type: "status",
      status: "running",
    });
    expect(statusEventOf({ type: "auto_retry_end", success: false, attempt: 2 })).toBeUndefined();
    expect(statusEventOf({ type: "auto_compaction_start", reason: "threshold", action: "context-full" })).toBeUndefined();
  });
});
