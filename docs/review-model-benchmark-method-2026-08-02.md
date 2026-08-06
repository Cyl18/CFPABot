# 6 模型 MoA 基准实验方法:模型能力 × batch 长度 (2026-08-02)

> 目标:在 PR #6105 上对 6 个 MoA 审查模型(gpt-5.6-luna / deepseek-v4-flash /
> gpt-5.6-terra / claude-sonnet-5 / grok-4.5 / hy3)做能力基准,回答三个决策问题:
> ① 哪些模型值得留在 reviewModelSet;② 哪些模型长 batch 会塌方(影响渐进披露轮次设计);
> ③ 模型间是互补还是冗余(MoA 组合价值)。
> 执行脚本:`temp/run-moa-bench.ts`(跑实验);`temp/analyze-moa-bench.ts`(出报告)。

## 1. 设计要点:复用 MoA fan-out,免做 18 次独立运行

`review_moa` 一次调用内把**同一份批次划分**并行打给全部 6 个模型
(`Promise.all` + 每模型内部 batch 串行),结果按模型分存 `ctx.reviews`
(每 batch 增量落盘),findings 可精确归属到模型。因此:

- **每轮运行 = 6 个模型的独立能力数据点**,且 6 模型看到完全相同的条目、相同的
  prompt(术语表/batch 边界一致)—— 天然受控,无需做 6×3=18 次单模型运行。
- 实验矩阵只需 **3 轮 + 1 轮噪声复跑** = 4 次 review_moa 调用。
- 模型之间在调用内互不可见(各自独立出 JSON),无交互污染。

## 2. 受控条件(与 2026-08-01 A/B 完全对齐)

| 项 | 取值 |
|---|---|
| PR | #6105 Chat Patches,8 个语言文件 |
| ctx 快照 | `runtime/sessions/ctx/1b13446d-ac11-4937-b41a-d3daf59d7d8d.json`(aligned 505 条 / dict 89 / termsDistilled cleaned 33)**拷贝复用,不可新生成** |
| 审查范围 | 仅 `versions: ["26.2-fabric"]`(159 条 changed,key 无跨版本碰撞) |
| 唯一变量 | `itemsPerBatch` ∈ {30, 60, 159} |
| maxTokens | **不显式指定**,走工具默认(随 batch 自动放大:30/60 → 16384,159 → 31800)。6 模型 context 均 >100k,输入侧无压力;输出预算随 batch 放大方向保守 — 长 batch 输出空间更大,若仍观测到塌方则是真实效应,不会被掩盖。需要与 2026-08-01 严格对齐时可用 `env MAX_TOKENS=16384` 强制 |
| 模型集 | 6 模型全量(与生产 reviewModelSet 一致),thinkingLevel=high |
| 兜底模型 | defaults.sessionModel = deepseek-v4-flash(与生产一致) |

执行协议(脚本已实现,`bun temp/run-moa-bench.ts`):

1. 从 1b13446d 快照拷 ctx,清空 `reviews/reviewTable/finalTable/todos`(防旧数据污染);
2. 每轮独立 sessionId(`ab6-30a` / `ab6-60` / `ab6-159` / `ab6-30b`),直调
   `createReviewMoaTool(sessionId, fallbackModel).execute(null, {itemsPerBatch, versions:["26.2-fabric"]})`(maxTokens 不传,用默认);
3. 记录 wall time(ms);
4. 从 `ctx.reviews` 提取 → `temp/ab6-{label}.json`(格式见 §4);
5. 验收:每轮 `unreviewedBatches=0` 才视为有效轮;有失败 batch 的轮单独标注,不静默。

**噪声地板轮(ab6-30b,可选但推荐)**:旧 A/B 只校准过双模型跨次方差 ≈ 1/40;
新模型集每个都值得一条同配置复跑基线,用于判定 batch 效应 vs 采样噪声。
成本 ≈ 1 轮,收益是 6 条噪声基线。

## 3. 指标定义(分析脚本全部自动计算)

记号:cell(m,b) = 模型 m 在 batch=b 轮的 findings 按 key 去重(保留最高严重度,
error>warning>info);R = 全部轮次 union 后按 key 去重;R_err / R_warn / R_info 按
R 中最高严重度分层。`R_{−m}` = 去掉 m 所有轮后的 union(留一法)。

| 指标 | 定义 | 用途 |
|---|---|---|
| 覆盖量 | `\|cell(m,b)\|`,及 error/warning/info 分项 | 基本产出 |
| error 召回 | `\|cell(m,30) ∩ R_err\| / \|R_err\|` | **主排序指标** |
| warning/info 召回 | 同上 × R_warn / R_info | 次排序指标 |
| 留一增量 (LOO) | `\|cell(m,30) ∩ (R − R_{−m})\|` = 只有 m 报出的 key 数 | 互补性/组合价值;值越大,去掉 m 损失越大 |
| 漏报 | `R − cell(m,b)`,按严重度分层 | batch 敏感性的另一半 |
| 降级率 | key ∈ R_err 且被 m 报为 warning 的比例 | 严重度校准 |
| 虚高率 | key ∈ R_warn 被 m 报为 error 的比例 | 严重度校准 |
| error 保留率 | `\|error in cell(m,159)\| / \|error in cell(m,30)\|` | **塌方检测**;旧基线:deepseek 76%,mimo 23% |
| 噪声地板 | `\|cell(m,30a)\| vs \|cell(m,30b)\|` 差值 + 两轮 key 集 Jaccard | 判定 batch 效应真实性 |
| 模型间 Jaccard | batch=30 轮两两 key 集 `\|A∩B\|/\|A∪B\|` | 冗余检测;>0.7 视为高度重叠 |
| 可靠性 | ok / errorBatches / fallbackBatches / unreviewedItems | 直连失败 ≠ 能力差,单独列 |
| 假阳性 | 见 §4,error 全查 + 抽样核查,分模型分轮 | 精度 |

