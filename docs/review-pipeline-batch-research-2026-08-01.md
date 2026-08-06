# 审查流水线研究:batch 长度 × 假阴性 × 假阳性(2026-08-01)

> 本档记录 2026-08-01 对翻译审查流水线(review_align → terms → review_moa → review_aggregate → review_finalize → review_comment)的一次完整审计与实验:
> 设计契约审查(11 项修复)、MoA 受控 A/B 测试(batch 30/60/159)、假阳性逐条核查、耗时根因修复、评论事故防护。
> 原始数据留档:`temp/ab30.json`、`temp/ab60.json`、`temp/ab159.json`(均为 `{ms, findings:[{key, severity, origin, detail, ...}]}`)。

## 1. 结论摘要

| 维度 | 结论 |
|---|---|
| 假阴性(漏检) | **与 batch 长度强相关**。26.2-fabric 子集 159 条:batch=30 发现 56 条(error 29)、60 发现 49 条(error 19)、159 仅 43 条(error 8)。error 级意见对 batch 最敏感(29→8) |
| 严重度降级 | 长 batch 不仅漏报,还把 error 降为 warning:30 报的 29 条 error 里,159 完全漏报仅 3 条,但 23 条被降级 |
| 假阳性(误报) | **与 batch 无关(0–1.2%)**。三轮 225 条原始 finding 逐条核验,0 条幻觉。机制:意见全部锚定 en/zh 客观差异,模型不发明问题 |
| 模型敏感度 | mimo-v2.5 长 batch 塌方(39→9 条),deepseek-v4-flash 相对稳(54→41);MoA 多模型在长 batch 下仍有兜底价值 |
| 噪声校准 | 同配置(batch=30)跨次运行方差 ≈ 1/40(mimo 39 vs 40 条)—— 批次差异是真实效应,非 LLM 采样噪声 |
| 落地修改 | `MAX_BATCH` 60→**30**;SKILL 注入 bug 修复;MoA 模型并行化;zombie 状态回收;评论三重防护 |

## 2. 方法

### 2.1 受控条件(A/B)

- 同 PR #6105(Chat Patches,8 个新增语言文件 × 4 版本)
- 同一份 ctx:`runtime/sessions/ctx/1b13446d-ac11-4937-b41a-d3daf59d7d8d.json`(aligned 505 条 / dict 89 条 / termsDistilled cleaned 33 条)
- 只审 26.2-fabric 子集(159 条,key 无跨版本碰撞)
- 同两模型(mimo-v2.5 + deepseek-v4-flash,均直连成功)、同 `maxTokens=16384`
- **唯一变量 `itemsPerBatch`**:30 / 60 / 159
- 三轮均 0 error batch、`unreviewedBatches=0`、全覆盖

### 2.2 假阳性验证口径

- **版本对齐**:验证一律取 reviewTable 中 `(key, gameVersion=26.2-fabric)` 行的 en/zh 原文;不得跨版本套用(1.21-fabric 有 16 条 zh 为空,与 26.2 的完整译文不同源)
- **逐条口径**:先按 key 去重(保留最高严重度)后逐条对照,再对被去重的低严重度 finding 全量复核 — 两次口径结果一致
- 证据分层:程序可复验(格式代码 § 集合、URL 大小写、%s 占位符、空值、日期分隔符)→ 语义对照(en/zh 直接矛盾)→ 主观建议(有据但属口味)

## 3. 假阴性:A/B 结果

### 3.1 总量与严重度(按 key 去重)

| | batch=30 | batch=60 | batch=159 |
|---|---|---|---|
| 发现条目 | **56** | 49 | 43 |
| error | **29** | 19 | **8** |
| warning | 25 | 29 | 35 |
| info | 2 | 1 | 0 |
| 耗时 | 511s(12 batch) | 381s(6 batch) | 253s(2 batch) |
| mimo / deepseek 各自去重 | 39 / 54 | 34 / 48 | **9** / 41 |

### 3.2 缺失结构(相对 batch=30)

