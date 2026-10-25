---
name: post
description: PR 校对与交付：取行、三遍法、MQM、草稿。审查 PR 前先读。
---

# 译后

PR 校对。产出 `local://draft.json`；术语表、风格指南、格式要求可选更新，直接覆盖。

## 流程

1. **读译前产物**：`local://terms.tsv`、`local://STYLE.md`、`local://format.md`。没有就跳过。`terms.tsv` 只取 changed 行里出现的词，不整表读。
2. **取全量行**：`read pr://<n>?review=1`。一次拿到 `pr.headSha`、`checks`、`workspaces`、讨论；行在预算内一次给全（`complete=true`），超预算只给 `plan`，从 `next` 开始逐片读完（`next` 为 null 才停）。不要用 offset 翻页。
   - 每行已有 `path`、`line`（head 行号）、`en`、`zh`、`baseEn`、`baseZh`、`inHunk`、`findings`、`terms`、旧 `threads`、`duplicate`。只审 `changed` 且 `inHunk` 的行。
   - `counts.workspaces === 0` 先看 `prep` 的路径闸门。
3. **全量校对**：每一条都读原文和译文，不抽样；派子代理也按 key 分片全量。
   - **三遍**（一次推理里的顺序，不是三轮对话）：盲读译文（别扭、歧义、语气）→ 对照原文（先写清谁对谁做什么，再查指称、否定、量化、比较、专名）→ 回填（放回相邻 key 拼读，看主语、量词、标点、长度）。
   - **机械项由预审定位，由你确认**：逐条回到原文和译文核对，成立才写评论，档位按后果定（finding 的档位是起点），误报不写。
   - **术语**：先看 `read pr://<n>/terms?changed=1`（同词多译、术语缺失、glossary 权威译法）；单行证据看 rows 的 `terms`。仍要额外核对时再用 `mcp__glossary_query`，多个词用 `mcp__glossary_query_batch`（每批 ≤20）。本模组内部的分歧用下面的 `mod review` 看。没依据不判 major。
4. **写草稿**：`read pr://<n>/draft` 拿 schema 与当前状态；`write pr://<n>/draft <JSON>` 保存并校验。`errors` 会直接返回，按字段改到 `ok: true`；不需要再跑 bash 校验脚本。
5. **可选覆盖**：本轮确认的术语、风格、格式写回三份文件，直接覆盖。

### 分歧线索（可选）

只查「同一英文在本模组里有几种译法」时跑；先圈范围，没有范围不跑。

```bash
python3 "$CFPA_ROOT/skills/prep/scripts/scope.py" ./work ./scope --prefix "item." --pattern '^block\.'
python3 "$CFPA_ROOT/skills/prep/scripts/termgen/final.py" mod review ./scope -o ./review/<slug>
```

`*-divergence.md` 只报事实：同一英文的多种译法（精确），同一骨架下变动词的多种译法（候选，需核对切分）。当 `terminology/*`、`style/inconsistent` 的线索，判不判仍按三遍法。镜像里 `python3`，Windows 上 `python`。

## 草稿

`{prNumber, headSha, verdict, summary, comments[]}`。`headSha` 可省，服务端按当前 head 补；结论默认 `COMMENT`，发布时用 `write pr://<n>/review?event=APPROVE|REQUEST_CHANGES` 覆盖。

每条评论：`path`、`line`（head 行号，必须在 diff hunk 新侧）、`key`、`severity`、`mqm`、`body`，`en`/`zh` 填该行原文与译文。`id` 可省。

- **`suggestion` 是整行替换**：带缩进、引号、逗号和转义，跟文件里那一行完全一致。非 `suspected` 且没有 `covers` 时必须给。
- **`covers` 与 `suggestion` 互斥**：有 `covers` 就不给 `suggestion`；`covers` 只放同一模式的其余 key，本条不放。
- **`suspected` 是布尔字段**，显式写 `"suspected": true` 才生效；此时档位最高 minor。
- **同 `path` + 同 `key` 只能出一条**：该 key 的其它实例进 `covers`，重复会被校验打回。
- `id` 由服务端按顺序补 `c1…cN`，不用自己写。

