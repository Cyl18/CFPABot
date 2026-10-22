import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "../log.ts";
import { resolveModel } from "./llm.ts";

const log = logger("title");
const TITLE_TIMEOUT_MS = 4_000;
const MAX_TITLE = 24;

/** 首行折叠空白、去掉尾部标点，作为 LLM 失败时的标题。 */
export function fallbackTitle(message: string): string {
  const head = message.split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return (head.replace(/[。．.!！?？:：;；]+$/u, "") || "新会话").slice(0, MAX_TITLE);
}

/** LLM 输出常带引号、换行和多余标点，这里统一收干净。 */
export function cleanTitle(raw: string): string {
  const line = raw.split(/\r?\n/).find((part) => part.trim() !== "") ?? "";
  return line
    .replace(/^["'“”‘’「」『』`#*\s]+/u, "")
    .replace(/["'“”‘’「」『』`*\s。．.!！?？]+$/u, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE);
}

export async function sessionTitle(message: string, modelId: string): Promise<string> {
  const fallback = fallbackTitle(message);
  try {
    const { model, apiKey } = await resolveModel(modelId);
    const response = await completeSimple(
      model,
      {
        systemPrompt: [
          "给下面这条会话消息起一个中文短标题：最多 16 个字，只输出标题本身，不要引号、标点、PR 编号，也不要“审查/查看”这类前缀。",
        ],
        messages: [{ role: "user", content: message.slice(0, 2000), timestamp: Date.now() }],
      },
      { apiKey, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") return fallback;
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return cleanTitle(text) || fallback;
  } catch (err) {
    log.warn("会话标题生成失败，回退到首行", { err });
    return fallback;
  }
}
