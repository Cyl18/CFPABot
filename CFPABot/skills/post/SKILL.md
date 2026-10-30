---
name: post
description: PR 校对与交付：打包、派单、合并、裁决、写草稿。审查 PR 时在 prep 之后读。
---

# 译后

按约定产出 `local://draft.json` 与 `pr://<n>/draft`；发布由人决定。

## 流程

1. **读译前产物**：`local://STYLE.md`、`local://format.md`，没有就跳过。术语只用 `read pr://<n>/terms?candidates=1` 的冻结表；没有表就回 `skill://prep` 第 3–4 步先裁。文件级结论（`key_parity`、`bad_path`、JSON 语法）直接采信 `checks`，不要到仓库源码或 CONTRIBUTING 里找规则出处。
2. **打包**：`write pr://<n>/pack {}`。不论行数多少都打包派单——行只用来对账，判译文只发生在子代理。返回 manifest：`dir`、`slices[]`（id、doc、kind、workspace、path、rows、首尾 key）、`fileFindings`、`duplicates`、`fileChecks`、`excluded`、`terms`。冻结表会自动写进每个语言包的片头；手册类 PR 的片 `kind=manual`，一对一片。
3. **派单**：每片一个 `review` 子代理，`resources` 只给那片的文档；跨片裁定写 `local://<manifest.dir>/shared.md` 一起递。命令形状见「流水线」。
4. **合并**：按 `(path, key)` 去重取高档；跨片同 pattern 归到首现片，其余 key 进 `covers`；同一 key 两片结论冲突时你裁决，依据写进 `body`。
5. **回收术语提案**：`termProposals` 每条都裁——`missing` 查 glossary 后补进表，`dispute` 复核后改锁或驳回（驳回理由写进 `body` 或 summary）。改完 `write pr://<n>/terms {terms:[…]}` 覆盖，再重打 pack；不改表不用重打。
6. **裁决 uncertain**：PR 内同词多译看 `read pr://<n>/terms?changed=1`；冻结表查不到、又必须定的体例问题才查 glossary（规则见 `skill://prep` 第 3 步）。能定的补成 comment 或删掉，零命中或定不了的写进 `summary` 存疑段并标 `suspected`。
7. **写草稿**：`read pr://<n>/draft` 拿当前 schema；`write pr://<n>/draft <JSON>` 保存并校验，`errors` 按字段改到 `ok: true`，不需要另跑校验脚本。
   - 手册评论锚点二选一：给 `path`+`line`（文件行级），或标 `fileLevel:true`（文件级，进正文不进 inline，不给 line/key/suggestion）；语言包评论给 `key`，`line` 可省。
   - 内容确与已审片相同的片，写 `skipped:[{slice,reason:"identical",identicalTo}]`；别拿 summary 文字糊弄覆盖率。
8. **可选覆盖**：本轮确认的风格、格式写回 `STYLE.md`、`format.md`；`terms.tsv` 只在译中要复用时从表里导出。

`summary` 写文件级问题（路径、键集、JSON 语法、重复译文簇）与存疑项，不重复 inline 内容。

### 分歧线索（可选）

只查「同一英文在本模组里有几种译法」时跑；先圈范围，没有范围不跑。产出 `*-divergence.md` 只报事实：同一英文的多种译法（精确）、同一骨架下变动词的多译（候选，需核对切分）。两类都只是线索：定译由你写进 `pr://<n>/terms`，`shared.md` 里只放结论；表里漏的词靠 `termProposals` 补。

```python
import json, subprocess, sys
root = json.load(open("cfpa.json"))["root"]
run = lambda *a: subprocess.run([sys.executable, *a], check=True)
run(f"{root}/skills/prep/scripts/scope.py", "./work", "./scope", "--prefix", "item.", "--pattern", "^block\\.")
run(f"{root}/skills/prep/scripts/termgen/final.py", "mod", "review", "./scope", "-o", "./review/<slug>")
```

## 写评论

字段与校验由 `read pr://<n>/draft` 的 schema 给，这里只写 schema 说不出来的。

- **`body` 写原因，`suggestion` 给整行。** 语言包评论给 `zhNew`（只写新译文本身）；手册类给 `suggestion`（整行替换，缩进与文件一致）。`covers` 不替代两者：有 `covers` 也给当前行的新译文，本条 key 不进 `covers`。
- **`body` 写成有序列表**：一个条目一个问题，单条也写 `1.`，不用「；」把问题串成一句。
- **`summary`**：译者最先看到的区域，保持精炼、有效，态度友好、鼓励。

好：

```text
1. `exampleA` 是：示例译文A（原文中的难译点）。译文 `原始译文A` 把主从关系弄反
2. `exampleB` 是：示例译文B。译文 `原始译文B` 换成了另一个意思，机制提示丢失。
```

坏：body 只写 `不太自然`，或 suggestion 只给改动的词、不给整行。

`verdict`：有必改项用 `changes`，整体方向错才 `reject`，没有必改项才 `approve`。`write pr://<n>/review` 会先重验 `headSha` 和行号；草稿过期会被打回重审，且只在人明确要求时写。

## 裁定

1. **一致性不是正确性。** 全库统一只证明没有分裂，不证明译对。
2. **上游英文可能自己就错。** 错在原文，用 `source/defect` + neutral。
3. **亚文化梗放行。** 看不懂就不判。
4. **没依据不判 major。** 机制、数值、显示名需要可核来源；拿不准标 `suspected`。
5. **同一 pattern 只报一条。** 首现 key 给 suggestion，其余进 `covers`，body 写 pattern。
6. **档位按后果定，不按词表默认。** 玩家会做错选择、崩溃、反义 → critical；错义、漏译、关键术语 → major；读得通但别扭 → minor；拿不准 → neutral 或 suspected。
7. **文件级问题写 `summary`。** 路径、键集、JSON 语法都写进 `summary`；路径问题引用 `checks` 里的 `/mv` 提示。
8. **只为本 PR 引入或本 PR 必须补齐的问题改 verdict。** base 就存在、不是本 PR 引入的文件级差异（缺 key、上游笔误、既有格式问题）写进 `summary` 并注明「base 既有」，verdict 照旧。

## MQM

`mqm` 取全形 `<dim>/<type>`，完整词表在 `read pr://<n>/draft` 回包的 `mqm` 字段里，写评论前先读它。

机械线索确认后按项归类：占位符→`locale/placeholder`；格式码、换行、制表符→`locale/format-code`；标签→`design/markup`；半角标点→`locale/fullwidth`；空格→`fluency/spacing`；术语→`terminology/resource`（译名争议用 `wrong-term`）；未译→`accuracy/untranslated`；空值、原文已变→`accuracy/omission`；字幕冒号、功能键大小写→`style/house-style`。

## 子代理

`review` 没有任何工具（glossary 也不给），只看 `resources` 递过去的那一片。片文档由 `write pr://<n>/pack` 生成：原文、译文、`raw`、机械发现、冻结术语表、原版术语命中、旧线程、重复译文；MQM 表与结论契约在 `.omp/agents/review.md`。

术语分歧由你统一裁决：子代理只提 `termProposals`，不改表、不写术语评论。

`read pr://<n>` 的 `localRoot` 是 head 文件的物化目录，只读；要跑脚本先复制到 `local://work/`，脚本吃 `./work`。仓库工作树只用于查 key 是否存在、路径与既有译文；给词定译走 `pr://<n>/terms` 与 glossary。
