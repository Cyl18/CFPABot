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
      return seg.length >= 3 && seg[0] === "files" && seg.at(-1) === "comments";
    },
  },
  {
    id: "pr-thread-state",
    uri: "pr://<n>/threads/<id>",
    summary: "标记 review 线程已解决或重新打开",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "threads";
    },
  },
  {
    id: "pr-thread-reply",
    uri: "pr://<n>/threads/<id>/replies",
    summary: "回复一个 review 线程",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 3 && seg[0] === "threads" && seg[2] === "replies";
    },
  },
  {
    id: "pr-review",
    uri: "pr://<n>/review",
    summary: "发布审查草稿",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 1 && seg[0] === "review";
    },
  },
  {
    id: "pr-review-submit",
    uri: "pr://<n>/review/submit",
    summary: "提交 pending review 或直接提交审查结论",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "review" && seg[1] === "submit";
    },
  },
  {
    id: "pr-comment-replace",
    uri: "pr://<n>/comments/<id>",
    summary: "整段替换机器人自己的 PR 评论（先读原文再写全文）",
    match: (parts) => {
      const seg = prSegments(parts);
      return seg.length === 2 && seg[0] === "comments";
    },
  },
  {
    id: "pr-review-comment-replace",
    uri: "pr://<n>/review-comments/<id>",
    summary: "整段替换机器人自己的行内评论（先读原文再写全文）",
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
