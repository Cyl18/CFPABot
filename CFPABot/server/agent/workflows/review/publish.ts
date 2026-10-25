import type { ReviewDraft } from "@cfpa/contracts/api";
import { assertBotWrites, gh } from "../../../github/client.ts";
import { logger } from "../../../log.ts";
import { prdata } from "../../../prdata.ts";
import { renderInlineBody, renderReviewBody, validateDraft } from "../../draft.ts";

const log = logger("agent-publish");

export interface PublishOptions {
  event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  marker?: string;
}

export async function publishDraft(
  draft: ReviewDraft,
  opts: PublishOptions = {},
): Promise<{ url: string; headSha: string }> {
  assertBotWrites();
  await prdata.refresh(draft.prNumber);
  const { pull, files } = await prdata.files(draft.prNumber);
  if (pull.headSha !== draft.headSha) {
    throw new Error(
      `PR #${draft.prNumber} 的 head 已变为 ${pull.headSha.slice(0, 7)}，草稿基于 ${draft.headSha.slice(0, 7)}，请重新审查后再发布`,
    );
  }
  const patches = new Map(files.map((file) => [file.path, file.patch]));
  const errors = validateDraft(draft, { patches });
  if (errors.length > 0) throw new Error(`草稿校验失败：${errors.join("；")}`);
  const body = opts.marker === undefined ? renderReviewBody(draft) : `${renderReviewBody(draft)}\n\n${opts.marker}`;
  const review = await gh.createReview(draft.prNumber, {
    commitId: pull.headSha,
    body,
    event: opts.event ?? "COMMENT",
    comments: draft.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: renderInlineBody(comment),
    })),
  });
  log.info("已发布审查", { prNumber: draft.prNumber, comments: draft.comments.length, url: review.htmlUrl });
  return { url: review.htmlUrl, headSha: pull.headSha };
}
