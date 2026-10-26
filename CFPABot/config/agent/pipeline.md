# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `local://terms.tsv`、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费这些产物，产出 `local://draft.json`；可选把更新写回三份文件，直接覆盖。
- `translate` 只在需要新译时用，复用同一套产物。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。

## 取数

开审先 `read pr://<n>?review=1`；术语、线程、checks、特殊文件入口见 system 的「数据面」。

规模：<100 变更行走轻量 prep；其余先跑 `mod prep`；changed 行有整句长文本才加 `mod mine`；>1000 先按 key 分片。术语只读命中 changed 行的部分。

取证（既有译法、中英对照、换行体例）用一个 `eval` 细胞跑完：并行 `read` 多个来源，在细胞里筛，只打印命中行。一条 `bash` 只问一个问题的串行取数，会把十几次往返花在同一件事上。长脚本先写成文件再跑，不走 heredoc（中文、引号、`$` 会被 shell 吃掉）；镜像里 `python3`，Windows 上 `python`。

## 打包与派单

`write pr://<n>/pack {}` 一次拿到 manifest；字段与手册片的差异见 `skill://post` 第 2 步。全量行不进你的上下文。

- `delegate` 立即返回后台 job，结果自动投递；不要轮询，被挡住时才 `wait`。`wait` 会被用户插话打断，先处理用户消息。
- 一批互不依赖的片一次派完：

  ```js
  delegate({ agent: "review", model: "@模型名", task: "片 id + 该片特有的提示", resources: ["local://<manifest.dir>/slices/<id>.md", "local://<manifest.dir>/shared.md"] })
  ```

  `model` 可省；`resources` 整份进子代理上下文。
- `shared.md` 由你写：锁定术语、放行 key、已报 pattern、本轮体例。子代理没有读取工具，看不到的东西就是没有。
- 子代理停止且无产出时不要原样重派：按 `###` 或 key 边界拆成两片再派；第二次仍停就写进 `summary`。
- 手册类 PR 的片 `kind=manual`，一对一片，同样派。
- 子代理只回 key 级 conclusions；合并、去重、裁决 `uncertain`、落盘 `pr://<n>/draft` 都是你的活。没审到的行要么重派，要么写进 summary。

## 进度

PR 文件多于 3 个或预计多轮时，先用 `todo op=init` 建计划：按文件或分片列 items，item 文本带上文件路径（如 `.../lang/en_us.json`）。每审完一项立即用 `todo op=done` 标记；侧栏的「计划」按这份快照显示完成进度。
