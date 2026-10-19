import { describe, expect, test } from "bun:test";
import { runSandbox } from "./client.ts";

const enabled = process.env.EVAL_SANDBOX === "1" && Bun.which("docker") !== null;

describe("eval 沙箱集成", () => {
  test.skipIf(!enabled)(
    "bash 返回 stdout",
    async () => {
      const result = await runSandbox({ language: "bash", code: "echo 42", timeoutMs: 20_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("42");
      expect(result.outputLimited).toBe(false);
    },
    30_000,
  );
});