- 30∩60∩159 共识 = 40 条(基本盘,三轮都报)
- 仅 30 报 = 8 条(1 error / 6 warning / 1 info);仅 60 = 3 条;仅 159 = 1 条
- 159 相对 30 完全漏报 14 条(3 error / 10 warning / 1 info);30 相对 159 只漏 1 条
- 30 报的 29 条 error 中,159 完全没报的只有 3 条,**其余 23 条被降级为 warning** — 长 batch 的代价主要是严重度稀释,其次才是漏报
- 唯一一条被 60 和 159 同时漏掉的 error:`text.chatpatches.desc.counterCheckStyle`(术语表偏离)

### 3.3 模型敏感度

- mimo 在 batch=30 时 39 条、batch=159 时仅 9 条(塌方);deepseek 54→41(相对稳)
- 159 轮基本靠 deepseek 兜底 —— MoA 双模型在长 batch 下的价值反而更大,但两模型同时衰减是真实风险

### 3.4 噪声校准(关键)

- A/B batch=30 的 mimo = 39 条;旧会话 `09358a1d`(同 batch=30、不同术语表)的 mimo = 40 条
- 跨次方差 ≈ 1/40 → 39→9 的塌方是**真实 batch 效应**,不是采样噪声
- 早前非受控对照(74% vs 14%)因 key 跨版本碰撞 + 术语差异被污染,已弃用;真实梯度为 56 vs 43(总量)、29 vs 8(error)

## 4. 假阳性:逐条核查

### 4.1 最终产出(1b13446d,67 条)证据分层

| 证据类型 | 数量 | 判定 |
|---|---|---|
| 字符级铁证:空值(16,属 1.21-fabric)、格式代码不匹配、孤儿 key、URL 大小写、日期分隔符、%s 占位符 | 33 | 程序可复验,零争议 |
| 语义级对照:en 新文案 vs zh 旧版残留、漏译后半句、加料 | ~30 | en/zh 直接矛盾可查 |
| 纯主观/口味建议 | 0 | — |

### 4.2 三轮 A/B 逐条口径(225 条原始 finding)

| batch | raw | dedup | 假阳性(无据/幻觉) | 假阳性率 |
|---|---|---|---|---|
| 30 | 93 | 56 | 0 | **0%** |
| 60 | 82 | 49 | 1(争议) | **~1.2%** |
| 159 | 50 | 43 | 0 | **0%** |

- 被 key 去重掩盖的 77 条低严重度 finding 全部复核:与保留条同源(术语/漏译/加词),0 幻觉
- 唯一争议条目(60 轮,error):`desc.searchPrefix` — 原文 "behind the cursor" 直译"光标后",意见按功能知识判方向相反。归因可争辩,已计入 1 条争议
- 模型诚实性抽查:条件化建议("若该项本身是开关配置可保留""'outline' 无明确术语")不构成误报

### 4.3 为什么假阳性压得这么低(与假阴性机制对称)

- **意见全部锚定 en/zh 客观差异**(格式代码集合、占位符、孤儿 key、URL 大小写、句子语义)——差异是事实,LLM 只负责组织描述,不发明问题
- 假阴性的来源是"没注意到差异"(batch 稀释注意力);假阳性需要"虚构差异",模型无此风险
- 严重度有客观锚点:空值/孤儿/占位符 = error(必然真);语义偏差 = warning;建议 = info

### 4.4 严重度虚高(独立于真假)

- 30 轮的 29 条 error 中约 20 条是术语/格式/漏字类(如 `category.time` 漏"戳"、`counterCheckStyle` 术语偏离),60 报 19、159 报 8
- 同一 key 三轮 error/warning 严重度漂移大 → 严重度校准不稳定,但**不构成假阳性**
- 处置:严重度交给主 agent 裁决层(review_finalize)重判 —— 设计上已兜底,不修

## 5. 耗时根因与修复(「为什么这次时间有点长」)

