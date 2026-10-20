import type { ResourceUri } from "./uri.ts";

export type WriteMethod = "write" | "edit";

export interface WriteTarget {
  id: string;
  methods: readonly WriteMethod[];
  uri: string;
  summary: string;
  scope: "github" | "local";
  match(uri: ResourceUri): boolean;
}

function prSegments(uri: ResourceUri): string[] {
  return uri.scheme === "pr" ? uri.path.split("/").filter(Boolean) : [];
}

export const WRITE_TARGETS: readonly WriteTarget[] = [
  {
    id: "pr-comment",
    methods: ["write"],
    uri: "pr://<n>/comments",
    summary: "在 PR 下发一条评论",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 1 && seg[0] === "comments";
    },
  },
  {
    id: "pr-inline-comment",
    methods: ["write"],
    uri: "pr://<n>/files/<path>/comments?line=<head 行号>",
    summary: "在 PR 文件的 head 行上发一条行内评论",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length >= 3 && seg[0] === "files" && seg.at(-1) === "comments";
    },
  },
  {
    id: "pr-thread-state",
    methods: ["write"],
    uri: "pr://<n>/threads/<id>",
    summary: "标记 review 线程已解决或重新打开",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 2 && seg[0] === "threads";
    },
  },
  {
    id: "pr-thread-reply",
    methods: ["write"],
    uri: "pr://<n>/threads/<id>/replies",
    summary: "回复一个 review 线程",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 3 && seg[0] === "threads" && seg[2] === "replies";
    },
  },
  {
    id: "pr-review",
    methods: ["write"],
    uri: "pr://<n>/review",
    summary: "发布审查草稿",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 1 && seg[0] === "review";
    },
  },
  {
    id: "pr-review-submit",
    methods: ["write"],
    uri: "pr://<n>/review/submit",
    summary: "提交 pending review 或直接提交审查结论",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 2 && seg[0] === "review" && seg[1] === "submit";
    },
  },
  {
    id: "pr-comment-edit",
    methods: ["edit"],
    uri: "pr://<n>/comments/<id>",
    summary: "编辑机器人自己的 PR 评论",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 2 && seg[0] === "comments";
    },
  },
  {
    id: "pr-review-comment-edit",
    methods: ["edit"],
    uri: "pr://<n>/review-comments/<id>",
    summary: "编辑机器人自己的行内评论",
    scope: "github",
    match: (uri) => {
      const seg = prSegments(uri);
      return seg.length === 2 && seg[0] === "review-comments";
    },
  },
  {
    id: "local-file",
    methods: ["write", "edit"],
    uri: "local://<path>",
    summary: "写或改会话 workspace 里的文件",
    scope: "local",
    match: (uri) => uri.scheme === "local",
  },
];

export function findWriteTarget(method: WriteMethod, uri: ResourceUri): WriteTarget | undefined {
  return WRITE_TARGETS.find((target) => target.methods.includes(method) && target.match(uri));
}

export function writableUris(method: WriteMethod): string[] {
  return WRITE_TARGETS.filter((target) => target.methods.includes(method)).map((target) => target.uri);
}
