import { env } from "../../env.ts";

const BODY_LIMIT = 2000;

export function trimBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > BODY_LIMIT ? `${trimmed.slice(0, BODY_LIMIT)}…[已截断]` : trimmed;
}

export function isMainBot(author: string, body: string): boolean {
  return body.startsWith("<!--CYBOT-->") && (author === env.BOT_LOGIN || author === "Cyl18-Bot");
}

export function isAgentBody(body: string): boolean {
  return body.includes("<!--CFPA-AGENT:");
}

export function visibleIssueComment(comment: { author: string; body: string; isBot: boolean }): boolean {
  return !isMainBot(comment.author, comment.body) && (!comment.isBot || isAgentBody(comment.body));
}

export function visibleReviewComment(comment: { author: string; body: string }): boolean {
  return !isMainBot(comment.author, comment.body) && (!comment.author.endsWith("[bot]") || isAgentBody(comment.body));
}

export function missingResource(resource: string, children: readonly string[]): never {
  throw new Error(`未知资源 ${resource}。可用子资源：${children.join("、")}。`);
}
