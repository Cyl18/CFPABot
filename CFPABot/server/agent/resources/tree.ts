interface ResourceEntry {
  path: string;
  comment?: string;
}

const REPO: readonly ResourceEntry[] = [
  { path: "<目录>/", comment: "列出直接子项" },
  { path: "<path>[:N-M]?ref=<sha>", comment: "文件内容；无 ref 时读 origin 默认分支" },
];

const PR: readonly ResourceEntry[] = [
  { path: "files", comment: "变更文件与状态" },
  { path: "files/<path>[:N-M]?side=head|base" },
  { path: "comments", comment: "PR 评论与 review 评论" },
  { path: "threads", comment: "review 线程状态" },
  { path: "checks", comment: "机械检查报告" },
  { path: "workspaces" },
  { path: "related", comment: "关联 PR" },
  { path: "compare?slug=&version=&namespace=" },
  { path: "special-files" },
  { path: "special-files/content?key=" },
  { path: "meta" },
  { path: "review" },
  { path: "review/rows?workspace=&filter=changed|flagged|all&query=&offset=&limit=&rebuild=1" },
];

const GH: readonly ResourceEntry[] = [
  { path: "meta" },
  { path: "pulls?state=open|closed|merged|all" },
  { path: "issues/<n>" },
  { path: "issues/<n>/comments" },
  { path: "search?q=&type=issue|pr" },
  { path: "mods?q=" },
  { path: "versions/<slug>/keys?namespace=&pr=&versions=" },
];

const LOCAL: readonly string[] = [
  "local://",
  "└─ <path>                     # 会话 workspace，可读写",
  "",
  "skill://<name>                # 已加载技能，用 read 读",
  "help://<topic>                # 工具与资源细节，主题列表见 help://",
];

function childNames(entries: readonly ResourceEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.path.split(/[/?]/, 1)[0];
    if (name) names.add(name);
  }
  return [...names];
}

export const PR_CHILDREN = childNames(PR);
export const GH_CHILDREN = childNames(GH);

function lines(entries: readonly ResourceEntry[]): string[] {
  return entries.map((entry, index) => {
    const glyph = index === entries.length - 1 ? "└─" : "├─";
    return `${glyph} ${entry.path}${entry.comment === undefined ? "" : `  # ${entry.comment}`}`;
  });
}

/** 系统提示里的资源树；子资源名同时供分发器使用，三者不再各自手写。 */
export function resourceTree(): string {
  return [
    "```",
    "repo://",
    ...lines(REPO),
    "",
    "pr://<n>",
    ...lines(PR),
    "",
    "gh://",
    ...lines(GH),
    "",
    ...LOCAL,
    "```",
    "",
    "行范围写在路径末尾：`:N` 或 `:N-M`；文件名本身以 `:数字` 结尾时用 `%3A` 转义。",
  ].join("\n");
}