| 根因 | 现象 | 修复 |
|---|---|---|
| SKILL 注入 bug | `resolvePromptText` 用 `\n\n` 分隔 → SDK `_expandSkillCommand` 按 `indexOf(" ")` 切 skill 名被截断(`translation-review\n\nPR`),**技能正文从未注入 agent** | 改单空格分隔 + head/base 提示一律全 SHA(防 STALE_HEAD 短 SHA 误报) |
| MoA 模型串行 | 两模型顺序审查,时间 ×2 | `Promise.all` 并行 + upsert 写串行链(防 read-modify-write 互踩) |
| batch 无预算 | 大 PR 一次塞 159 条,单次调用 ~50 分钟 | `computeDefaultBatchSize`(利用 contextWindow/maxTokens,clamp 后上限 **30**)+ `computeDefaultMaxTokens`(随 batch 放大) |
| SKILL.md 渐进披露是描述性的 | agent 一次全审 | 改命令式("禁止一次全审") |

修复后实测:159 条 1 batch → ~8 分钟(旧 50 分钟+)。

## 6. 评论事故防护(PR #6105 意外发表)

事故:审查 session 自动将报告发表到公开 PR #6105(评论 #5149905600,67 条意见)。根因:review_comment 的 risk 为 `review_write`(自动执行)+ 声称存在的 `REVIEW_PUBLISH_ENABLED` 开关从未实现。

三重防护(全部生效):

1. `session-manager.ts` FLOW_WHITELIST 移除 `review_comment` —— agent 无工具可用
2. `review_comment.ts`:meta.risk `review_write` → `repository_write`(卡 admin 确认)+ execute 开头 `REVIEW_PUBLISH_ENABLED` 检查
3. `config.ts`:实现 `REVIEW_PUBLISH_ENABLED` env(`z.enum(["true","false"]).default("false")`);`types.ts` 加 `REVIEW_PUBLISH_DISABLED` 错误码;compare.ts 映射 503

配套:`review-manual-plan` op=set 补 persist;新增 2 个回归测试(评论 head guard + 禁用开关)。

## 7. 其他修复清单(设计契约审计)

- `review_moa`:删 `batchesPerModel` 死参数;`fallbackOrigin` 归属修正;abort 短路
- `review_finalize`:抽 `validateReviewFinalize` 纯函数(存在性/severity/互斥校验),加 finalRows∩dismissed 互斥测试
- `terms-extract`:去重 key 加 `\u0000` 分隔(防词内拼接碰撞)
- `review_align`:按 path 替换旧行;修 `AlignReviewItemsResult[][]` 类型笔误
- `terms-distill`:删 STATUSES 死代码
- zombie 回收:`session-service.ts` ensureLoaded 把遗留 running → **idle**(语义="进程死了、数据在盘、可人工续跑";用 failed 会锁死续跑)
- 验证:typecheck 0 诊断 / lint:arch 无违规 / 134 测试(110 pass / 24 skip / 0 fail)

## 8. 落地修改与验证状态

| 修改 | 状态 |
|---|---|
| `MAX_BATCH` 60→30,预算公式只收紧不放大(MIN=10) | 已上线,后端重启生效;测试更新(空输入→10、5 万字符条目→17) |
| SKILL 注入单空格 + 全 SHA | 已上线,smoke 验证 `<skill name="translation-review">` 块注入、thinking 按 13 步规划 |
| MoA 并行 + 写串行链 | 已上线 |
| 评论三重防护 | 已上线 |
| zombie idle 回收 | 已上线,重启后 09358a1d / 1b13446d 均正确标记 idle |

## 9. 遗留与建议

- 已发评论(PR #6105,05:03Z)未删除 —— 用户未决定,保持现状
- 审查模型候选:用户倾向用 gpt-5.6-luna 替代 mimo-v2.5(A/B 中 mimo 长 batch 塌方);切换前需确认 opencode-go 平台确切模型 ID(可能带 `-chat` 后缀)并直连验证,`llm-registry.ts` 尚无该条目
- 若再降"烦"度:裁决层把 info 级建议按"客观差异 vs 口味建议"分流,后者可不发表
- 设计内待办(与本轮无关):MCP 词汇表接入(dict_lookup lookup 仍 stub)、前端 review-state 卡片、PR 审查记录关联(supersedesSessionId)
- 报告全文耗时估算:30/批 + 4 桶全审 ≈ 30–40 分钟 LLM 时间 + 裁决轮次 —— 大 PR 需接受此时长
