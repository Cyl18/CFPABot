import { endpointFor, modelsCollection } from "./llm.ts";
import { buildModel, reasoningOf } from "./llm-providers.ts";
import type { Reviewer } from "./multi-review.ts";

export class LlmCallError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmCallError";
    this.status = status;
  }
}

function statusFrom(message: string | undefined): number | undefined {
  const match = /(?:^|\D)(4\d\d|5\d\d)(?:\D|$)/.exec(message ?? "");
  return match?.[1] ? Number(match[1]) : undefined;
}

export async function createReviewers(ids: readonly string[]): Promise<Reviewer[]> {
  if (ids.length === 0) throw new Error("未配置审查模型（config/llm.json 的 reviewers）");
  const collection = await modelsCollection();
  const reviewers: Reviewer[] = [];
  for (const id of ids) {
    const endpoint = await endpointFor(id);
    const model = collection.getModel(endpoint.provider, endpoint.model) ?? buildModel(endpoint);
    reviewers.push({
      id,
      complete: async (system, user, signal) => {
        const response = await collection.completeSimple(
          model,
          { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
          {
            apiKey: endpoint.apiKey || undefined,
            maxTokens: endpoint.maxOutput ?? 8192,
            reasoning: reasoningOf(endpoint),
            signal,
          },
        );
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          const message = response.errorMessage ?? "LLM 调用失败";
          throw new LlmCallError(message, statusFrom(message));
        }
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        if (!text) throw new LlmCallError("LLM 返回了空内容");
        return text;
      },
    });
  }
  return reviewers;
}
