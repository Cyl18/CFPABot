import { expect, test } from "bun:test";
import { buildSystemPrompt } from "../prompt.ts";
import { generalWorkflow } from "./general.ts";
import { resolveWorkflow } from "./index.ts";
import { reviewWorkflow } from "./review.ts";

test("review workflow owns review assets", () => {
  expect(reviewWorkflow.requiresPr).toBe(true);
  expect(reviewWorkflow.promptFiles).toContain("review-contract.md");
  expect(reviewWorkflow.skills).toContain("review");
  expect(reviewWorkflow.defaults.evalScope).toBe("run");
  expect(reviewWorkflow.artifacts?.preferredFile).toBe("draft.json");
});

test("general workflow has no review assets", () => {
  expect(generalWorkflow.requiresPr).toBe(false);
  expect(generalWorkflow.promptFiles).toHaveLength(0);
  expect(generalWorkflow.skills).toHaveLength(0);
  expect(generalWorkflow.artifacts).toBeUndefined();
});

test("system prompt appends contract only for review", async () => {
  const review = await buildSystemPrompt(reviewWorkflow);
  expect(review).toContain("审查会话硬约束");
  const general = await buildSystemPrompt(generalWorkflow);
  expect(general).not.toContain("审查会话硬约束");
});

test("workflow prompt and registry", () => {
  expect(reviewWorkflow.firstPrompt({ prNumber: 12 })).toContain("审查 PR #12");
  expect(reviewWorkflow.firstPrompt({ prNumber: 12 })).toContain("skill://review");
  expect(generalWorkflow.firstPrompt({ message: "hello" })).toBe("hello");
  expect(resolveWorkflow("review").id).toBe("review");
  expect(resolveWorkflow("missing").id).toBe("general");
});
