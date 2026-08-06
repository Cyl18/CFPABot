# Flow 原子化与 Agent Tool 规范

## 1. 目的

本文定义 CFPAAgent 中以下边界：

- 什么应该是 Flow；
- 哪些 Flow 注册为 Agent Tool；
- webhook 如何组合 Flow；
- `flows/_shared` 与 `client` 的职责；
- Agent Review 与主 Bot 信息评论如何隔离；
- 为支持这些边界，现有 Flow Engine 最少需要调整什么。

当前 `src/flows/` 只有 README，没有历史 Flow 迁移负担。因此应直接实现最终边界，不保留 demo 中的 Composite Flow、通用 `postComment` 或 `commandRouter` 设计。

本文只定义架构边界；业务行为以源代码和 AGENTS.md 为准。

## 2. 已确认决策

1. Flow 有两条并列执行路径：程序编排和 Agent 编排；Agent 不是 Flow 的唯一入口。
2. 程序编排由 webhook、cron 或 API adapter 根据确定规则调用 `executeFlow()`。
3. Agent 编排由管理员 Session 中的 ReAct loop 自主选择 Tool，再由 Tool Adapter 调用同一个 `executeFlow()`。
4. Agent 运行本身只通过 Session 启动；这条约束只收口 Agent 生命周期，不限制程序调用 Flow。
5. Session 只有两个创建入口：
   - 管理员在 PR 评论中发送 `/agent <目标>`；
   - 管理员在前端 Chat 面板创建 Session。
6. 普通 PR webhook 执行程序编排，但不自动启动 Agent。
7. GitHub `/agent` 命令必须先创建 Session，再把 PR 编号、固定 base/head SHA 和命令正文交给 Agent。
8. Agent 默认负责 code review 和 translation review，不更新包含 Mod、构建产物和自动检查的主 Bot 信息评论。
9. 管理员 Session 可以使用所有已注册的原子 Flow；若后续模型表现不稳定，再按 tag 收窄。
10. `_shared` 和 client 永远不注册为 Tool。
11. 写操作按风险分级；普通审查评论可自动发布，仓库修改和破坏性操作需要管理员确认。
12. 当前生产按单实例运行；不为尚未出现的多实例场景引入数据库或分布式 Workflow 引擎。

## 3. 最终分层
```text
bootstrap/          依赖注入、Flow 注册、Hono App 创建、Bun.serve 启动
api/                HTTP、webhook、OAuth、SSE、DTO 转换、静态事件路由
agent/              Session、ReAct loop、prompt、Tool adapter、风险确认、审查工具
engine/             Flow 注册、schema 校验、统一执行、日志、超时
flows/              可独立执行的原子业务操作
flows/_shared/      无 I/O、无全局状态的纯算法
client/             GitHub、Git、CurseForge、Modrinth、外部缓存
```

系统存在两种编排者，但只有一个 Flow 执行内核：

```text
程序编排：Webhook / Cron / API
          → dispatch / handler
          → executeFlow()

Agent 编排（Flow 调用）：管理员命令 / 前端 Chat
            → SessionService
            → Agent → flowToAgentTool()
            → executeFlow()

Agent 编排（原生工具）：翻译审查等重 LLM 操作
            → SessionService
            → Agent → agent/tools/* (直接调用 LLM, 不经过 executeFlow)
```

`executeFlow()` 是 Flow 的唯一执行入口；Session 只是 Agent 的唯一启动入口。两者不得混淆。

当前不增加独立 `workflows/` 层。

原因：现有 webhook 编排只有 `dispatch.ts` 一个消费者，事件到 Flow 的映射是短小、静态、确定性的。增加 `workflows/webhook/*.ts` 只会把几行 `executeFlow()` 调用分散到更多文件，并没有复用或状态价值。

当且仅当满足以下任一条件时，再提取 Workflow 抽象：

- 同一编排被 webhook、cron、API 等多个入口复用；
- 编排存在基于前一步输出的复杂分支或补偿；
- 需要以整体对象持久化进度、恢复执行或展示状态。

在此之前，`api/webhook/dispatch.ts` 负责外部编排：只做事件匹配、DTO 构造和 `executeFlow()` 调度，不做业务计算，不直接调用 client。

