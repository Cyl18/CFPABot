# 翻译审查流程（review 模式）

## 步骤

1. **取上下文**：`read repo://pr/<n>` 看规模与变更文件；`read repo://pr/<n>/discussion` 读既有讨论；`read repo://pr/<n>/meta` 看检查结果与工作区。
2. **加载审查数据**：`read repo://pr/<n>/review/rows` 生成/读取逐 key 审查行。程序提示（program）是机械预审结论，只作参考，不是最终意见。可用 `?filter=changed|flagged|all`、`?workspace=`、`?query=`、`?offset=`、`?limit=` 过滤，`?rebuild=1` 强制重建。
3. **精审**：逐条审阅 changed 行；`program` 提示是机械预审结论，只作参考，不是最终意见。对可疑项用 `read repo://pr/<n>/review/rows?query=` 搜索同类，确认不是单点误判。
4. **核对依据**：可疑的译名或句式用 `glossary` 查原版术语与词典；怀疑是批量问题时用 `read repo://pr/<n>/review/rows?query=` 全文搜索同类。
5. **落草稿**：`write local://draft.json` 保存 verdict、主评论与行内评论。本地写入不校验；发布时（`write repo://pr/<n>/review` 或面板）才会校验并返回错误。允许写 GitHub 时用 `write repo://pr/<n>/review` 发布；否则由管理员在面板发布。

   `draft.json` 最小形状：`{ "prNumber": <n>, "headSha": "<当前 head>", "verdict": "approve|changes|reject", "summary": "...", "comments": [...] }`；`comments` 每项至少含 `path`、`line`、`key`、`severity`、`mqm`、`body`，`id` 与 `updatedAt` 可由服务端补。`headSha` 从 `read repo://pr/<n>` 取。

## 盲审公理

1. **只看 changes**：英文原文的改动都在 diff 里，不用跨版本全量扫。
2. **机械预审是刚需**：占位符、§色码、换行、首尾空格、全半角标点、漏译先靠程序提示全扫一遍。
3. **批量错模式→全文通查该 pattern**：发现一个术语或体例问题，用 `read repo://pr/<n>/review/rows?query=` 抓全文同类。
4. **受控词表是 join key**：`mqm` 只能用受控词表里的全形 `Dim/type`，不许自编。
5. **旧译有误才改，改必联动**：修一处就联动修全文件同类。
6. **Formatter 只单向崩**：实参多于占位安全（忽略），占位多于实参才崩。`zh 所需 > en 所需` 才是 critical；zh 少占位（含复数、换序、跳号）是 neutral。
7. **severity 四档**：critical=撞车/崩溃/完全反义；major=错义/漏译/关键术语错；minor=体例/标点/风格；neutral=灰区。不确定就标 minor 或 neutral。
8. **一致性≠正确**：全文件统一只能证明没有分裂，不能证明译对。一致性信息只用来发现分裂，不用来证明正确、更不用来放行。
9. **无依据不判 major**：跨 key 统一、游戏机制、数值、物品显示名，没有 glossary/原版/可核来源时标 suspected，不判 major。疑似上游英文有错时标 neutral 并注明，不判 `Accuracy/mistranslation`。
10. **neta/花式标题放行**：绵羊梗、乐队梗、字幕组梗等亚文化项不判——你是 LLM，这是你的系统性盲区，收手。
11. **同 pattern 只报一条**：批量术语或体例问题压缩为一条评论（首现 key 用 path+line 定位），其余实例进 `covers`（本条 key 不进），body 写 pattern 而不是逐条复读。

## 主评论形状（`summary`）

```
major 一览（{M} 条，见 inline）：
- {key 短名}：{一句话问题}（{建议译法/备注}）

[存疑 {k} 条（minor，未计入 major，请先核对游戏）：]
[- {key}：{分歧描述}——{核对动作}后再定]

{对齐/占位/标点预审结论，一句。}
```

首行「本批共 N 条 inline（major M / minor m），verdict：**…**。」与脚注由系统按实际条目生成，**不要自己写**。
存疑项永不进 major 一览，单列「存疑」节。

## 行内评论形状

- `en` / `zh` 填该行原文与译文；`body` 只写散文原因，不要自己拼标题（severity、mqm、原文/译文块由系统生成）。
- `suggestion` 给替换后的整行译文；`covers` 为空且非 `suspected` 时必须给 suggestion（系统会拒收），`covers` 非空时不要给 suggestion。
- 同一 pattern 压缩成一条：首现 key 用 `path` + `line` 定位，`covers` 只列其余实例。
- `suspected: true` 的条目 severity 不高于 minor。
- 行号必须落在 `read repo://pr/<n>/review/rows` 标记为 `inHunk` 的 head 行上，否则会被拒收。

## verdict

- `approve` 可合：没有必须修改的问题。
- `changes` 需改后合：存在需要修改的问题，但不至于整体退回。
- `reject` 退回：整体质量不达标或方向错误。
