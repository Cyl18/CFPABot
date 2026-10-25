# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `local://terms.tsv`、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费这些产物，产出 `local://draft.json`；可选把更新写回三份文件，直接覆盖。
- `translate` 只在需要新译时用，复用同一套产物。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。

## 取数

- 开审：`read pr://<n>?review=1&limit=120`。一次拿到 headSha、workspaces、checks、讨论、草稿状态和第一页行；行上有 findings、术语命中、旧线程、重复译文。
- 继续：照返回的 `rows.next` 读，不要自己拼 offset。
- 术语：`read pr://<n>/terms?changed=1`；要看某个词的权威译法用 `?term=`。
- 指南/手册：`read pr://<n>/special-files?include=text&limit=6`，照 `next` 继续。
- 草稿：`read pr://<n>/draft` 看 schema；`write pr://<n>/draft` 保存并校验；`write pr://<n>/review` 发布。

规模：<100 变更行走轻量 prep；其余先跑 `mod prep`；changed 行有整句长文本才加 `mod mine`；>1000 先按 key 分片。术语只读命中 changed 行的部分。

## 派子代理

任务量自己判断：一轮读不完、能按 key 前缀或文件切开、切开后各片互不共享裁定时，拆到两片以上就必须按片派 `delegate({ agent: "review", model: "@模型名", task, resources: [...] })`。

- 只有一片就自己审，别为一片派单——派单的成本是两次交接。
- 分片时把该片的 rows URI 放进 `resources`，例如 `pr://<n>/rows?filter=reviewable&workspace=<ws>&prefix=item.&limit=120`；子代理会直接带着数据开工。
- 每片写清：片内文件、key 前缀、要判什么、返回什么。子代理只读，只回 findings。
- 合并、复核、落盘 `pr://<n>/draft` 都是你的活；子代理没审到的片没人替你兜底。

## 进度

PR 文件多于 3 个或预计多轮时，先用 `todo op=init` 建计划：按文件或分片列 items，item 文本带上文件路径（如 `.../lang/en_us.json`）。每审完一项立即用 `todo op=done` 标记；侧栏按完成项统计「已审」，按 read 调用统计「已读」。
