import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { jsonResult } from "../result.ts";
import type { HelpUri } from "./uri.ts";

const TOPICS: Record<string, string> = {
  "": `# help://

按需读取：
- help://tools/read
- help://tools/write
- help://tools/edit
- help://tools/eval
- help://tools/glossary
- help://tools/web_search
- help://tools/fetch_content
- help://resources/repo
- help://resources/local`,
  "tools/read": `# read

读取 repo:// 或 local://；行范围写在路径末尾。

- repo://pr/<n>/files/<path>:1-80
- repo://pr/<n>/review/rows?filter=changed&limit=100
- local://<短名>

local:// 不写路径分隔符。空 local:// 列出文件。`,
  "tools/write": `# write

writeScope=off 时只允许 local://；on 时允许写 repo://pr/<n>/...。
可写：comments、files/<path>/comments?line=、threads/<id>、threads/<id>/replies、review、review/submit、local://。
写 GitHub 前先读对应资源；发布审查时 headSha 会重新校验。`,
  "tools/edit": `# edit

替换 repo:// 中机器人自己的评论正文，或 local:// 文件文本。
参数：path、old_string、new_string、replace_all?。`,
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

顶层：meta、pulls、issues、search、files、mods、versions、pr。
PR：pr/<n>、files、discussion、threads、checks、workspaces、compare、special、meta、review。
行范围：:N 或 :N-M；PR 文件可用 ?side=head|base。`,
  "resources/local": `# local://

会话私有文本，短名 1-64 位字母/数字/点/下划线/连字符。
面板约定 local://draft.json 是审查草稿；其它名字只是普通文本。
local:// 写入不经过 writeScope，也不会发到 GitHub。`,
};

export function readHelp(uri: HelpUri): AgentToolResult<Record<string, unknown>> {
  const topic = uri.path.replace(/^\/+|\/+$/g, "");
  const content = TOPICS[topic];
  if (content === undefined) {
    return jsonResult({ topic, content: TOPICS[""], missing: true });
  }
  return jsonResult({ topic, content });
}
