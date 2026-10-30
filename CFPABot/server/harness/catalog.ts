export interface ResourceEntry {
  path: string;
  comment: string;
}

const REPO: readonly ResourceEntry[] = [
  { path: "<目录>/", comment: "列出直接子项" },
  { path: "<path>[:N-M]?ref=<sha>", comment: "文件内容；无 ref 时读 origin 默认分支" },
];

const PR: readonly ResourceEntry[] = [
  { path: "rows?slice=&filter=reviewable|changed|flagged|all&workspace=&prefix=&keys=&query=&include=", comment: "审查行：预算内一次给全集，超预算回 plan（只用来对账）" },
  { path: "terms?term=&changed=1&limit=&offset=", comment: "术语证据：同词多译、glossary 漏命中" },
  { path: "terms?candidates=1&limit=&ctx=", comment: "术语候选与双侧上下文；同一地址 write 冻结表" },
  { path: "draft?schema=0&notes=0", comment: "草稿 schema 与校验；同一地址 write 保存" },
  { path: "files", comment: "变更文件清单" },
  { path: "files/<path>[:N-M]?side=head|base&format=patch", comment: "单文件内容或 diff" },
  { path: "comments", comment: "PR 与 review 评论" },
  { path: "threads", comment: "review 线程状态" },
  { path: "checks", comment: "机械检查报告" },
  { path: "workspaces", comment: "语言包工作区与中英路径" },
  { path: "related", comment: "同模组关联 PR" },
  { path: "compare?slug=&version=&namespace=&review=1", comment: "按 key 对比 base/head" },
  { path: "special-files?include=text&keys=&offset=&limit=", comment: "指南/手册等成对内容" },
  { path: "special-files/<key>", comment: "单个特殊文件" },
  { path: "meta?fields=", comment: "兼容入口：简报" },
  { path: "review", comment: "兼容入口：pack 摘要" },
  { path: "review/rows", comment: "兼容入口：同 rows" },
];

const GH: readonly ResourceEntry[] = [
  { path: "meta", comment: "仓库 owner/name/defaultBranch" },
  { path: "pulls?state=open|closed|merged|all", comment: "PR 列表" },
  { path: "issues/<n>", comment: "issue 详情" },
  { path: "issues/<n>/comments", comment: "issue 评论" },
  { path: "search?q=&type=issue|pr", comment: "GitHub 搜索" },
  { path: "mods?q=", comment: "模组清单" },
  { path: "versions/<slug>/keys?namespace=&pr=&versions=", comment: "跨版本 key 对照" },
];

const LOCAL: readonly string[] = [
  "local://",
  "└─ <path>                     # 会话 workspace，可读写",
  "",
  "skill://<name>                # 已加载技能，用 read 读",
];

export const PR_ENTRY = "read pr://<n>?review=1";

const ROOT_COMMENT = "审查简报；?review=1 给全集或分片计划";

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
    `pr://<n>  # ${ROOT_COMMENT}`,
    ...lines(PR),
    "",
    "gh://",
    ...lines(GH),
    "",
    ...LOCAL,
    "```",
    "",
    "行范围写在整条 URI 末尾（`:N-M`、`:1-30,-30`、`:85:raw`），有查询时写在 `?` 之后（`files/x.json?side=head:85-125`）；文件名以 `:数字` 结尾时用 `%3A` 转义。",
  ].join("\n");
}

/** 资源不存在时给出可用子资源与入口，不把模型留在猜路径的循环里。 */
export function missingResource(uri: string, children: readonly string[]): never {
  throw new Error(`未知资源 ${uri}。可用：${children.join("、")}。入口：${PR_ENTRY}。`);
}
