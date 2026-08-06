# CFPAAgent 语义层 5 共识对照分析

> 分析日期: 2026-07-15
> 分析范围: D:\translate-project\CFPAAgent (AGENTS.md, docs/specs/, src/ 核心文件)


> **注意**: 本文分析于 2026-07-15 完成。此后架构重构移除了 `agent/review-run/` 完整审查管线，
> 审查逻辑迁移到 `agent/tools/` 作为 Agent 原生工具直接调用 LLM。ReviewRun 状态机、JobManager、
> WorkerPolicy 等概念已不再存在于代码中；TermAsset 构建移入 `agent/tools/terms-extract.ts`。
> 本文的分析框架仍有参考价值，但具体类型引用已过时。
---

## 共识一：起点必须是业务概念，而非数据表

**评级: ✅ 已覆盖**

### 证据

整个架构以 **Flow** 作为第一等业务抽象。Flow 的定义（`src/types.ts`）强调名称表达业务意图、有明确业务输入输出、可独立执行业务动作：

```typescript
interface Flow<I, O> {
  name: string;           // 如 pr_get_context, translation_analyze, review_publish
  description: string;    // 业务结果+主要副作用
  input: I;               // TypeBox schema → 运行时校验
  output: O;              // TypeBox schema → 输出校验
  meta: {
    tags: readonly string[];
    risk: FlowRisk;       // read | review_write | repository_write | destructive
    effects: readonly FlowEffect[];
  };
  execute(ctx, input): Promise<O>;
}
```

- **Flow 命名规范**（`flow-architecture-spec.md` §4）：名称表达业务意图，而不是技术动作。`pr_get_context`、`translation_analyze`、`review_publish`、`info_comment_refresh` 均是业务概念。
- **非 Flow 明确禁止**：`escapeMarkdown`（纯函数放 `_shared`）、`githubCreateComment`（client 技术方法）、`postComment`（缺少约束的通用写操作）均不是 Flow。
- **Flow 不直接调用 Flow**：组合由 `dispatch.ts` 或 Agent 编排，Flow 内只调用 client、`_internal` helper、`_shared` 纯函数。
- **webhook DTO 只保存业务字段**（`01-orchestration.md` §2.2），不复制完整 GitHub payload。
- **三层架构严格分离**：`api/`（HTTP 入站适配）→ `flows/`（业务编排）→ `_shared/`（纯算法）+ `client/`（外部系统），依赖方向严格单向。

### 缺失什么

无本质缺失。但有以下可改进点：

1. `translation_analyze` 的输出当前是 `evidence` 使用 `enBase/enHead/cnBase/cnHead: string`（`09-translation-review-delta.md` §3.3），缺失值通过 `?? ""` 表达，无法区分"key 不存在"和"value 为空"。Delta 规范已计划抽取四值 union 纯算法并生成稳定 `LangReviewItem`，但尚未完成。

### 改进建议

- 完成 `translation_analyze` 的 Delta 迁移，使用 `optional` 字段表达缺失值，生成稳定不可变资产（aligned asset）。
- 在 `_shared/` 中提取纯对齐算法，与 `translation_analyze` Flow 解耦，确保数据管道独立于业务编排。

---

## 共识二：语义资产必须包含暗知识（业务口径、关联规则、维度边界、指标定义）

**评级: ⚠️ 部分覆盖**

### 证据

CFPAAgent 在以下方面体现了暗知识管理：

**1. TermAsset — 术语资产的暗知识封装**（`src/agent/review-run/types.ts`）

```typescript
interface TermAsset {
  schemaVersion: 1;
  termAssetId: string;
  runId: string;
  sourceStatus: TermSourceStatus[];       // 各提供者状态
  difficultTerms: TermCandidate[];        // 启发式难译术语
  communityMatches: TermMatch[];          // 社区词典匹配
  vanillaMatches: TermMatch[];            // 原版词典匹配
  consistencyCandidates: TermCandidate[]; // 同一英文→不同中文的一致性候选
  discoveredTerms: TermCandidate[];       // 审查中发现的术语
  createdAt: string;
}
```

