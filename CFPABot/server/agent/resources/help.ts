import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { jsonResult } from "../result.ts";
import type { ResourceParts } from "./uri.ts";

const TOPICS: Record<string, string> = {
  "": `# help://

按需读取：
- help://tools/bash
- help://tools/write
- help://tools/edit
- help://tools/grep
- help://tools/todo
- help://tools/eval
- help://tools/delegate
- help://tools/web_search
- help://resources/repo
- help://resources/pr
- help://resources/gh
- help://resources/local
- help://resources/skill`,
  "tools/bash": `# bash

在会话 workspace（local://）执行 shell。默认开启（evalScope=run），管理员可在会话上关闭。
子进程只拿到白名单环境变量；repo:// 与 pr:// 不能直接写，需要处理时先复制到 local://。`,
  "tools/write": `# write

可写 local://（始终可用）与 pr://（writeScope=on）。写 GitHub 时按 URI 决定语义，见 help://resources/pr。
同一工具调用重复执行会按隐藏标记去重，返回 deduped: true。`,
  "tools/edit": `# edit

只用于 local:// 文本。GitHub 评论改写用 write pr://<n>/comments/<id> 整段覆盖。
写权限同样受 writeScope 约束。`,
  "tools/grep": `# grep

内置 grep，按正则搜索文件系统路径。path 省略时搜会话 workspace。
pr:// 与 repo:// 不是文件系统：先用 read pr://<n>/meta 取 localRoot，或直接搜 runtime/work/repo。`,
  "tools/todo": `# todo

一次写入完整任务清单（快照语义）：tasks 是权威列表，省略的 key 会被删除。
每项：key（1-40 位小写字母数字）、subject、status（pending/in_progress/completed）。
同一时刻只允许一个 in_progress；baseVersion 用于防止并发覆盖。
多步工作开始时先 init 一份计划，完成后把状态改成 completed。`,
  "tools/eval": `# eval

在宿主持久 kernel 执行 Python / JavaScript。默认开启（evalScope=run），管理员可在会话上关闭。
一次调用一个 cell，变量在同一语言内保留；reset 重建 kernel。
参数：language（py|js）、code、timeout?、reset?。
kernel 直接读写会话 workspace 与仓库文件；不要用 bash 再套 python -c。`,
  "tools/delegate": `# delegate

按 LLM 配置里的模型别名（roles）启动只读子代理，返回它的最终文本。
参数：model（别名，可带 @）、task（交给子代理的任务）。
子代理有 read/grep/find/glob/bash 与 MCP 工具；批量处理时把 pr://<n>/meta 的 localRoot 给它走文件系统。`,
  "tools/web_search": `# web_search

联网搜索；由 omp 内置工具提供。返回结果后核对来源。`,
  "resources/repo": `# repo://

仓库文件树，只读，默认读 origin 默认分支。空路径列出根目录，目录路径列出直接子项。
行范围：:N 或 :N-M；文件名以 :数字 结尾时用 %3A 转义。
?ref=<sha> 从 git 对象读指定版本。`,
  "resources/pr": `# pr://

pr://<n>/ 下的资源：files、files/<path>、comments、threads、checks、workspaces、compare、special-files、meta、review、review/rows。
files 支持 ?side=head|base；rows 支持 ?workspace=&filter=changed|flagged|all&query=&offset=&limit=&rebuild=1。`,
  "resources/gh": `# gh://

仓库级元数据：meta、pulls?state=、issues/<n>、issues/<n>/comments、search?q=&type=、mods?q=、versions/<slug>/keys。`,
  "resources/local": `# local://

会话 workspace，可读写，支持子目录；禁止 .. 与绝对路径。
local:// 是普通文件区；审查草稿用任意 .json 文件名。
local:// 写入不经过 writeScope，也不会发到 GitHub；发布时才校验草稿结构。`,
  "resources/skill": `# skill://

按技能名读取已加载的技能文件：skill://review。
行范围：:N 或 :N-M；子路径相对于技能目录，禁止越界。
审查流程、裁定、draft 形状和 MQM 词表都在 skill://review。`,
};

export function readHelp(uri: ResourceParts): AgentToolResult<Record<string, unknown>> {
  const topic = uri.path.replace(/^\/+|\/+$/g, "");
  const content = TOPICS[topic];
  if (content === undefined) {
    return jsonResult({ topic, content: TOPICS[""], missing: true });
  }
  return jsonResult({ topic, content });
}