## 4. Flow 的定义

Flow 是一个可独立执行、校验、记录和授权的业务操作。

一个模块只有同时满足以下条件，才定义为 Flow：

1. 名称表达业务意图，而不是技术动作；
2. 有明确、稳定、可 JSON 序列化的输入输出；
3. 可以单独执行，不依赖调用者补做隐藏步骤；
4. 自己维护该业务动作需要的不变式；
5. 值得成为 Agent 的一个决策动作，或值得被 webhook/API 独立调用；
6. 外部副作用和风险可以准确描述。

### 4.1 是 Flow

```text
pr_get_context
translation_analyze
review_publish
info_comment_refresh
labels_sync
files_move_project
git_revert_commit
```

### 4.2 不是 Flow

```text
escapeMarkdown             纯函数，放 _shared
parseModPath               纯函数，放 _shared
githubCreateComment        client 技术方法
saveContext                store 技术方法
postComment                缺少评论领域约束的通用写操作
onPrOpened                 webhook 事件编排
commandRouter              入站命令路由
triggerAgentReview         Session 创建，不是业务 Tool
buildArtifactSegment       只服务信息评论的内部步骤
```

### 4.3 Flow 不直接调用 Flow

禁止：

```typescript
await anotherFlow.execute(ctx, input);
```

固定组合由 `dispatch.ts` 或其他入站 adapter 调用统一执行入口；动态组合由 Agent 连续调用 Tool。

Flow 内可以：

- 调用多个 client 方法完成自己的业务动作；
- 调用同领域 `_internal` helper；
- 调用 `_shared` 纯函数；
- 在自身边界内进行 retry、cleanup 和业务校验。

“Flow 不调用 Flow”不是要求每个 Flow 只能调用一次 API。一个原子 Flow 可以执行多个 I/O，只要它们共同完成一个闭合业务动作。

## 5. Flow 接口

TypeBox 是 schema 的唯一来源。删除 `parameters + inputSchema + jsonSchemaToTypeBox` 的双轨设计。

Flow name 会直接传给 LLM provider，必须只使用字母、数字和下划线，长度不超过 64；统一采用 snake_case，不使用 `domain.action` 点号。

```typescript
import type { Static, TSchema } from "typebox";


export type FlowRisk =
  | "read"
  | "review_write"
  | "repository_write"
  | "destructive";

export type FlowEffect =
  | "github_read"
  | "github_comment_write"
  | "github_metadata_write"
  | "github_check_write"
  | "github_workflow_write"
  | "git_commit"
  | "git_push"
  | "storage_write"
  | "external_write";

Effects 是描述性的（informational），用于文档和 Agent 透明度。风险等级（risk）由引擎在 Agent 调用路径上强制执行。Effects 不影响程序编排路径的执行策略。

export interface Flow<
  InputSchema extends TSchema = TSchema,
  OutputSchema extends TSchema = TSchema,
> {
  name: string;
  description: string;
  input: InputSchema;
  output: OutputSchema;
  meta: {
    tags: readonly string[];
    risk: FlowRisk;
    effects: readonly FlowEffect[];
    timeoutMs?: number;
    retry?: { maxAttempts: number; backoffMs: number };
    idempotencyKey?: (
      invocation: InvocationMeta,
      input: Static<InputSchema>,
    ) => string;
  };
  execute(
```

规则：

- `description` 必须写清业务结果和主要副作用；
- `input` 和 `output` 禁止 `Type.Any()`；
- 写 Flow 必须声明 `effects`；
- 可重试的写 Flow 必须提供业务幂等键；
- output 必须是业务结果，不返回 Octokit response、Response、Buffer 或 class instance；
- Flow input 不接收原始 webhook payload；
- `retry.maxAttempts > 1` 只用于幂等调用。

## 6. FlowContext 的最小调整

不需要立即引入完整权限框架，但必须移除 Flow 对 `event.raw` 的依赖，并给执行记录提供稳定来源和 PR scope。