- `difficultTerms` 从 domain key 前缀匹配启发式识别
- `consistencyCandidates` 从同一英文词出现不同翻译中识别
- 不可变资产（immutable），创建后永不修改
- Worker batch 通过 `projectBatchTerms` 获取投影子集，而非全量数据

**2. ReviewRun — 审查运行时的完整语义上下文**（`src/agent/review-run/types.ts`）

```typescript
interface ReviewRun {
  schemaVersion: 1;
  runId: string;
  revision: number;           // 乐观锁
  scope: ReviewScope;         // 固定 repo + PR + baseSha + headSha
  scopeBinding: { source; boundAt };
  status: ReviewRunStatus;
  stages: { prepare, terms, lang, langAdjudication, manual, manualAdjudication, report };
  activeJobIds: string[];
  artifactRefs: Record<string, string>;  // 构件引用
  coverageRef: string;
  primaryWorkerPolicyId?: string;
  modelSetId?: string;
}
```

- `CoverageManifest` 记录每个 review unit 的预期模型、完成模型、失败模型、状态和 batch 归属，形成完整的**审查覆盖语义**。
- `CandidateCluster` 包含 `programOpinions`（程序化检查）和 `modelOpinions`（多模型意见），以及 `voteSummary`（多数投票计数），保留了**模型分歧的暗知识**。

**3. FlowEffect — 副作用声明**（`src/types.ts`）

```typescript
type FlowEffect =
  | "github_read" | "github_comment_write" | "github_metadata_write"
  | "github_check_write" | "github_workflow_write"
  | "git_commit" | "git_push" | "storage_write" | "external_write";
```

每个 Flow 显式声明其副作用，形成可观测的**安全语义边界**。

**4. WorkerPolicy — 版本化审核策略**（`src/agent/review-run/worker-policies.ts`）

```typescript
"lang-explicit-v1": {
  id: "lang-explicit-v1",
  verdictMode: "explicit_all",       // 每项必须出现且只有三种 verdict
  promptVersion: "lang-review-explicit-v2",
  schemaVersion: "1",
}
```

策略版本化，prompt 和 schema 必须同版本更新。

### 缺失什么

| 缺失维度 | 说明 | 具体缺失 |
|---------|------|---------|
| **业务口径** | 什么是"good translation"没有正式定义 | 只有 `ReviewCategory` 枚举（correctness/translation/terminology/security/performance/maintainability），但缺少每个维度的评级标准定义 |
| **关联规则** | 术语间、模组间、版本间的关联规则 | `TermAsset` 的 `difficultTerms` 和 `consistencyCandidates` 基于启发式规则，但关联规则本身（如"模组 A 依赖模组 B 时，翻译应一致"）没有表达 |
| **维度边界** | 审查范围、版本兼容性、模组依赖的维度 | ReviewRun 的 scope 固定了 repo/PR/SHA，但缺少模组版本、游戏版本、依赖树等维度信息 |
| **指标定义** | 翻译质量的可量化指标 | 没有像 BLEU、COMET 或自定义的翻译质量评分体系。当前只有 `severity: "info" | "warning" | "error"` 三档定性评价 |
| **历史语义** | 跨 PR、跨版本的审查历史 | `discoveredTerms` 在 TermAsset 中预留但标记为"populated post-lang"，未实现；PR 间的翻译历史没有关联 |
| **英文响应原文** | 模型原始意见不暴露给裁决 | 目前 `ModelOpinionEntry` 只包含 `modelId/severity/explanation/suggestion`，但 Spec 中要求"模型原始输入、原始响应和全部舍弃意见原样永久保存"（§2.14） |

### 改进建议

1. **补充业务口径定义**：创建 `TranslationQualityMetric` 类型，定义各维度的评级标准（如：术语一致性=严格/宽松、语法正确性=完整/部分/错误），挂载到 ReviewRun 中。
2. **实现 `discoveredTerms` 的自动填充**：在 lang 阶段完成后，从模型 findings 中提取新术语回填到 TermAsset。
3. **引入跨 PR 语义关联**：在 `_shared/types.ts` 或 `client/` 中建立 `TranslationHistory` 类型，记录同一 key 在多个 PR 中的翻译演变。
4. **确保模型原始响应持久化**：`ReviewAttempt` 已有 `rawResponseArtifactId` 字段，但需确认 `worker-runner.ts` 实际写入该 artifact（当前实现可能是增量迁移中）。

