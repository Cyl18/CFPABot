# 流水线

PR 审查：`prep` → `post`。需要补译时在中间插 `translate`。

- `prep` 产出 `pr://<n>/terms`（冻结术语表）、`local://terms.tsv`（工作副本）、`STYLE.md`、`format.md`（可选）、`prep.json`。
- `post` 消费冻结表与风格产物，产出 `local://draft.json`。
- `translate` 只在需要新译时用，复用同一套产物。

每阶段开始时先 `read` 对应 skill：`skill://prep`、`skill://post`、`skill://translate`。

## 取数

开审先 `read pr://<n>?review=1`；术语、线程、checks、特殊文件入口见 system 的「审查入口」。

取证（既有译法、中英对照、换行体例）用一个 `eval` 细胞跑完：并行 `read` 多个来源，在细胞里筛，只打印命中行。一条 `bash` 只问一个问题的串行取数，会把十几次往返花在同一件事上。长脚本先写成文件再跑，不走 heredoc（中文、引号、`$` 会被 shell 吃掉）；镜像里 `python3`，Windows 上 `python`。
行区间用 `read local://…:N-M`（或 `repo://`、`pr://` 的同一语法），不要 `sed -n`/`awk`。译法只查 glossary（`read pr://<n>/terms?term=` 或 `mcp__glossary_query_batch`），不扫 `$CFPA_REPO`。机械项读 `pr://<n>/checks` 与 pack 的 `fileChecks`/`fileFindings`/`duplicates`，不要用 python 重算。

## 打包与派单

打包产物见 `skill://post` 第 2 步；全量行不进你的上下文。

- `headSha` 变了就重打 pack 并重派：旧片的结论不能带进新 head。
- `delegate` 立即返回后台 job；派完一批只调一次 `wait`，它等这批全部结束并一次返回全部结果（不会逐片插消息），不要逐片轮询。用户插话会打断等待，先处理用户消息。
- 一批结果超出工具输出上限会被折进 `artifact://<id>`，只留头尾：`read artifact://<id>` 读全文，别因为看不到中段就重派整片。
- 一批互不依赖的片一次派完：

  ```js
  delegate({ agent: "review", model: "@模型名", task: "片 id + 该片特有的提示", resources: ["local://<manifest.dir>/slices/<id>.md", "local://<manifest.dir>/shared.md"] })
  ```

  `model` 可省；`resources` 整份进子代理上下文。`task` 里不写行号：片文档每条已有 `line:`，子代理照抄；草稿评论也只给 key，服务端按 pack 定位。
- `shared.md` 由你写：放行 key、已报 pattern、本轮体例。定译已进片头术语表，不重复抄。子代理没有工具，看不到的东西就是没有。
- 子代理停止且无产出时不要原样重派：按 `###` 或 key 边界拆成两片再派；第二次仍停就写进 `summary`。
- 手册类 PR 的片 `kind=manual`，一对一片，同样派。

## 进度

PR 文件多于 3 个或预计多轮时，先用 `todo op=init` 建计划：按文件或分片列 items，item 文本带上文件路径（如 `.../lang/en_us.json`）。每审完一项立即用 `todo op=done` 标记；侧栏的「计划」按这份快照显示完成进度。