export interface FlowContext {
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  actor: {
    kind: "admin" | "system";
    login?: string;
  };
  scope: {
    prNumber?: number;
    baseSha?: string;
    headSha?: string;
  };
  invocation: {
    id: string; // crypto.randomUUID()
    source: "agent" | "webhook" | "api" | "cron";
    sessionId?: string;
    parentId?: string;
    deliveryId?: string;
  };
  github: GitHubClient;
  store: FileStore;
  logger: Logger;
  config: EntryConfig;
  state: ScopedState;
  signal: AbortSignal; // caller-supplied per-invocation cancellation; webhook creates detached controller; engine derives child signal combining this with timeoutMs
}

说明：

- 目前只有 GitHubClient 是普遍依赖，不强制先把所有 client 聚合进 `ctx.clients`；Flow 可通过明确构造依赖或后续扩展 context 获得其他 client。
- webhook adapter 把 payload 转换成稳定 DTO；Flow 不读取 `event.raw`。
- PR Session 固定 `prNumber/baseSha/headSha`。
- Agent Tool input 若再次提供 PR 编号，adapter 必须校验它与 Session scope 一致。
- Webhook、cron、API 程序编排使用 `system` actor；不存在独立的 `webhook` actor kind。
- `signal` 是 caller 提供的外部取消信号，每次调用独立创建。Webhook adapter 创建 detached AbortController，不传入 HTTP request signal。`executeFlow` 将 caller signal 与 `timeoutMs` 合并推导出 child signal 传递给 Flow。
## 7. 统一执行入口

所有生产调用必须经过 `executeFlow()`。除 Flow 自身单元测试外，不直接调用 `flow.execute()`。

```typescript
executeFlow(flow, ctx, input): Promise<output>
```

实现模块（`src/engine/`）:

1. `validate.ts` — TypeBox input/output 运行时校验（`decodeOrThrow`）
2. `execute.ts` — 统一执行入口：输入校验 → 风险策略检查 → 幂等检查 → 执行 → 输出校验 → NDJSON 记录
3. `timeout.ts` — 超时与 `AbortSignal` 合并：child signal = AbortSignal.timeout(timeoutMs) 与 caller signal 的任意一个先触发
4. `idempotency.ts` — 可重试写操作的幂等查询和结果保存（FileStore 双检锁）
5. `retry.ts` — 重试策略（退避 + 可取消）
6. `record.ts` — NDJSON 执行记录写入 `runtime/ops/executions/{id}.ndjson`

不需要先实现通用 Workflow 状态机或分布式事务。

建议错误码：

