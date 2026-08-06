# 5 模型主 agent 复核评分卡 (PR #6105, 26.2-fabric 子集)

**方法**:对每个模型的 raw findings 按 key 归一化去重,逐条对照 en/zh 原文人工裁决(充当主 agent)。
裁决标准以真实审查 finalTable(67 条,实验子集 31 条)定级风格校准:加"开关"/多动词/漏译成分/加颜色代码/错别字"撤消"/语病等
在 finalTable 中均有同类保留案例 → 判应留;纯术语变体(格式化代码 vs 格式代码)/可接受意译/排版建议 → 判过于严格。
30a 轮全量逐条(5 模型 147 条 unhit 全部人工读原文);60/159/30b 轮沿用同 key 裁决,新增 7 个 key 逐条补判。
裁决明细: temp/judge-verdicts.json;工作台: temp/judge-workspace.ts

## 1. 主轮评分卡 (30a, batch=30)

| 模型 | 意见数 | 命中final | 补判应留 | 过于严格 | 应留率 | 严格率 | final覆盖 | 综合分 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-terra | 54 | 29 | 18 | 7 | 0.87 | 0.13 | 0.94 | **0.89** |
| deepseek-v4-flash | 52 | 29 | 14 | 9 | 0.83 | 0.17 | 0.94 | **0.86** |
| gpt-5.6-luna | 65 | 30 | 22 | 13 | 0.80 | 0.20 | 0.97 | **0.85** |
| hy3 | 54 | 29 | 12 | 13 | 0.76 | 0.24 | 0.94 | **0.81** |
| grok-4.5 | 71 | 31 | 21 | 19 | 0.73 | 0.27 | 1.00 | **0.81** |

综合分 = 0.5×应留率 + 0.3×final覆盖 + 0.2×(1−严格率)。

**排序与旧评分卡(grok 4.69 > luna 4.09 > deepseek 3.62 > hy3 3.47 > terra 3.46)几乎反转**:
旧卡偏重产出量与 T1/T2 自动核验;主 agent 逐条复核后,精度主导。grok 高产高噪(71 条,27% 过于严格),terra 低产高精(54 条,仅 13% 过于严格)。

## 2. 严重度校准 (30a)

| 模型 | error 定级 | error→final error | error→warning/info | error 命中率 | 4 个真 error 全中 |
| --- | --- | --- | --- | --- | --- |
| grok-4.5 | 28 | 4 | 13 | 61% | ✓ |
| gpt-5.6-terra | 25 | 4 | 14 | 72% | ✓ |
| gpt-5.6-luna | 25 | 4 | 14 | 72% | ✓ |
| deepseek-v4-flash | 23 | 4 | 12 | 70% | ✓ |
| hy3 | 20 | 4 | 10 | 70% | ✓ |

所有模型都命中 4 个真 error(链接大小写/占位符不匹配/版本文案错误/分隔符),无一漏网。
error 定级命中率 61-72%;未命中的 error 多为术语/漏译类,定级过高。

## 3. 过于严格清单 (30a, 主 agent 判"应驳回"的意见)

**模型共性误报**(5 模型 ≥3 个都提):
- `category.counter` "重复计数"缺"器" — 5/5 全提,可接受变体
- `desc.boundary` 漏 "after chatting" — 5/5 全提,语义基本完整
- `desc.hover` "时间文本" vs "时间戳文本" — 5/5 全提,术语微差
- `desc.timeFormat` "格式代码修饰符" — 5/5 全提,术语微差
- `category.desc.name` vanilla→"普通聊天" — 4/5,可接受
- `desc.counterCheckStyle` "格式化代码" — 4/5,纯术语变体
- `desc.help.reloadConfig` 漏 "exit" — 3/5,"重新打开"已含
- `help.formatCodes` 术语 — 3/5
- `title`/`compactChat` 中英缺空格 — 3/5,排版噪声