---

## 共识三：生成过程必须有中间态（DSL/action声明/Skill，模型负责理解，引擎负责执行）

**评级: ✅ 已覆盖**

### 证据

**1. Flow 引擎 — 模型理解、引擎执行**（`src/engine/execute.ts`）

```
Agent (模型理解) → flowToAgentTool (声明式 Tool 调用) → executeFlow (引擎执行)
```

- Agent 通过 ReAct loop 选择 Tool、构造参数 → `flowToAgentTool` 处理 scope 校验和风险确认 → `executeFlow` 执行完整的生命周期（输入校验、超时、重试、幂等、NDJSON 记录）。
- **模型不直接执行 I/O**，只负责"理解业务意图并选择正确的 Flow"。
- 引擎负责：TypeBox 输入校验、风险策略、超时与取消信号、重试和退避、幂等性（FileStore 双检锁）、NDJSON 执行记录。

**2. Skill — 版本化行为指令**（`src/agent/session-manager.ts` `buildTranslationReviewSkill()`）

```typescript
function buildTranslationReviewSkill(): string {
  return `## 翻译审查 Skill v1
### 默认顺序
1. 准备 — 调用 review_prepare 创建或恢复 ReviewRun
2. 术语 — 调用 review_terms_prepare 固化和注入术语资产
3. Lang 审查 — 调用 review_lang_start 启动异步批量审查作业
4. 等待作业 — 使用 review_run_get 检查作业完成状态
5. 分页裁决 — 调用 review_run_get_candidates 读取聚类候选
6. 报告 — 调用 review_report_finalize 保存正式报告
7. 发布 — 只有在管理员明确要求且在配置启用时调用 review_publish
`;
}
```

- Skill 是版本化、可注入的 DSL，描述"做什么"而非"怎么做"。
- Skill 不是权限边界，也不是完成性事实源（`08-translation-review-agent.md` §3.2）。
- 程序不硬编码全局工作流；Agent 可以根据任务调整、重跑或计划性跳过步骤。

**3. ReviewRun 状态机 — 中间态持久化**（`src/agent/review-run/types.ts`）

```typescript
type ReviewRunStatus =
  | "created" | "preparing" | "running" | "waiting_agent"
  | "blocked" | "report_ready" | "completed" | "aborted";

type ReviewStageStatus =
  | "pending" | "running" | "waiting_agent" | "blocked" | "completed" | "planned_skipped";
```

- 每个审查阶段有独立状态，支持"等待 Agent 裁决"（`waiting_agent`）和"blocked"状态。
- Coverage manifest 记录每个 unit 的逐模型完成情况。
- ReviewAttempt 记录每个 batch×model 的完整执行状态和执行结果。

**4. 异步 Job 与事件通知**（`src/agent/review-run/job-manager.ts`）

- `ReviewJobManager` 支持 batch×model 并发执行，每个 provider 有并发限制。
- `ReviewJobEventEmitter` 提供完成/失败/blocked 事件。
- `resumeFromReviewEvent()` 通过系统消息唤醒 Session，agent 检查 coverage 后决定下一步。

**5. 中间态的可恢复性**

- ReviewRun 全部持久化（文件存储），包含 revision 乐观锁。
- `SessionService.ensureLoaded()` 在首次访问时惰性加载会话到内存 Map；启动时不做全量加载（cold start O(1)）。
- 幂等性通过 FileStore 双检锁实现，重试自动回退到缓存结果。

### 缺失什么

1. **ReviewRun 状态机未完全实现**：`09-translation-review-delta.md` 指出当前 Session 支持 `created/running/waiting_confirmation/completed/failed/aborted/timeout`，但 ReviewRun 的完整状态机（`waiting_agent`、`blocked`、`report_ready`）和 stages 的 `planned_skipped` 是目标状态，部分阶段可能尚未完全迁移。
2. **Skill 当前是硬编码字符串**：`buildTranslationReviewSkill()` 在 `session-manager.ts` 中作为函数返回字符串，尚未实现可插拔、可版本化管理的 Skill 加载器（如从文件/配置动态加载）。
3. **异步作业唤醒机制是乐观的**：`resumeFromReviewEvent()` 通过 SSE 广播，但没有 watchdog 或超时重试机制保证不可达事件不会导致 Session 永久卡在 `waiting_agent`。

