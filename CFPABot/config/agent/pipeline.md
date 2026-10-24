# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `local://terms.tsv`、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费这些产物，产出 `local://draft.json`；可选把更新写回三份文件，直接覆盖。
- `translate` 只在需要新译时用，复用同一套产物。

规模：<100 变更行走轻量 prep；其余先跑 `mod prep`；changed 行有整句长文本才加 `mod mine`；>1000 先按 key 分片。术语只读命中 changed 行的部分。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。

## 派子代理

任务量自己判断：一轮读不完、能按 key 前缀或文件切开、切开后各片互不共享裁定时，拆到两片以上就必须按片派 `delegate({ agent: "review", model: "@模型名", task })`。

- 只有一片就自己审，别为一片派单——派单的成本是两次交接。
- 每片写清：片内文件的绝对路径、key 前缀、要判什么、返回什么。子代理只读，只回 findings，不重读全量。
- 合并、复核、落盘 `draft.json` 都是你的活；子代理没审到的片没人替你兜底。

## 进度

PR 文件多于 3 个或预计多轮时，先用 `todo op=init` 建计划：按文件或分片列 items，item 文本带上文件路径（如 `.../lang/en_us.json`）。每审完一项立即用 `todo op=done` 标记；侧栏按完成项统计「已审」，按 read 调用统计「已读」。