```text
INVALID_INPUT
SCOPE_VIOLATION
CONFIRMATION_REQUIRED
STALE_HEAD
CONFLICT
UPSTREAM_RATE_LIMITED
UPSTREAM_UNAVAILABLE
TIMEOUT
FAILED

结构化领域错误使用 `PublicError`：

```typescript
interface PublicError {
  code: string;           // 机器可读错误码
  publicMessage: string;  // 可进入评论的中文消息
  retryable: boolean;     // 重试是否可能成功
  cause?: unknown;        // 仅进脱敏日志
}
```
当前 `store.ts` 已经使用临时文件加 rename 写 JSON，并对 NDJSON append 做了单进程队列，不需要重写整个存储层。新增幂等或审批记录时复用 `FileStore`；只有共享可变记录需要 revision，不要求所有 JSON 一次性改成 VersionedRecord。

## 8. Flow 注册与 Agent Tool

### 8.1 注册原则

只有公开的原子 Flow 注册到 `FlowRegistry`。

不得注册：

- `_shared` 函数；
- client 方法；
- webhook handler；
- Session 操作；
- 领域 `_internal` helper；
- generic `postComment`；
- composite/event Flow。

### 8.2 Agent 可见性

当前阶段，管理员 Session 默认获得 Registry 中的全部 Flow。

现有 `session-manager.ts` 按固定 tag 白名单过滤 Tool 的逻辑应移除或改为可选策略。`tags` 用于描述、UI 分组和未来收窄，不在当前阶段代表权限。

Tool adapter 必须：

- 使用 Flow 的 TypeBox `input`；
- 调用 `executeFlow()`；
- 注入 Session invocation 和 `AbortSignal`；
- 绑定 PR scope；
- 执行风险确认；
- 把结构化 output 返回 Agent；
- 不包含 JSON Schema 转 TypeBox fallback。

## 9. 风险策略

| 风险 | 示例 | Agent 默认行为 |
|---|---|---|
| `read` | PR、diff、文件、术语、关联 PR 查询 | 自动执行 |
| `review_write` | 发布普通 `COMMENT` 类型审查评论 | 自动执行 |
| `repository_write` | 标签、Check Run、commit/push、mapping、workflow approval | 等待管理员确认 |
| `destructive` | revert、删除、覆盖、force push | 等待管理员确认并展示精确目标 |

第一版 Agent Review 不提供 `APPROVE` 或 `REQUEST_CHANGES` Flow，只发布普通审查评论。

确认由 Session 层处理，而不是每个 Flow 自行实现。确认必须绑定到确定的 `toolCallId + flowName + inputHash`。命令创建的 Session 可进入等待确认状态，由管理员在前端继续同一个 Session；确认不是新的 Agent 入口。

## 10. 首批 Flow 清单

### 10.1 P0：Agent Review

这些 Flow 先实现，用来打通 Session → Tool → Review 的完整链路。

| Flow | 风险 | 输入重点 | 输出重点 |
|---|---|---|---|
| `pr_get_context` | read | `prNumber` | PR 元数据、base/head SHA、文件清单 |
| `pr_get_diff` | read | `prNumber`, cursor/path filter | 分页后的结构化 diff |
| `pr_read_file` | read | `prNumber`, ref, path | 固定 SHA 的文本内容和截断信息 |
| `translation_analyze` | read | `prNumber`, headSha, optional paths | 语言键变化、缺失项、翻译差异 |
| `translation_check_terms` | read | 结构化翻译项 | 术语 finding 与证据 |
| `pr_find_related` | read | project paths | 相关 open PR |
| `review_lang_start` | read | runId, assets, modelSet | 创建异步 batch×model 作业，多模型候选 |
| `review_manual_start` | read | runId, planId, assets, modelSet | 创建手册配对异步 batch×model 作业 |
| `review_publish` | review_write | 固定 head SHA、summary、findings | comment/review IDs、发布/跳过数量 |

### 10.2 P1：主 Bot 信息评论与机械 webhook

这些 Flow 由 `dispatch.ts` 确定性调用，不启动 Agent；因为它们仍是完整业务操作，也注册到 Registry，管理员 Agent 可以按风险策略调用。

| Flow | 触发 |
|---|---|
| `packer_auto_approve` | PR opened/synchronize，显式安全判断后批准 PR Packer |
| `info_comment_refresh` | PR opened/synchronize |
| `info_comment_refresh_artifacts` | PR Packer workflow completed |
| `info_comment_force_refresh` | 主评论刷新复选框 |
| `checks_run_label_guard` | opened/synchronize/edited/labeled/unlabeled |
| `labels_sync` | opened/synchronize/edited |
| `pr_cache_refresh` | opened/synchronize/closed |

`info_comment_refresh_artifacts` 是独立 Flow：输入 `prNumber/workflowRunId/headSha`，只更新构建产物状态，不通过 mode 参数偷渡成完整刷新。

Agent Review 不读取主信息评论 Markdown 或 Context。若需要 workflow/check 状态，应增加对应事实源的只读 Flow，而不是增加 `info_comment_read`。

### 10.3 P2：管理员修改操作

| Flow | 风险 |
|---|---|
| `files_move_project` | repository_write |
| `files_rename` | repository_write |
| `files_fetch_en_us` | repository_write |
| `files_replace_text` | repository_write |
| `files_sort_keys` | repository_write |
| `files_format` | repository_write |
| `git_revert_commit` | destructive |
| `coauthor_add` | repository_write |
| `mapping_add` | repository_write |

每个文件或 Git Flow 必须在一次调用内完成验证、隔离 workspace、修改、diff 检查、commit/push 和 cleanup。不得暴露会留下半成品 workspace 的 `file_write` 或 `git_push` 原语。

## 11. Agent Review 评论契约

Agent 不直接调用 generic comment API。`review_publish` 接受结构化输入：

```typescript
interface ReviewDraft {
  prNumber: number;
  headSha: string;
  kind: "code" | "translation" | "mixed";
  summary: string;
  findings: ReviewFinding[];
}

