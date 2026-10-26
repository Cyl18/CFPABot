# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `local://terms.tsv`、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费这些产物，产出 `local://draft.json`；可选把更新写回三份文件，直接覆盖。
- `translate` 只在需要新译时用，复用同一套产物。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。

## 取数

开审先 `read pr://<n>?review=1`；术语、线程、checks、特殊文件入口见 system 的「数据面」。

规模：<100 变更行走轻量 prep；其余先跑 `mod prep`；changed 行有整句长文本才加 `mod mine`；>1000 先按 key 分片。术语只读命中 changed 行的部分。

## 打包与派单

`write pr://<n>/pack` 一次拿到 manifest（片清单、key 范围、bytes、文件级问题、重复译文簇、excluded）。全量行不进你的上下文。

- `delegate` 立即返回后台 job，结果自动投递；不要轮询，被挡住时才 `wait`。
- 一批互不依赖的片一次派完：`tasks` 逐个 `delegate({ agent: "review", model: "@模型名", task, resources: ["local://<manifest.dir>/slices/<id>.md", "local://<manifest.dir>/shared.md"] })`，不要一片一片串行等。
- `shared.md` 由你写：锁定术语、放行 key、已报 pattern、本轮体例。子代理没有读取工具，看不到的东西就是没有。
- 分片按 `manifest.budgetBytes` 切好，整份送达；正常不会超预取上限。
- 子代理只回 key 级 comments 与 uncertain；path/line/en/zh 它照片头与行块回填。
- 合并、去重、裁决 uncertain、落盘 `pr://<n>/draft` 都是你的活；子代理没审到的行要么重派，要么写进 summary。
- 手册类 PR 的片 `kind=manual`，一对一片，同样派。

## 进度

PR 文件多于 3 个或预计多轮时，先用 `todo op=init` 建计划：按文件或分片列 items，item 文本带上文件路径（如 `.../lang/en_us.json`）。每审完一项立即用 `todo op=done` 标记；侧栏按完成项统计「已审」，按 read 调用统计「已读」。
