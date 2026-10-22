import { expect, test } from "bun:test";
import { buildSystemPrompt } from "../prompt.ts";
import { generalWorkflow } from "./general.ts";
import { resolveWorkflow } from "./index.ts";

test("general workflow loads review skill", () => {
  expect(generalWorkflow.promptFiles).toHaveLength(0);
  expect(generalWorkflow.skills).toContain("review");
  expect(generalWorkflow.defaults.evalScope).toBe("run");
});

test("system prompt carries no review contract", async () => {
  const prompt = await buildSystemPrompt(generalWorkflow);
  expect(prompt).not.toContain("审查会话硬约束");
});

test("registry falls back to general", () => {
  expect(resolveWorkflow("general").id).toBe("general");
  expect(resolveWorkflow("missing").id).toBe("general");
});