### 改进建议

- 实现 Skill 的版本化加载器（如 `docs/skills/` 目录 + 运行时加载），取代硬编码字符串。
- 为 `waiting_agent` 状态添加超时降级机制：超时后自动标记为 `blocked` 并通知管理员。
- 完成 ReviewRun 状态机全部阶段的迁移，确保 `planned_skipped` 和 `report_ready` 状态正确转换。

---

## 共识四：系统必须给 AI 装上护栏（权限、白名单、逻辑校验、评测回归、后置兜底）

**评级: ✅ 已覆盖（部分领域有提升空间）**

### 证据

**1. 风险分级权限**（`src/types.ts` + `flow-architecture-spec.md` §9）

| 风险等级 | 示例 | Agent 行为 |
|---------|------|-----------|
| `read` | PR、diff、文件查询 | 自动执行 |
| `review_write` | 发布普通审查评论 | 自动执行 |
| `repository_write` | 标签、commit/push、mapping | 等待管理员确认 |
| `destructive` | revert、删除、覆盖 | 等待管理员确认+精确目标展示 |

- `executeFlow` 中 `destructive` 风险直接禁止非 Agent 来源执行（`src/engine/execute.ts` L139-L147）。
- `flowToAgentTool` 中 `repository_write`/`destructive` 通过 `SessionService.registerAndAwaitConfirmation()` 实现确认绑定。

**2. 确认绑定**（`src/agent/session-service.ts`）

```typescript
// 确认四元组
sessionId + toolCallId + flowName + inputHash
```

- 输入变化后旧确认失效。
- 模型文本中的"已获批准"不构成确认。
- 确认绑定到确定的 toolCallId + flowName + inputHash，防止重放攻击。

**3. PR Scope 校验**（`src/agent/flow-adapter.ts`）

- 工具参数中的 `prNumber`、`baseSha`、`headSha` 必须与 Session 固定 scope 一致，否则返回 `SCOPE_VIOLATION` 错误。

**4. 输入/输出校验**（`src/engine/execute.ts`）

- 所有 Flow 通过 TypeBox 运行时校验输入和输出。
- 缓存结果也经过输出校验，发现损坏后抛出 `INVALID_INPUT`。
- 禁止 `Type.Any()` 作为 input/output schema。

**5. 幂等性**（`src/engine/execute.ts`）

- 写 Flow 必须提供业务幂等键。
- 双检锁保障并发安全。
- 重试要求幂等键已配置，否则抛出 `INVALID_INPUT`。
- 幂等命中返回第一次的结构化输出，不重复外部副作用。

**6. 超时与取消**（`src/engine/execute.ts`）

- 每个 Flow 可配置 `timeoutMs`。
- `AbortSignal` 组合：caller signal + timeout → child signal。
- 重试退避期间检测取消信号。

**7. 发布安全**（`flow-architecture-spec.md` §11）

- `review_publish` 发布前重新确认当前 PR head SHA，变化时返回 `STALE_HEAD`。
- 验证 inline path/line 属于该 diff，无效位置降级到 summary。
- 按 finding fingerprint 去重。
- `REVIEW_PUBLISH_ENABLED=false` 时审查 E2E 仅产生 review 结果，不写入 GitHub。

**8. 执行记录**（`src/engine/execute.ts`）

 - 每次 Flow 执行写入 NDJSON 记录到 `runtime/ops/executions/{id}.ndjson`。
- 记录包含输入、输出、错误、耗时、来源、调用链。
- 写入失败仅记录日志，不影响 Flow 执行结果。

**9. 合约测试**（`src/__tests__/flow-contracts.test.ts`）

- 12 项 Flow 引擎契约测试：输入校验、输出校验、风险策略、超时、取消、幂等。
- 架构边界集成测试（`integration.test.ts`）、webhook 加固测试（`webhook-hardening.test.ts`）、CSRF 测试。

### 缺失什么

