# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `local://terms.tsv`、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费这些产物，产出 `local://draft.json`；可选把更新写回三份文件，直接覆盖。
- `translate` 只在需要新译时用，复用同一套产物。

规模：<100 变更行走轻量 prep；其余先跑 `mod prep`；changed 行有整句长文本才加 `mod mine`；>1000 先按 key 分片。术语只读命中 changed 行的部分。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。
