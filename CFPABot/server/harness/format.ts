import { isMainBot } from "../bot/render.ts";

const BODY_LIMIT = 2000;

export function trimBody(body: string, limit = BODY_LIMIT): string {
  const trimmed = body.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…[已截断]` : trimmed;
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