**模型独有误报**:
- grok 13 条 warning 级严格(desc.messageDrafting/searchDrafting 漏 closing、desc.searchPrefix "光标后"、desc.chatlogLoad 语气、sizzle 拟声等)
- luna: chatHidePacket×2(误读原文,EN 就是 hide message packets)、desc.searchPrefix 判 error、"选择框"误判(原文即 selection box)
- hy3: counterColor/counterFormat 增"消息"、help.regexTester 加"工具"、timeSystemMessages 语序
- deepseek: category.desc.name 判 error(其他模型 warning)、desc.counterCheckStyle 判 error

**主 agent 补判应留但 finalTable 未收的**(模型对、原审计漏,15 个 key):
- 撤消/撤销错别字族: context.delete.confirm、desc.chatlogClear、desc.chatlogClearHistory、desc.chatlogClearMessages、category.desc.chatlog.actions(4 模型共提)
- 漏译 focused: chatHeight、desc.chatHeight
- 语义偏移: desc.chatlogSaveInterval(Always saves→"尝试保存")、desc.counterColor(意译含糊)、desc.timeDate(主客体颠倒)、desc.hoverFormat(结构偏差)、desc.hoverDate(可读性)
- 增译: search.desc.caseSensitive(擅自加正则说明句)、desc.chatlog(语法残缺)、logMessageStructures(动词歧义)

## 4. 跨轮一致性 (60/159/30b)

全轮(4 轮 unique 并集)final 覆盖全部 1.00 — 5 模型在 4 轮中都能覆盖全部 31 条 final 意见,无模型在规模变化时掉链子。
其他轮仅新增 7 个未裁决 key(30b timeFormat/vanillaClearing 等),其中 2 条模型自认"无需修改"仍提交,均判过于严格。

## 5. claude-sonnet-5 真实产出评估 (去掉 fallback 后)

**数据来源**: 新 endpoint(QIUQIU)重跑成功批次的真实产出 — 30a b0/b1/b5、60 b0/b1、30b b5。
已剔除: fallback batch(30a b2/b3、30b b0-b4)、error/empty batch(30a b4、60 b2、159 b0)。
注意产出模式不同: claude 被 prompt 为逐条 approve/reject 裁决, 意见数天然少于其他模型的找茬模式。

| 轮次 | 已看条目 | 意见数 | 命中final | 归一覆盖 | 漏报 |
| --- | --- | --- | --- | --- | --- |
| 30a | 69/159 (3/6 batch) | 19 | 9 | 9/10 = **0.90** | modmenu(error) |
| 60 | 120/159 (2/3 batch) | 14 | 10 | 10/24 = **0.42** | 14 条, 含 2 error (desc.chatShift, desc.chatlogBackup) + 10 条旧版残留类 |
| 30b | 9/159 | 1 | 0 | 0/1 | title(strict) |
| 合并 | 133/159 | 34 | 13 | 13/26 = **0.50** | 13 条, 含 2 error |

注: 30a 意见数含 b5 的 4 条完整格式意见(time/timeDate 命中 final、searchDrafting/title 应留 1 条)。

**主轮评分 (30a, 与 5 模型同口径)**:

| 模型 | 意见数 | 应留率 | 严格率 | 归一覆盖 | 综合分 |
| --- | --- | --- | --- | --- | --- |
| claude-sonnet-5 | 19 | 0.74 | 0.26 | 0.90 | **0.79** |
| gpt-5.6-terra | 54 | 0.87 | 0.13 | 0.94 | **0.89** |
| grok-4.5 | 71 | 0.73 | 0.27 | 1.00 | **0.81** |

**claude 画像**:
- 精度与 grok 相同(应留率 0.74 / 严格率 0.26): 提出的意见质量不差, 19 条意见中 14 条应留, 误报集中在 category.counter/category.desc.name/category.name 等术语洁癖 + title 缺空格 + desc.contextOutlineColor 误判(原文就是 selection box, 译文准确)
- **30a 单轮覆盖不错 (9/10 = 0.90)**: 唯一漏报是 modmenu Discord 链接(error) — 60 轮 9 条 batch 时反而抓到了, 同一问题跨 batch 不稳定
- **但 60 条 batch 时覆盖崩**: 旧版残留类(desc.boundaryColor/timeColor/nameColor/hoverColor 等 10 条 warning, 5 模型命中率最高的类别)全部漏掉 → 归一覆盖 0.42; 批内已看条目越多, claude 漏报越多
- 产出模式差异: approve/reject 裁决天然保守, 意见量只有 5 模型的 1/3-1/4

