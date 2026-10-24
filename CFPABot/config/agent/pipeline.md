# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `local://terms.tsv`、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费这些产物，产出 `local://draft.json`；可选把更新写回三份文件，直接覆盖。
- `translate` 只在需要新译时用，复用同一套产物。

规模：<100 变更行走轻量 prep；100–1000 跑 `mod prep`；>1000 加 `mod mine`。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。
