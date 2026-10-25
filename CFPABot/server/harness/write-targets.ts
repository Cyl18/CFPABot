import type { PrParts } from "./uri.ts";

export interface WriteTarget {
  id: string;
  uri: string;
  summary: string;
  match(parts: PrParts): boolean;
}

function prSegments(parts: PrParts): string[] {
  return parts.path.split("/").filter(Boolean);
}

export const WRITE_TARGETS: readonly WriteTarget[] = [
  {
    id: "pr-draft",
    uri: "pr://<n>/draft",
    summary: "保存草稿并按当前 head 校验；正文省略则复用 local://draft.json；有错不落盘，直接返回可改的字段",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 1 && seg[0] === "draft";
    },
  },
  {
    id: "pr-comment",
    uri: "pr://<n>/comments",
    summary: "在 PR 下发一条评论",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 1 && seg[0] === "comments";
    },
  },
  {
    id: "pr-inline-comment",
    uri: "pr://<n>/files/<path>/comments?line=<head 行号>",
    summary: "在 PR 文件的 head 行上发一条行内评论",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length >= 3 && seg[0] === "files" && seg[seg.length - 1] === "comments";
    },
  },
  {
    id: "pr-thread-state",
    uri: "pr://<n>/threads/<id>",
    summary: "把 review 线程标为 resolved 或未 resolved（正文写 true/false）",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "threads";
    },
  },
  {
    id: "pr-thread-reply",
    uri: "pr://<n>/threads/<id>/replies",
    summary: "回复一条 review 线程",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 3 && seg[0] === "threads" && seg[2] === "replies";
    },
  },
  {
    id: "pr-review",
    uri: "pr://<n>/review",
    summary: "发布审查：正文给草稿 JSON，省略则发布 pr://<n>/draft 已保存的草稿",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 1 && seg[0] === "review";
    },
  },
  {
    id: "pr-review-submit",
    uri: "pr://<n>/review/submit",
    summary: "提交 pending review 或直接提交审查结论（正文 {event, body}）",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "review" && seg[1] === "submit";
    },
  },
  {
    id: "pr-comment-replace",
    uri: "pr://<n>/comments/<id>",
    summary: "整段替换机器人自己的 PR 评论（id 从 pr://<n>/comments 取；先读原文再写全文）",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "comments";
    },
  },
  {
    id: "pr-review-comment-replace",
    uri: "pr://<n>/review-comments/<id>",
    summary: "整段替换机器人自己的行内评论（id 从 pr://<n>/comments 的 reviewComments 取；先读原文再写全文）",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "review-comments";
    },
  },
];

export function findWriteTarget(parts: PrParts): WriteTarget | undefined {
  return WRITE_TARGETS.find((target) => target.match(parts));
}

export function writableUris(): string[] {
  return WRITE_TARGETS.map((target) => target.uri);
}

export function unsupportedWrite(): Error {
  return new Error(`不支持的可写目标。可写：${writableUris().join("、")}`);
}
