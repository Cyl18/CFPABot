export interface ResourceEntry {
  path: string;
  comment: string;
}

const REPO: readonly ResourceEntry[] = [
  { path: "<目录>/", comment: "列出直接子项" },
  { path: "<path>[:N-M]?ref=<sha>", comment: "文件内容；无 ref 时读 origin 默认分支" },
];

const PR: readonly ResourceEntry[] = [
  { path: "rows?filter=reviewable|changed|flagged|all&workspace=&prefix=&keys=&query=&offset=&limit=&include=terms,threads,duplicates,patch&rebuild=1", comment: "审查行：原文/译文/行号/findings，默认带术语证据、旧线程、重复译文" },
  { path: "terms?term=&changed=1&limit=&offset=", comment: "术语证据：本 PR 同词多译 + glossary 权威译法；changed=1 只给可行动组" },
  { path: "draft", comment: "草稿 schema、当前草稿与校验；write 同一地址保存并校验，不通过不落盘" },
  { path: "files", comment: "变更文件清单，支持 ?offset=&limit=" },
  { path: "files/<path>[:N-M]?side=head|base&format=patch", comment: "单文件内容或该文件的 diff patch" },
  { path: "comments", comment: "PR 评论与 review 评论" },
  { path: "threads", comment: "review 线程状态（含 resolved/outdated）" },
  { path: "checks", comment: "机械检查报告；空 findings 不一定代表没跑，看 status" },
  { path: "workspaces", comment: "语言包工作区与 en/zh 路径" },
  { path: "related", comment: "同模组的关联 PR" },
  { path: "compare?slug=&version=&namespace=", comment: "按 key 对比 base/head 的中英值" },
  { path: "special-files?include=text&keys=&offset=&limit=", comment: "指南/手册等特殊文件；include=text 一次内联多对内容与 hunk" },
  { path: "special-files/<key>", comment: "单个特殊文件的成对内容" },
  { path: "meta?fields=", comment: "兼容入口：等价于不带 rows 的简报" },
  { path: "review", comment: "兼容入口：预审 pack 摘要" },
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

export const PR_ENTRY = "read pr://<n>?review=1&limit=120";

const ROOT_COMMENT = "审查简报：PR、文件、workspaces、checks、讨论、草稿；?review=1 附带第一页行与下一步";

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
    "行范围写在路径末尾：`:N` 或 `:N-M`；文件名本身以 `:数字` 结尾时用 `%3A` 转义。",
    `审查从 ${PR_ENTRY} 开始；一次读不到的再按返回的 next 继续。`,
  ].join("\n");
}

/** 资源不存在时给出可用子资源与入口，不把模型留在猜路径的循环里。 */
export function missingResource(uri: string, children: readonly string[]): never {
  throw new Error(`未知资源 ${uri}。可用：${children.join("、")}。入口：${PR_ENTRY}。`);
}