| 缺失领域 | 说明 |
|---------|------|
| **评测回归** | 没有自动化评测集来验证 LLM 审查质量退化。没有 golden dataset 对比新模型 vs 旧模型的审查一致性。 |
| **白名单** | 当前所有注册 Flow 均暴露给 Agent（`session-manager.ts` L196: `registry.list().map(...)`）。tag 仅用于分类和可观测性，未作为权限系统使用。虽然架构文档说明"当前阶段全部暴露"，但生产环境缺少按 tag 或角色过滤的机制。 |
| **后置兜底** | 对于 Agent 误操作（如发布了错误的评论），没有自动撤销或回滚机制。`git_revert_commit` 是手动 Flow，需要管理员确认。 |
| **速率限制** | 没有对 Agent 调用 Flow 的频率或并发数做硬限制。Session 层面有 `mutationQueues` 串行化写操作，但读操作无限制。 |
| **审计日志** | NDJSON 执行记录是技术日志，缺少面向管理员的审计视图（如"谁在什么时候确认了什么操作"）。 |
| **模型输出 Schema 校验** | `ReviewAttempt` 有 `resultArtifactId` 但未确认 `worker-runner.ts` 是否对模型输出做完整的 schema 校验后才写入。 |

### 改进建议

1. **建立评测回归流水线**：创建 `golden/` 目录存放标定数据集，每次模型或 prompt 变更后自动运行差异化对比。
2. **实现 tag 白名单**：在 `flowToAgentTool` 或 `session-manager.ts` 中增加可配置的 tag 过滤策略，允许按角色/环境限制 Agent 可见的 Flow 集合。
3. **增加后置兜底 Flow**：`review_publish` 发布后如果发现错误，提供 `review_publish_rollback` Flow（含幂等保护）。
4. **审计日志增强**：在 `ExecutionRecord` 中增加 `confirmed_by` 字段，记录确认操作的管理员身份。
5. **Worker 输出校验**：确保 `worker-runner.ts` 对模型输出做 `TypeBox` 校验，失败时标记 attempt 为 `failed` 而非 `completed`。

---

## 共识五：这是一场长期治理，而非一次性项目

**评级: ⚠️ 部分覆盖**

### 证据

**1. 架构设计明确支持演化**

- **Flow 注册表 + 工厂模式**：Flow 通过 `createAllPublicFlows()` 工厂构造，依赖注入清晰，新增 Flow 只需新增模块和注册。
- **版本化 Schema**：`ReviewRun.schemaVersion: 1`、`TermAsset.schemaVersion: 1`、`CoverageManifest.schemaVersion: 1`、`StoredReport.schemaVersion: 1`，支持 schema 平滑升级。
- **版本化 Skill**：`buildTranslationReviewSkill()` 是 v1，文档明确 Skill 是版本化行为指令。
- **版本化 Worker Policy**：`lang-explicit-v1`、`lang-findings-only-v1`，prompt 和 schema 同版本更新。
- **Delta 规范**：`09-translation-review-delta.md` 明确规划了从当前实现到目标规范的迁移路径，clean cutover 策略。

**2. 文档体系完整**

- 9 份规范文档（`01-orchestration.md` ~ `09-translation-review-delta.md`）
- `AGENTS.md` 作为完整架构文档
- `flow-architecture-spec.md` 定义架构边界
- `flow-authoring-guide.md` 指导 Flow 开发

**3. 持久化基础设施**

- 全部运行时数据存储在文件系统，无数据库依赖，便于备份和迁移。
- NDJSON 执行记录追加写入，O(1) append，可做历史分析。
- ReviewRun 使用 revision 乐观锁，支持并发安全写入。
- Artifact 存储保留所有原始模型输入/输出。

**4. 错误码体系**

```typescript
type FlowErrorCode =
  | "INVALID_INPUT" | "SCOPE_VIOLATION" | "CONFIRMATION_REQUIRED"
  | "STALE_HEAD" | "CONFLICT" | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE" | "TIMEOUT" | "FAILED";
```

统一的错误码体系，支持机器可读的错误处理。

### 缺失什么