合成评分(默认权重,报告里可调):

```
score(m) = 3·errRecall(m,30) + 2·warnRecall(m,30) + 1·infoRecall(m,30)
         − 2·fpRate(m,30) − 3·unreviewedRate(m)
```

fpRate 只统计已核查的 findings(见 §4);unreviewedRate = 未覆盖条目数/159。

## 4. 假阳性核查协议(证据分层,复用 2026-08-01 口径)

分析脚本对每条 finding 自动贴证据层标签,只有 T3 需要人看:

- **T1 程序可复验**(自动):脚本从 1b13446d 快照取 (key, 26.2-fabric) 行的 en/zh
  原文,自动核对:格式代码集合(`%s %d {}`)、空值(en 非空 zh 空)、EN=ZH、
  占位符丢失 —— 命中即真,零争议;
- **T2 术语可复验**(自动):en 含 cleaned 术语词且 zh 不含对应译文 → 基本为真;
  不一致再标 T3;
- **T3 语义/主观**(人工):脚本输出工作清单(key | en | zh | issueType | detail),
  逐条判真/伪,结论写入 `temp/fp-audit.json`(`{ "fp": ["modelId:itemId", …] }`)
  后重跑分析脚本即并入 FP 率。

**强制全查**:所有 error 级 finding 必须走完核查(error 是发版拦截依据,旧轮
29/19/8 条,全查成本低);warning/info 按每 cell 抽样 ≥10 条(不足全查)。

版本对齐铁律:核查一律用 reviewTable/ctx 中 `(key, gameVersion=26.2-fabric)` 行,
**不得跨版本套用**(1.21-fabric 有 16 条 zh 为空,与 26.2 不同源)。

## 5. 决策规则(报告产出后对照)

**淘汰候选**(任一命中):
1. batch=30 error 召回 < 0.5 且 LOO 增量 ≈ 0(又弱又冗余);
2. error 保留率 < 40%(长 batch 塌方,拖累渐进披露大轮);
3. FP 率 > 5%(幻觉风险;T1 类 FP 直接否决);
4. 直连失败率 > 30%(errorBatches/总批次,网络或配额问题)。

**组合建议**:保留高召回 + 高 LOO 增量的;Jaccard > 0.7 的一对模型二选一
(留 score 高的);塌方模型若 LOO 增量大,保留但限制其轮次 ≤ batch 30。

**口径备忘**:R 是全实验 union,是"可发现性"的下限估计(真实假阴性可能更大);
模型间相对比较不受影响,绝对值解读需注明。

## 6. 陷阱清单(跑之前读)

1. **maxTokens 不固定**(已按你的决定):默认公式下 batch=30/60 → 16384、159 → 31800,输出预算随 batch 放大。代价:159 轮与 30/60 轮多一个变量(输出空间),方向是**有利于长 batch** — 塌方结论只会更可信;跨轮横向比较模型相对能力不受影响。若要与旧 A/B 严格可比,`env MAX_TOKENS=16384` 强制。
2. **ctx 必须拷贝自 1b13446d,且清空 reviews/reviewTable/finalTable/todos**;
   用错快照(如 ab-test-30 的 ctx)则术语/aligned 与旧轮不同源。
3. **兜底归属**:fallbackModel(deepseek)代跑的 findings 归 deepseek 但标
   `fallbackFrom`;失败模型的 cell 记 errorBatches,该 cell 的召回/FP 折算到
   `reviewedItems`,结论注明不完整。
4. **失败 ≠ pass**:errorBatches>0 的轮必须单独列出,不得并入统计当 0 处理。
5. **顺序**:三轮独立 session 顺序执行,无 carryover;模型在 reviewModelSet 的
   顺序固定(批次划分取决于 items 数组顺序,与模型无关)。
6. **thinkingLevel 现状不生效**:`review-moa.ts` 的 `llmComplete` 调用未传
   thinkingLevel(配置只是装饰),各模型实际跑 API 默认档 —— 横比公平,但与
   生产 MoA 的"预期档位"有出入,报告注明。
7. 旧 A/B 的 mimo-v2.5 已不在模型集,新旧对比只有 deepseek-v4-flash 可对齐;
   mimo 的 39→9 塌方值仅作基准线参考。

## 7. 文件清单

| 文件 | 作用 |
|---|---|
| `temp/run-moa-bench.ts` | 驱动 4 轮实验 + 提取 `temp/ab6-*.json`(已存在的结果默认跳过,`--force` 重跑) |
| `temp/analyze-moa-bench.ts` | 读 ab6-*.json → 全部指标 + markdown 报告;可并入 `temp/fp-audit.json` 人工判定 |
| `temp/ab6-30a.json` 等 | 原始数据留档(格式:`{itemsPerBatch, itemsTotal, ms, models:[{provider, modelId, ok, errorBatches, fallbackBatches, unreviewedItems, findings:[{itemId, key, issueType, severity, detail, suggestion, origin, fallbackFrom?}]}]}`) |
| 本文档 | 方法 + 口径 |