**结论**: claude 意见质量与 grok 相当但覆盖显著差(漏 2 个 error + 15 条 final), 综合垫底。若用于生产, 只能当"审过的条目保守放行"角色, 不能当查漏模型; 且旧版残留类问题是它的系统性盲区。

## 6. 结论与建议 (5 模型 + claude)

| 排名 | 模型 | 综合分 | 定位 |
| --- | --- | --- | --- |
| 1 | gpt-5.6-terra | 0.89 | 高精低噪,error 命中率并列最高,严格率最低;适合直接产出 |
| 2 | deepseek-v4-flash | 0.86 | 高精 + 全轮稳定,但 3 处 error 误报(定级偏激进) |
| 3 | gpt-5.6-luna | 0.85 | 覆盖最好(0.97),warning 级噪声偏多(11 条 strict) |
| 4 | hy3 | 0.81 | 中规中矩,error 命中率最低(70% 但绝对数少) |
| 5 | grok-4.5 | 0.81 | 全覆盖 + 最高产,但 27% 意见过于严格(13 条 warning 噪声),需最多人工过滤 |
| 6 | claude-sonnet-5 | 0.79 | 意见质量同 grok,30a 覆盖 0.90 但 60 条 batch 时旧版残留类全漏(0.42),批越大漏越多 |

## 7. final 31 条命中矩阵 (30a 轮, 5 模型)

共同命中 (5 模型全中): 26/31; 非共同命中: 5 条。

| final key | sev | grok | terra | luna | deepseek | hy3 | 漏报者 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| modmenu.descriptionTranslation.chatpatches | error | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.chatShift | error | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.chatlogBackup | error | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| context.copied | error | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| category.compact | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.compactDistance | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.compactChat | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.onlyInvasiveDrafting | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.nameFormat | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.boundaryColor | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| **desc.timeColor** | warning | ✓ | **✗** | ✓ | ✓ | ✓ | **gpt-5.6-terra** |
| desc.nameColor | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.hoverColor | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.vanillaClearing | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| category.desc.chat | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| **category.desc.help** | warning | ✓ | ✓ | ✓ | ✓ | **✗** | **hy3** |
| desc.contextReplyFormat | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| chatShift | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| counter | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| category.chatlog | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| hover | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| contextOutlineColor | warning | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| **counterCheckStyle** | info | ✓ | **✗** | ✓ | ✓ | ✓ | **gpt-5.6-terra** |
| category.chatlog.actions | info | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| desc.chatlogOpenFolder | info | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| **desc.help.missing** | info | ✓ | ✓ | **✗** | **✗** | **✗** | **luna, deepseek, hy3** |
| hoverDate | info | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| nameFormat | info | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| timeDate | info | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| time | info | ✓ | ✓ | ✓ | ✓ | ✓ | 无 |
| **messageDrafting** | info | ✓ | ✓ | ✓ | **✗** | ✓ | **deepseek-v4-flash** |

**解读**:
- grok 31/31 全中, 是唯一无漏报模型 — 与它高产出配套
- 非共同命中全是 warning/info 级, 4 个真 error 5 模型全中, 无遗漏
- desc.help.missing 是最分散的漏项(3 个模型漏): 加颜色代码类意见容易在长 batch 中被跳过
- terra 漏 desc.timeColor 但命中同款 boundaryColor/nameColor/hoverColor — 模板重复类条目单点漏报, 建议程序化检查同类模式

**给 MoA 聚合的建议**:
- grok 作为"兜底/查漏"模型(覆盖 31/31),其意见必须经聚合层过滤后再进 final
- terra 的意见可信度最高,聚合时可加权
- 4 个真 error 全模型无遗漏 → 关键错误捕获已饱和,多模型对真错的边际收益接近 0
- "撤消"错别字族 4 模型都提了但原审计全漏 → 这是 MoA 聚合后仍存在的系统性漏项,建议加程序化检查(术语表/错别字规则)