| 缺失领域 | 说明 |
|---------|------|
| **Schema 迁移工具** | 虽然有 `schemaVersion` 字段，但没有迁移脚本或版本升级流程。当前 schema 升级意味着丢弃旧数据或手动迁移。 |
| **数据治理策略** | 运行时数据不断增长（`runtime/` 下执行记录、缓存、审查构件），没有数据保留策略、归档机制或过期清理规则。当前只有 `cron-tasks/` 中的 `cleanup` 任务，但未明确其治理范围。 |
| **监控与告警** | 没有系统健康度指标（如 Flow 执行成功率、平均耗时、Agent 误报率）。NDJSON 日志有足够数据，但没有度量聚合。 |
| **A/B 测试框架** | 无法对比不同 WorkerPolicy、不同模型组合、不同 Skill 版本的审查效果。没有实验框架。 |
| **反馈闭环** | 缺少"管理员对审查结果的反馈 → 改进 TermAsset/WorkerPolicy → 验证改进效果"的闭环设计。`TermAsset.discoveredTerms` 本是反馈入口，但尚未实现。 |
| **版本回滚** | Flow 注册表、WorkerPolicy、Skill 没有版本回滚机制。升级失败后只能回退代码。 |
| **团队协作** | 没有多人协同编辑 TermAsset 或 WorkerPolicy 的流程。当前是单实例部署，配置变更通过代码修改。 |

### 改进建议

1. **创建 Schema 迁移框架**：在 `ReviewRunStore` 中增加 `migrate(record)` 方法，根据 `schemaVersion` 自动升级旧数据。记录迁移日志。
2. **实现数据生命周期管理**：定义 `runtime/` 下各目录的保留策略（如：执行记录保留 90 天，审查构件保留 180 天，缓存 7 天），由 `cron-tasks/cleanup` 统一执行。
3. **建立度量仪表板**：利用 NDJSON 执行记录，在前端 /admin 页面增加 Flow 执行统计（成功率、平均耗时、错误分布）。
4. **设计实验框架**：允许在 `ReviewRun` 中指定实验标签（`experimentId`），以便对比不同 WorkerPolicy 或模型组合的审查效果。
5. **实现反馈闭环**：在 `CandidateDecisionEntry` 中增加 `adminFeedback` 字段，管理员可标记"模型误报"或"模型遗漏"，定期分析改进 TermAsset 和 WorkerPolicy。

---

## 综合评级汇总

| 共识 | 评级 | 核心证据 |
|------|------|---------|
| **1. 起点必须是业务概念** | ✅ 已覆盖 | Flow 作为一等业务抽象，`_shared` 纯算法层、`client` 外部系统层严格分离，webhook DTO 只保留业务字段 |
| **2. 语义资产必须包含暗知识** | ⚠️ 部分覆盖 | TermAsset 封装了术语暗知识，ReviewRun 保留覆盖和分歧，但缺少业务口径定义、跨 PR 语义关联、翻译质量指标和反馈闭环 |
| **3. 生成过程必须有中间态** | ✅ 已覆盖 | Flow 引擎（模型理解→引擎执行）、Skill 版本化指令、ReviewRun 状态机、异步 Job 和事件通知、幂等性和可恢复性 |
| **4. 系统必须给 AI 装上护栏** | ✅ 已覆盖 | 四层风险分级、确认绑定四元组、PR scope 校验、TypeBox 输入/输出校验、幂等性、超时/取消、12 项契约测试 |
| **5. 长期治理而非一次性项目** | ⚠️ 部分覆盖 | 版本化 Schema/Skill/Policy、Delta 规范、完整文档体系，但缺少 Schema 迁移工具、数据治理策略、监控、A/B 测试框架和反馈闭环 |

---

## 关键改进优先级

1. **P0 — 安全护栏完成**：Tag 白名单过滤、Worker 输出 Schema 校验、后置兜底 Flow
2. **P0 — 语义资产完善**：`discoveredTerms` 自动填充、`translation_analyze` 四值对齐迁移
3. **P1 — 长期治理基础设施**：Schema 迁移工具、数据生命周期管理、度量仪表板
4. **P1 — 评测回归**：Golden dataset + 自动化 diff 对比
5. **P2 — 反馈闭环**：管理员反馈→TermAsset/WorkerPolicy 改进→验证