interface ReviewFinding {
  fingerprint: string;
  category:
    | "correctness"
    | "translation"
    | "terminology"
    | "security"
    | "performance"
    | "maintainability";
  severity: "info" | "warning" | "error";
  title: string;
  explanation: string;
  evidence: string;
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  suggestion?: string;
}
```

发布规则：

1. marker 使用 `<!-- CFPABOT:AGENT_REVIEW session=... head=... -->`；
2. 不搜索或更新 `<!--CYBOT-->` 主信息评论；
3. 发布前重新确认当前 PR head SHA；变化时返回 `STALE_HEAD`；
4. 验证 inline path/line 属于该 diff；无效位置降级到 summary；
5. 按 finding fingerprint 去重；
6. 普通 Flow 只发布 GitHub Review `COMMENT`；
7. 重试不得生成重复评论。

推荐幂等键：

```text
review_publish:{repo}:{prNumber}:{headSha}:{sessionId}:{draftHash}
```

## 12. Session 入口

### 12.1 GitHub 命令

仅处理目标仓库 PR 上新建评论的首个非空行：

```text
/agent <目标>
```

流程：

1. receiver 验证 HMAC、仓库和 delivery 去重；
2. adapter 验证这是 PR comment；
3. 通过 GitHub API 查询作者实际仓库权限；只有 admin 可以继续；
4. 获取 PR base/head SHA；
5. SessionService 创建新的 review Session；
6. Session 保存来源 comment ID、管理员、PR 和固定 SHA；
7. SessionManager 启动 Agent。

`issue_comment.edited` 不创建 Session。普通 PR 事件不创建 Session。

### 12.2 前端 Chat

- Session API、消息、SSE、abort 和未来确认 API 全部要求管理员；
- 路由只调用 SessionService，不直接调用 `agentSessionManager.startSession()`；
- 前端可创建带 PR scope 或普通 chat scope 的 Session；
- 恢复 Session 时沿用创建时 principal 和 scope。

### 12.3 SessionService

SessionService 是 Agent 唯一入口，负责：

- 管理员校验结果；
- Session scope 和固定 SHA；
- 创建/继续/中止；
- 风险确认；
- Session 持久化；
- 调用 SessionManager。

SessionManager 只负责 ReAct loop、模型、消息和 SSE，不负责 HTTP 身份判断。

## 13. Webhook 编排

`api/webhook/dispatch.ts` 保留为唯一静态事件路由：

```typescript
switch (dto.type) {
  case "pull_request.opened":
    await executeFlow("packer_auto_approve", ...);
    await Promise.all([
      executeFlow("info_comment_refresh", ...),
      executeFlow("checks_run_label_guard", ...),
      executeFlow("labels_sync", ...),
      executeFlow("pr_cache_refresh", ...),
    ]);
    break;

  case "issue_comment.created":
    await handleAgentCommand(dto, sessionService);
    break;
}
```

实际并行关系由业务依赖决定，不因示例中的 `Promise.all` 强制所有操作并行。

约束：

- dispatch 不读写业务文件；
- dispatch 不直接调用 GitHub、Git 或其他 client；
- dispatch 不生成评论正文；
- dispatch 不直接启动 SessionManager；
- dispatch 为本次事件创建 parent invocation ID；
- handler 超过约 30 行时可提取到 `api/webhook/handlers/`，但不定义为 Flow，也不新增 Workflow 层。

现有 route 中模块级可变依赖后续应改为 router factory 或不可变 deps 对象，但这不是确定 Flow 边界的前置条件。

## 14. `_shared` 边界

允许：

- `parseModPath`；
- `LangFile` 解析；
- `LangDiffer` 纯 diff；
- term matching；
- Markdown escape/render；
- finding fingerprint；
- MoA 候选合并算法。

禁止：

- `fetch`、Octokit、Bun.spawn、Bun.file、node:fs；
- 模块级可变 cache；
- FlowContext；
- Session；
- 注册表；
- logger；
- 当前时间、随机数、环境变量；
- GitHub 权限判断。

旧仓库迁移 `analysis/`、`term/`、`diff/`、`comment/`、`llm-review/` 时逐文件审计：

- 纯算法进入 `_shared`；
- 外部 I/O 和派生 cache 进入 `client`；
- 只服务单个领域的编排进入该领域 `_internal`。

如果 Agent 需要调用某个纯算法，不注册 `_shared` 函数；创建一个具有业务 schema 的薄 Flow 包装该算法。

## 15. 与当前代码的直接变更

### 必须调整

- `src/types.ts`
  - TypeBox 单一 schema；
  - 增加 risk/effects/idempotency；
  - FlowContext 增加 actor/scope/invocation/signal；
  - 删除 Event raw 对 Flow 的传播。
- `src/engine/execute.ts`
  - `executeWithLogging` 收口为 `executeFlow`；
  - 增加 schema、风险、timeout、幂等和 output 校验。
- `src/agent/flow-adapter.ts`
  - 删除 `jsonSchemaToTypeBox`；
  - 绑定 Session scope；
  - 统一调用 `executeFlow`。
- `src/agent/session-manager.ts`
  - 默认使用所有注册 Flow，不再用硬编码 tag 白名单表达权限；
  - prompt 和 scope 由 SessionService 提供。
- `src/api/sessions.ts`
  - 不直接操作 manager；
  - 增加 admin-only SessionService。
- `src/api/webhook/dispatch.ts`
  - 从空壳实现静态 DTO → Flow/Session 路由。
- `src/api/webhook/receiver.ts`
  - 不再构造带 raw payload 的 FlowContext；
  - 保持 HMAC 和仓库校验。
- `src/flows/README.md` 与 `docs/flow-authoring-guide.md`
  - 删除 Composite Flow 和 Flow 直接调用 Flow 的示例。

### 保留

- webhook 位于 `api/webhook/`；
- FlowRegistry 显式注册；
- NDJSON 执行记录；
- `store.ts` 的临时文件 rename 和 append 队列；
- client 作为外部 I/O 层；
- SessionManager 的 ReAct loop、SSE 和 Agent 复用机制。

## 16. 实施顺序

1. 固定本文 Flow 清单和命名，更新 Flow README/authoring guide。
2. 重写 Flow 类型和 `executeFlow()`，只做 schema、timeout、日志和基础风险 hook。
3. 实现 `pr_get_context`、`pr_get_diff`、`pr_read_file`，打通只读 Tool。
4. 收口 SessionService、管理员鉴权和固定 PR scope。
5. 实现 `/agent` webhook command 创建 Session。
6. 实现 translation/term/MoA Review Flow。
7. 实现结构化 `review_publish` 和独立 marker，完成首个端到端 Agent Review。
8. 在第一个 `repository_write` Flow 上实现确认机制，不提前建设通用审批平台。
9. 实现主信息评论和机械 webhook Flow，由 dispatch 直接编排。
10. 按实际需求实现文件、Git、mapping 等高风险 Flow。
11. 从旧仓库迁移并审计 `_shared` 纯算法。

## 17. 验收标准

- Registry 中每一项都是可独立描述的原子业务操作；
- 没有 `onPrOpened`、`postComment`、`commandRouter`、client wrapper 类型的 Flow；
- Flow 之间没有直接 `.execute()`；
- 所有生产 Flow 调用经过 `executeFlow()`；
- 所有 Flow 只维护一套 TypeBox schema；
- 管理员 Agent 可以发现所有已注册 Flow；
- `_shared` 没有 I/O、全局状态或 FlowContext；
- 非管理员无法创建、继续、查看或批准 Session；
- `/agent` 每个新评论最多创建一个固定 SHA Session；
- 普通 PR webhook 不启动 Agent；
- Agent Review 不更新 `<!--CYBOT-->` 主评论；
- head SHA 变化时不发布旧 inline comment；
- 普通 review comment 自动执行，高风险 Flow 等待管理员确认；
- webhook 的静态编排留在 dispatch/handler，不需要独立 Workflow 层。
