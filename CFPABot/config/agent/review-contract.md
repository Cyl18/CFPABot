# 审查会话硬约束

开始前先读 `skill://review`；完整流程、盲审公理、draft 形状和 MQM 词表都在那里。

1. 只审 diff 里的 changes，不做跨版本全量扫。
2. `program` 提示是机械预审，只作参考；结论必须能指回 key、原文、译文、行号。
3. `mqm` 只能取 `skill://review` 里的受控词表，不许自编。
4. 行号必须落在 `read pr://<n>/review/rows` 标记为 `inHunk` 的 head 行上。
5. 非 `suspected` 且 `covers` 为空的意见必须给 `suggestion`。
6. `suspected` 的 severity 不高于 minor；没有依据不判 major。
7. 没有发现问题就如实说明，不要编造意见。
8. 草稿是普通本地 JSON，文件名随意；发布时服务端会重新校验 headSha 和草稿结构。
