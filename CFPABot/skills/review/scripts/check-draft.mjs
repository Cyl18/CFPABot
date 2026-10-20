import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.error("用法: bun check-draft.mjs <draft.json>");
  process.exit(2);
}

let draft;
try {
  draft = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  console.error(`无法读取 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const errors = [];
const verdicts = new Set(["approve", "changes", "reject"]);
const severities = new Set(["critical", "major", "minor", "neutral"]);

if (!verdicts.has(draft.verdict)) errors.push(`verdict 非法: ${draft.verdict}`);
if (typeof draft.summary !== "string" || draft.summary.trim() === "") errors.push("summary 不能为空");
if (!Number.isInteger(draft.prNumber) || draft.prNumber <= 0) errors.push("prNumber 非法");
if (draft.headSha !== undefined && (typeof draft.headSha !== "string" || draft.headSha.trim() === "")) {
  errors.push("headSha 非法");
}

if (!Array.isArray(draft.comments)) {
  errors.push("comments 必须是数组");
} else {
  draft.comments.forEach((comment, index) => {
    const where = `${index + 1}. ${comment?.path ?? "?"}:${comment?.line ?? "?"}`;
    if (typeof comment?.path !== "string" || comment.path.trim() === "") errors.push(`${where}: path 不能为空`);
    if (!Number.isInteger(comment?.line) || comment.line <= 0) errors.push(`${where}: line 必须是正整数`);
    if (typeof comment?.key !== "string") errors.push(`${where}: key 必须是字符串`);
    if (!severities.has(comment?.severity)) errors.push(`${where}: severity 非法: ${comment?.severity}`);
    if (typeof comment?.mqm !== "string" || comment.mqm.trim() === "") errors.push(`${where}: mqm 不能为空`);
    if (typeof comment?.body !== "string" || comment.body.trim() === "") errors.push(`${where}: body 不能为空`);
    if (comment?.covers !== undefined && !Array.isArray(comment.covers)) errors.push(`${where}: covers 必须是数组`);
    if (comment?.suggestion !== undefined && typeof comment.suggestion !== "string") {
      errors.push(`${where}: suggestion 必须是字符串`);
    }
    if ((comment?.covers?.length ?? 0) > 0 && comment?.suggestion !== undefined) {
      errors.push(`${where}: covers 非空时不能同时给 suggestion`);
    }
    if (comment?.suspected === true && (comment.severity === "critical" || comment.severity === "major")) {
      errors.push(`${where}: 存疑项 severity 不能高于 minor`);
    }
    if (
      comment?.suspected !== true &&
      (comment?.covers?.length ?? 0) === 0 &&
      (typeof comment?.suggestion !== "string" || comment.suggestion.trim() === "")
    ) {
      errors.push(`${where}: 非存疑且没有 covers 的意见必须给 suggestion`);
    }
  });
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`ok: ${draft.comments.length} 条 inline；MQM、行号、headSha 由发布时服务端校验`);
