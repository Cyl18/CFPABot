const REPO = [
  "repo://",
  "├─ <目录>/                    # 列出直接子项",
  "└─ <path>[:N-M]?ref=<sha>     # 文件内容；无 ref 时读 origin 默认分支",
];

const PR = [
  "pr://<n>",
  "├─ files                      # 变更文件与状态",
  "├─ files/<path>[:N-M]?side=head|base",
  "├─ comments                   # PR 评论与 review 评论",
  "├─ threads                    # review 线程状态",
  "├─ checks                     # 机械检查报告",
  "├─ workspaces",
  "├─ compare?slug=&version=&namespace=",
  "├─ special-files",
  "├─ special-files/content?key=",
  "├─ meta",
  "├─ review",
  "└─ review/rows?workspace=&filter=changed|flagged|all&query=&offset=&limit=&rebuild=1",
];

const GH = [
  "gh://",
  "├─ meta",
  "├─ pulls?state=open|closed|merged|all",
  "├─ issues/<n>",
  "├─ issues/<n>/comments",
  "├─ search?q=&type=issue|pr",
  "├─ mods?q=",
  "└─ versions/<slug>/keys?namespace=&pr=&versions=",
];

const LOCAL = ["local://", "└─ <path>                     # 会话 workspace，可读写"];

/** 系统提示里的资源树；与 resources/ 下的分发保持一致。 */
export function resourceTree(): string {
  return [
    "```",
    ...REPO,
    "",
    ...PR,
    "",
    ...GH,
    "",
    ...LOCAL,
    "```",
    "",
    "行范围写在路径末尾：`:N` 或 `:N-M`；文件名本身以 `:数字` 结尾时用 `%3A` 转义。",
  ].join("\n");
}
