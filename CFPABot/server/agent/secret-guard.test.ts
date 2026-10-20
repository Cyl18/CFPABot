import { describe, expect, test } from "bun:test";
import { secretViolation } from "./secret-guard.ts";

describe("secret guard", () => {
  test("拦截密钥环境变量", () => {
    expect(secretViolation({ command: "echo $GITHUB_PAT" })).toBeDefined();
    expect(secretViolation({ code: "print(os.environ)" })).toBeDefined();
    expect(secretViolation({ command: "printenv" })).toBeDefined();
    expect(secretViolation({ command: "env" })).toBeDefined();
  });

  test("拦截配置文件", () => {
    expect(secretViolation({ path: "config/llm.json" })).toBeDefined();
    expect(secretViolation({ command: "cat config/app.pem" })).toBeDefined();
    expect(secretViolation({ command: "cat config/secret.key" })).toBeDefined();
  });

  test("放行正常调用", () => {
    expect(secretViolation({ command: "rg placeholder projects" })).toBeUndefined();
    expect(secretViolation({ path: "pr://1/review/rows" })).toBeUndefined();
    expect(secretViolation({ path: "skill://review" })).toBeUndefined();
  });
});
