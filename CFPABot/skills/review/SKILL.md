---
name: review
description: PR 翻译审查：取行、裁定、落草稿。审查 PR 前必须读。
---

# 审查

你审的是一个 Minecraft 模组翻译 PR。产出是草稿，发布由人决定。

## 流程

1. `read pr://<n>/review/rows?filter=changed` 取逐 key 行。`findings` 是程序预审，已经在查占位符、色码、换行、全半角、术语、键集和 JSON 语法，不用你再算一遍。
2. 审 `changed` 且 `inHunk` 的行。判不准时用 `?query=` 找同类，确认是模式还是单点。
3. `write local://draft.json`，再跑 `bash bun "$CFPA_ROOT/skills/review/scripts/check-draft.mjs" local://draft.json`，改到通过。
4. 发布时服务端重验 `headSha` 和行号，草稿过期会被打回重审。

草稿：`{prNumber, headSha, verdict, summary, comments[]}`。每条评论 `path/line/key/severity/mqm/body`，`en`/`zh` 填该行原文与译文；`suggestion` 是整行替换后的译文，`covers` 非空时不给；`suspected` 的档位不超过 minor。

`summary` 只写正文，首行统计和免责脚注由服务端生成。`body` 只写原因，标题里的档位与分类也由服务端拼。

`verdict`：有必改项用 `changes`，整体方向错才 `reject`，没有必改项才 `approve`。

## 裁定

这七条代码判不了，但决定结论。括号里是理由。

1. **一致性不是正确性。**（全库统一只证明没有分裂）不要拿「都这么译」当放行依据。
2. **上游英文可能自己就错。**（错在原文，不在译文）用 `source/defect` + neutral，不判 `accuracy/*`。
3. **亚文化梗放行。**（LLM 的系统性盲区）绵羊梗、乐队梗、字幕组梗，看不懂就不判。
4. **没依据不判 major。**（机制、数值、显示名需要可核来源）没有 glossary 或原版依据时标 `suspected`。
5. **同一 pattern 只报一条。**（逐条复读会淹掉结论）首现 key 用 path+line，其余进 `covers`，body 写 pattern。
6. **占位符只单向致命。**（zh 多占位会有值没处放）zh 需要多于 en 才 critical，zh 少占位是 neutral；`findings` 已经算过。
7. **档位按后果定，不按词表默认。**（同样错译，物品名和剧情台词后果不同）玩家会做错选择、崩溃、反义 → critical；错义、漏译、关键术语 → major；读得通但别扭 → minor；拿不准 → neutral 或 suspected。

## mqm

取 `<dim>/<type>`，只能用这些 id：

- `accuracy` 准确：`mistranslation` 错译、`omission` 漏译、`addition` 擅加、`untranslated` 应译未译、`overly-literal` 死译、`wrong-entry` 串条、`reversed` 反义
- `terminology` 术语：`wrong-term` 错术语、`inconsistent` 术语不一致、`inappropriate` 术语误用、`resource` 违反术语资源
- `fluency` 流畅：`punctuation` 标点、`spacing` 空格、`grammar` 语法、`word-order` 语序、`typo` 错字、`encoding` 字符编码
- `style` 风格：`awkward` 生硬、`inconsistent` 体例不一、`house-style` 违反项目体例、`register` 语域漂移
- `locale` 本地化格式：`placeholder` 占位符、`format-code` 格式码、`units` 单位、`number` 数字日期、`fullwidth` 全半角
- `design` 呈现：`overflow` 截断溢出、`glyph` 缺字形、`markup` 标记破坏
- `source` 原文：`defect` 原文有误

## 子代理

`read pr://<n>/meta` 的 `localRoot` 是 head 文件的物化目录，仓库工作树在 `runtime/work/repo`。子代理拿不到 `pr://`/`repo://`，把路径写进 prompt 让它们走文件系统。
