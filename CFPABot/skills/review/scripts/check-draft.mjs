import { readFile } from "node:fs/promises";
import { severityWarnings, validateDraft } from "../../../packages/review-core/src/draft.ts";

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

const shape = [];
if (draft === null || typeof draft !== "object") shape.push("draft 必须是对象");
if (typeof draft?.summary !== "string") shape.push("summary 必须是字符串");
if (!Array.isArray(draft?.comments)) shape.push("comments 必须是数组");
else if (draft.comments.some((comment) => comment === null || typeof comment !== "object")) {
  shape.push("comments 的每一项必须是对象");
}
if (shape.length > 0) {
  console.error(shape.join("\n"));
  process.exit(1);
}

const errors = validateDraft(draft, {});
const warnings = severityWarnings(draft);
if (warnings.length > 0) console.error(["提示（不拦截）：", ...warnings].join("\n"));
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`ok: ${draft.comments.length} 条 inline；行号与 headSha 由发布时服务端校验`);
