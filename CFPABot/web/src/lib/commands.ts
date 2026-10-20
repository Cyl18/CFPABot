export interface CommandHelp {
  syntax: string;
  args: string;
  summary: string;
  detail?: string;
  permission: string;
  example: string;
}

export const COMMANDS: readonly CommandHelp[] = [
  {
    syntax: "/mv <fromDir> <toDir>",
    args: "两个目录路径，支持引号",
    summary: "移动目录及其全部子文件。",
    detail: "源目录必须位于仓库工作目录内，包含 `..` 的参数会被拒绝。",
    permission: "协作者或 PR 作者",
    example: "/mv projects/assets/mod/1.20/old projects/assets/mod/1.20/new",
  },
  {
    syntax: "/rename <from> <to>",
    args: "两个文件路径，支持引号",
    summary: "重命名单个文件，目标存在时覆盖。",
    permission: "协作者或 PR 作者",
    example: '/rename "projects/assets/mod/1.20/mod/lang/en_us.json" "projects/assets/mod/1.20/mod/lang/zh_cn.json"',
  },
  {
    syntax: "/update-en <slug|modrinth-slug> <game-version>",
    args: "模组 slug 与游戏版本目录",
    summary: "从 CurseForge 或 Modrinth 下载该版本的 en_us 语言文件并覆盖仓库文件。",
    detail: "`modrinth-` 前缀走 Modrinth，其余走 CurseForge；1.12.2 使用 `.lang` 格式，其它版本使用 `.json`。",
    permission: "协作者或 PR 作者",
    example: "/update-en jei 1.20.1",
  },
  {
    syntax: "/replace <a> <b>",
    args: "两个字符串，支持引号",
    summary: "在本次 PR 改动的 zh_cn 文件中把 a 替换为 b。",
    detail: "JSON 文件按 key 逐值替换并保留原有排版；其它文件整文件替换。",
    permission: "协作者或 PR 作者",
    example: '/replace "物品" "物品栏"',
  },
  {
    syntax: "/add-comment <key> <comment...>",
    args: "语言文件 key 与注释文本",
    summary: "在 zh_cn JSON 中该 key 后插入一行 `__comment.cpfa.{用户名}.{key}` 注释。",
    detail: "保持原有缩进与逗号，注释文本按 JSON 字符串转义。",
    permission: "协作者或 PR 作者",
    example: "/add-comment item.mod.name 这里指的是机器名称",
  },
  {
    syntax: "/add-co-author <login>",
    args: "GitHub 用户名",
    summary: "把指定用户加为共同作者（空提交 + Co-authored-by 尾注）。",
    permission: "协作者或 PR 作者",
    example: "/add-co-author Cyl18",
  },
  {
    syntax: "/revert [commit-hash]",
    args: "可选提交哈希",
    summary: "回退最近一次提交，或回退指定提交。",
    detail: "不传哈希时按浅克隆回退 HEAD；传哈希时会做一次完整克隆。",
    permission: "协作者或 PR 作者",
    example: "/revert",
  },
  {
    syntax: "/sort-keys <file>",
    args: "语言文件路径",
    summary: "按键名重新排序语言文件。",
    detail: "JSON 丢弃注释并重新缩进；`.lang` 丢弃注释与空行后按 key 排序。",
    permission: "协作者或 PR 作者",
    example: "/sort-keys projects/assets/mod/1.20/mod/lang/zh_cn.json",
  },
  {
    syntax: "/add-mapping <slug> <curseforge-project-id>",
    args: "模组 slug 与 CurseForge 项目 ID",
    summary: "写入 slug 到 CurseForge 项目的映射，并强制刷新信息评论。",
    detail: "写入后会立即用 CurseForge API 校验 ID 对应的 slug 是否一致。",
    permission: "协作者或 PR 作者",
    example: "/add-mapping jei 238222",
  },
  {
    syntax: "/agent [text]",
    args: "可选补充说明",
    summary: "在 PR 上启动 Agent 对话会话。",
    detail: "会话绑定当前 PR，可在面板的 Agent 页面继续对话。",
    permission: "协作者",
    example: "/agent 看看这个模组的术语",
  },
  {
    syntax: "/agent-review [text]",
    args: "可选补充说明",
    summary: "在 PR 上启动 Agent 审查，产出可发布的审查草稿。",
    detail: "草稿需要人工在面板确认后才会发布为 GitHub Review。",
    permission: "协作者",
    example: "/agent-review 重点关注物品名",
  },
];

export const COMMAND_NOTES: readonly string[] = [
  "命令必须是以 `/` 开头的独立整行，一条评论可以包含多条命令。",
  "带引号的参数会被视为一个整体，例如 `/rename \"a b\" \"c d\"`。",
  "只有仓库协作者，或 PR 作者本人（且分支来自作者自己的仓库）可以执行命令。",
  "来自仓库 main 分支的 PR 受保护，命令会被拒绝执行。",
  "所有改动会在一次提交中推送到 PR 分支，Bot 随后回复执行结果。",
];
