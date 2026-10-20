import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { jsonResult } from "../result.ts";
import type { HelpUri } from "./uri.ts";

const TOPICS: Record<string, string> = {
  "": `# help://

按需读取：
- help://tools/read
- help://tools/write
- help://tools/edit
- help://tools/grep
- help://tools/find
- help://tools/ls
- help://tools/bash
- help://tools/todo
- help://tools/eval
- help://tools/glossary
- help://tools/web_search
- help://tools/fetch_content
- help://resources/repo
- help://resources/pr
- help://resources/gh
- help://resources/local`,
  "tools/read": `# read

读取 repo://、pr://、gh://、local:// 或 help://；行范围写在路径末尾。

- repo://<path>:1-80
- repo://<path>?ref=<sha>
- pr://<n>/files/<path>:1-80?side=head
- pr://<n>/review/rows?filter=changed&limit=100
- gh://pulls?state=open
- local://<path>

空 repo:// 列出仓库根目录，空 local:// 列出 workspace 文件。`,
  "tools/write": `# write

writeScope=off 时只允许 local://；on 时允许写 pr://<n>/...。
可写目标由服务端的 write target 表决定，报错信息会列出全部可写 URI。
写 GitHub 前先读对应资源；发布审查时 headSha 会重新校验。`,
  "tools/edit": `# edit

替换 pr:// 中机器人自己的评论正文，或 local:// 文件文本。
参数：path、old_string、new_string、replace_all?。`,
  "tools/grep": `# grep

按正则搜索文件内容。path 可写 local://、repo:// 或 pr://<n>；省略时搜会话 workspace。
参数：pattern、path?、glob?、ignoreCase?、literal?、context?、limit?。`,
  "tools/find": `# find

按 glob 找文件（相当于 glob）。path 可写资源 URI，省略时搜会话 workspace。
参数：pattern、path?、limit?。`,
  "tools/ls": `# ls

列出目录内容。path 可写资源 URI，省略时列会话 workspace。
参数：path?、limit?。`,
  "tools/bash": `# bash

在会话 workspace（local://）执行 shell。需要管理员开启执行权限（evalScope=run）。
子进程只拿到白名单环境变量；repo:// 与 pr:// 不能直接写，需要处理时先复制到 local://。`,
  "tools/todo": `# todo

一次写入完整任务清单（快照语义）：tasks 是权威列表，省略的 key 会被删除。
每项：key（1-40 位小写字母数字）、subject、status（pending/in_progress/completed）。
同一时刻只允许一个 in_progress；baseVersion 用于防止并发覆盖。
多步工作开始时先 init 一份计划，完成后把状态改成 completed。`,
  "tools/eval": `# eval

在一次性 Docker 沙箱执行 py/js/bash；需要 evalScope=run。
参数：language、code、stdin?、inputs?、outputs?、timeout?。
- stdin 可传文本或以 local:// 读文件
- inputs 是 local:// 文件，挂到 /workspace/in
- outputs 是 /workspace/out 下要保存回 local:// 的文件名
完整 stdout/stderr 始终保存为 local://eval-<时间>.log。`,
  "tools/glossary": `# glossary

查询原版术语表与外部词典：query、limit?（默认 10，最大 50）。`,
  "tools/web_search": `# web_search

联网搜索；由 pi-web-access 提供。返回结果后用 source_check 核对来源，
需要正文时用 fetch_content。配置在 runtime/pi-agent/web-search.json。`,
  "tools/fetch_content": `# fetch_content

抓取网页、PDF 或 GitHub 仓库内容；由 pi-web-access 提供。
先用 web_search 找 URL，再抓正文。`,
  "resources/repo": `# repo://

仓库文件树，只读，默认读 origin 默认分支。空路径列出根目录，目录路径列出直接子项。
行范围：:N 或 :N-M；文件名以 :数字 结尾时用 %3A 转义。
?ref=<sha> 从 git 对象读指定版本。`,
  "resources/pr": `# pr://

pr://<n>/ 下的资源：files、files/<path>、discussion、threads、checks、workspaces、compare、special、meta、review、review/rows。
files 支持 ?side=head|base；rows 支持 ?workspace=&filter=changed|flagged|all&query=&offset=&limit=&rebuild=1。`,
  "resources/gh": `# gh://

仓库级元数据：meta、pulls?state=、issues/<n>、issues/<n>/comments、search?q=&type=、mods?q=、versions/<slug>/keys。`,
  "resources/local": `# local://

会话 workspace，可读写，支持子目录；禁止 .. 与绝对路径。
面板约定 local://draft.json 是审查草稿；其它名字只是普通文本。
local:// 写入不经过 writeScope，也不会发到 GitHub；发布时才校验草稿结构。`,
};

export function readHelp(uri: HelpUri): AgentToolResult<Record<string, unknown>> {
  const topic = uri.path.replace(/^\/+|\/+$/g, "");
  const content = TOPICS[topic];
  if (content === undefined) {
    return jsonResult({ topic, content: TOPICS[""], missing: true });
  }
  return jsonResult({ topic, content });
}