`body` 写成有序列表：一个条目一个问题，单条也写 `1.`，多条 `1.` `2.` `3.`，不用「；」把问题串成一句。

`body` 写原因，`suggestion` 给整行。

好：

```text
1. `exampleA` 是：示例译文A（原文中的难译点）。译文 `原始译文A` 把主从关系弄反
2. `exampleB` 是：示例译文B。译文 `原始译文B` 换成了另一个意思，机制提示丢失。
```

坏：body 只写 `不太自然` ，或 suggestion 只给改动的词、不给整行。

`summary`、`body` 只写正文：统计、档位标题、分类、免责脚注都由服务端拼。

`summary` 是译者最先看到的区域，保持信息精炼、有效，态度友好、鼓励。

`verdict`：有必改项用 `changes`，整体方向错才 `reject`，没有必改项才 `approve`。`write pr://<n>/review` 会先重验 `headSha` 和行号；草稿过期会被打回重审。

`write pr://<n>/review` 会把保存的草稿直接发成 GitHub 审查（需 `writeScope=on`）；只在人明确要求时写。

## 裁定

1. **一致性不是正确性。** 全库统一只证明没有分裂，不证明译对。
2. **上游英文可能自己就错。** 错在原文，用 `source/defect` + neutral。
3. **亚文化梗放行。** 看不懂就不判。
4. **没依据不判 major。** 机制、数值、显示名需要可核来源；拿不准标 `suspected`。
5. **同一 pattern 只报一条。** 首现 key 给 suggestion，其余进 `covers`，body 写 pattern。
6. **档位按后果定，不按词表默认。** 玩家会做错选择、崩溃、反义 → critical；错义、漏译、关键术语 → major；读得通但别扭 → minor；拿不准 → neutral 或 suspected。
7. **文件级问题写 `summary`。** 路径、键集、JSON 语法都写进 `summary`；路径问题引用 `checks` 里的 `/mv` 提示。

## MQM

取 `<dim>/<type>`：

- `accuracy` 准确：`mistranslation` 错译、`omission` 漏译、`addition` 擅加、`untranslated` 应译未译、`overly-literal` 死译、`wrong-entry` 串条、`reversed` 反义
- `terminology` 术语：`wrong-term` 错术语、`inconsistent` 术语不一致、`inappropriate` 术语误用、`resource` 违反术语资源
- `fluency` 流畅：`punctuation` 标点、`spacing` 空格、`grammar` 语法、`word-order` 语序、`typo` 错字、`encoding` 字符编码
- `style` 风格：`awkward` 生硬、`inconsistent` 体例不一、`house-style` 违反项目体例、`register` 语域漂移
- `locale` 本地化格式：`placeholder` 占位符、`format-code` 格式码、`units` 单位、`number` 数字日期、`fullwidth` 全半角
- `design` 呈现：`overflow` 截断溢出、`glyph` 缺字形、`markup` 标记破坏
- `source` 原文：`defect` 原文有误

机械线索确认后按项归类：占位符→`locale/placeholder`；格式码、换行、制表符→`locale/format-code`；标签→`design/markup`；半角标点→`locale/fullwidth`；空格→`fluency/spacing`；术语→`terminology/resource`（译名争议用 `wrong-term`）；未译→`accuracy/untranslated`；空值、原文已变→`accuracy/omission`；字幕冒号、功能键大小写→`style/house-style`。

## 子代理

派子代理时把校对方法和 MQM 贴进 task；它只返回稀疏 JSON（只写判错的 key），你合并并确认。

分片优先把 rows URI 放进 `resources`：`delegate({ agent: "review", model: "@模型名", task, resources: ["pr://<n>/rows?filter=reviewable&workspace=<ws>&prefix=<prefix>"] })`。预算内子代理直接拿到全集；超预算时任务里说明跟着返回的 `next` 逐片读完（`slices` 只列开头 8 片）。子代理与主代理共用 `pr://` 数据面、`terms` 和 skills，不需要你先把分片写成文件。

`read pr://<n>` 的 `localRoot` 是 head 文件的物化目录，只读；要跑脚本先复制到 `local://work/`，脚本吃 `./work`。仓库工作树用 `$CFPA_REPO`（`grep`/`find` 可给绝对路径，`bash` 里用环境变量）。
