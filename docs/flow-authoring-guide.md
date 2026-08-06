# Flow 编写指南

> **Flow 是 CFPAAgent 的核心业务单元。** 每个 Flow 是一个可独立执行、校验、记录和授权的原子业务操作，可以是 GitHub 交互、文件处理、LLM 调用或其他 I/O。架构边界和接口以 [`flow-architecture-spec.md`](./flow-architecture-spec.md) 为准。

---

## 1. Flow 接口定义

当前使用 **TypeBox v1** 作为 schema 的唯一来源。所有 Flow 用 `input`/`output` 属性定义结构化输入输出，不再使用 `inputSchema`/`outputSchema` 双轨设计。

```typescript
// src/types.ts
import type { TSchema, Static } from "typebox";

export type FlowRisk =
  | "read"                    // 只读查询
  | "review_write"            // 发布普通审查评论
  | "repository_write"        // 修改仓库内容（标签/commit/push）
  | "destructive";            // 破坏性操作（revert/删除/force push）

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

interface Flow<
  InputSchema extends TSchema = TSchema,
  OutputSchema extends TSchema = TSchema,
> {
  name: string;                                        // 唯一标识，snake_case
  description: string;                                 // 描述业务结果和主要副作用
  input: InputSchema;                                  // TypeBox 输入 schema
  output: OutputSchema;                                // TypeBox 输出 schema
  meta: {
    tags: readonly string[];                           // 工具过滤和分组标签
    risk: FlowRisk;                                    // 风险等级
    effects: readonly FlowEffect[];                    // 副作用声明（信息性）
    timeoutMs?: number;                                // 可选超时（毫秒）
    retry?: { maxAttempts: number; backoffMs: number };// 可选重试策略
    idempotencyKey?: (                                 // 可选幂等键函数
      invocation: InvocationMeta,
      input: Static<InputSchema>,
    ) => string;
  };
  execute(
    ctx: FlowContext,
    input: Static<InputSchema>,
  ): Promise<Static<OutputSchema>>;                    // 核心执行逻辑
}
```

**重要规则：**

- `description` 必须写清业务结果和主要副作用；
- `input` 和 `output` 禁止 `Type.Any()`；
- 写 Flow 必须声明 `effects`；
- 可重试的写 Flow 必须提供业务幂等键；
- output 必须是业务结果，不返回 Octokit response、Buffer 或 class instance；
- Flow input 不接收原始 webhook payload。

### FlowContext — 每次执行注入的上下文

```typescript
// src/types.ts
interface FlowContext {
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  actor: {
    kind: "admin" | "system";     // 调用者类型
    login?: string;
  };
  scope: {
    prNumber?: number;            // 关联 PR 编号
    baseSha?: string;             // 固定 base SHA
    headSha?: string;             // 固定 head SHA
  };
  invocation: {
    source: "agent" | "webhook" | "api" | "cron";
    id: string;                   // crypto.randomUUID()
    deliveryId?: string;
    sessionId?: string;
    parentId?: string;
  };
  github: GitHubClient;           // GitHub API 客户端（已认证）
  store: FileStore;               // 文件读写（read/write/append/list）
  logger: Logger;                 // Serilog 风格日志
  config: EntryConfig;            // 环境变量配置
  state: ScopedState;             // 请求内内存状态（跨Flow共享）
  signal: AbortSignal;            // 调用方提供的取消信号
}
```

**说明：**

- `actor.kind`：webhook/cron/API 使用 `"system"`；管理员 Session 使用 `"admin"`；
- `scope`：PR Session 固定 `prNumber/baseSha/headSha`，Agent Tool input 若提供 PR 编号必须与 scope 一致；
- `invocation`：每次执行生成唯一 ID；程序编排可设置 `parentId` 关联事件链；
- `signal`：由 `executeFlow()` 将调用方 signal 与 `timeoutMs` 合并派生 child signal 传入 Flow。

---

## 2. Flow 分类与职责

| 分类 | 目录 | 注册方式 | 典型操作 |
|---|---|---|---|
| **PR Query** | `src/flows/pr/*.ts` | bootstrap 遍历注册 | 获取上下文/详情/diff/文件列表/关联 PR |
| **Translation** | `src/flows/translation/*.ts` | bootstrap 遍历注册 | 翻译分析、术语检查、key 检查 |
| **Review** | `src/flows/review/*.ts` | bootstrap 遍历注册 | thread-reply, comment (完整审查管线已迁移到 agent/tools/) |
| **Info Comment** | `src/flows/info-comment/*.ts` | bootstrap 遍历注册 | 刷新主信息评论、构建产物 |
| **Checks** | `src/flows/checks/*.ts` | bootstrap 遍历注册 | Label 守卫检查 |
| **Labels** | `src/flows/labels/*.ts` | bootstrap 遍历注册 | 标签同步 |
| **Files** | `src/flows/files/*.ts` | bootstrap 遍历注册 | 移动/重命名/排序/格式化文件 |
| **Git** | `src/flows/git/*.ts` | bootstrap 遍历注册 | revert commit、添加 co-author |
| **Mappings** | `src/flows/mappings/*.ts` | bootstrap 遍历注册 | 添加 CurseForge 映射、未映射检查 |
| **Cache** | `src/flows/cache/*.ts` | bootstrap 遍历注册 | PR/Mod列表/映射缓存刷新、modlist 构建 |
| **Packer** | `src/flows/packer/*.ts` | bootstrap 遍历注册 | 自动批准 PR Packer |
| **Compare** | `src/flows/compare/*.ts` | bootstrap 遍历注册 | 获取源、运行对比、上传、special-diff、workspace |
| **Internal** | `src/flows/_internal/*.ts` | 不注册，import 使用 | 有 I/O 的领域内部复用逻辑 |
| **Shared** | `src/flows/_shared/*.ts` | 不注册，import 使用 | 纯计算/分析/格式化 |

**关键区分**：注册到 Registry 的 Flow 可被 Agent 作为工具调用，也可被 webhook/cron/API 通过 `executeFlow()` 调用。`_internal/` 是有 I/O 的可复用内部操作，不单独注册。`_shared/` 是纯函数库，不可被 Agent 或编排器直接调用。

---

## 3. 实际 Flow 示例 — `files_format`

以下是一个实际注册的 Flow，用于格式化 PR 中的语言文件：

### 源文件

```
src/flows/files/files_format.ts
```

### Flow 实现

```typescript
// src/flows/files/files_format.ts
// Flow: files_format — format language files to project conventions.
// Risk: repository_write | Effects: git_commit, git_push, github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import { formatLangFiles } from "./_internal/index.js";
import type { LanguageFileFormat } from "../_shared/types.js";

// ---- Input Schema (TypeBox) ----

export const files_format_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  paths: Type.Array(Type.String(), {
    description: "Language file paths to format (relative to repo root)",
  }),
  format: Type.Optional(
    Type.Union([Type.Literal("json"), Type.Literal("lang")], {
      description: "Force format type; auto-detected from extension by default",
    }),
  ),
});

export type FilesFormatInput = Static<typeof files_format_input>;

// ---- Output Schema (TypeBox) ----

export const files_format_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  formatted: Type.Number({ description: "Number of files formatted" }),
  skipped: Type.Number({ description: "Number of files already correctly formatted" }),
  failed: Type.Number({ description: "Number of files that could not be formatted" }),
});

export type FilesFormatOutput = Static<typeof files_format_output>;

// ---- Flow Definition ----

export const files_format: Flow<
  typeof files_format_input,
  typeof files_format_output
> = {
  name: "files_format",
  description:
    "Format language files (JSON or .lang) to project conventions within a PR branch. " +
    "JSON: 4-space indent, sorted keys, Unix newlines, trailing newline, string-only validation. " +
    ".lang: preserve comments, single blank line between blocks, trailing newline. " +
    "Uses withPrWorkspace for isolated clone → validate → format → diff → commit → push → cleanup.",
  input: files_format_input,
  output: files_format_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:format:${input.paths.join(",")}`,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_format_input>,
  ): Promise<Static<typeof files_format_output>> {
    const { prNumber, headSha, paths } = input;

    if (paths.length === 0) {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: "At least one file path is required",
        publicMessage: "You must specify at least one language file path to format.",
        retryable: false,
      });
    }

    const explicitFormat = input.format as LanguageFileFormat | undefined;
    const commitMessage = `Format ${paths.length} language file(s)`;

    let formatted = 0;
    let skipped = 0;
    let failed = 0;

    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_format",
        commitMessage,
      },
      async (handle) => {
        const output = await formatLangFiles(handle, paths, explicitFormat);
        formatted = output.results.filter((r) => r.formatted).length;
        skipped = output.skipped;
        failed = output.failed;
      },
    );

    if (result.skipped) {
      return { commitSha: "", formatted: 0, skipped, failed: 0 };
    }

    return { commitSha: result.commitSha, formatted, skipped, failed };
  },
};
```

### 注册方式

该 Flow 通过 `src/flows/files/index.ts` 导出：

```typescript
export { files_format } from "./files_format.js";
export type { FilesFormatInput, FilesFormatOutput } from "./files_format.js";
```

在 `src/flows/index.ts` 中通过总 barrel 导出并加入 `createAllPublicFlows()` 工厂：

```typescript
// src/flows/index.ts — 总 barrel
export { files_format } from "./files/index.js";

// createAllPublicFlows 工厂（用于 bootstrap 批量注册）
export function createAllPublicFlows(options?: CreatePublicFlowsOptions): Flow[] {
  return [
    // ... 其他 Flow ...
    files_format,
  ];
}
```

最后在 `src/bootstrap/flows.ts` 中统一注册：

```typescript
// src/bootstrap/flows.ts
const registry: FlowRegistry = createFlowRegistry();
const publicFlows: Flow[] = createAllPublicFlows(flowOptions);
for (const flow of publicFlows) {
  registry.register(flow);
}
setSharedRegistry(registry);
```

---

## 4. 编写规范

### 4.1 必须遵守

1. **所有 import 使用 `.js` 扩展名**（ESM 兼容）
   ```typescript
   // ✅
   import { parseProjectPath } from "../_shared/project-path/index.js";
   // ❌
   import { parseProjectPath } from "../_shared/project-path/index";
   ```

2. **错误必须被处理** — 不允许裸 `catch {}`
   ```typescript
   // ✅
   catch (err) {
     ctx.logger.warn({ err: String(err) }, "operation failed, skipping");
   }
   // ❌
   catch {}
   ```

3. **日志格式** — `{data}, "message"` (Serilog 风格)
   ```typescript
   // ✅
   ctx.logger.info({ prNumber, fileCount: files.length }, "files_check_format: 完成");
   // ❌
   console.log(`PR ${prNumber} refreshed`);
   ```

4. **使用 `@/types.js` 路径别名** — 不要用相对路径穿越多层目录
   ```typescript
   // ✅
   import type { Flow, FlowContext } from "@/types.js";
   // ❌
   import type { Flow, FlowContext } from "../../types.js";
   ```

5. **输入输出 Schema 和类型必须导出** — 便于 Agent 工具链和其他 Flow 引用
   ```typescript
   export const my_flow_input = Type.Object({ ... });
   export type MyFlowInput = Static<typeof my_flow_input>;
   ```

6. **写 Flow 必须声明 `meta.effects`** — 副作用描述信息性，用于文档和 Agent 透明度

7. **临时目录必须清理** — 工作目录用 OS tmpdir（`mkdtemp(join(tmpdir(), ...))`），在 `finally` 中 `rm`。不要写 repo 内的 `temp/flows/`（无 writer、无 cron 清理）。Git 变更优先用 `withPrWorkspace`（`src/flows/_internal/with-pr-workspace.ts`），它已封装分支锁 + clone + SHA 校验 + 清理。
   ```typescript
   import { mkdtemp, rm } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";

   const tmpDir = await mkdtemp(join(tmpdir(), `cfpa-workspace-${prNumber}-`));
   const release = await acquireLock(`git-workspace:${owner}/${repo}/${branch}`);
   try {
     // ... 操作 ...
   } finally {
     await rm(tmpDir, { recursive: true, force: true });
     release();
   }
   ```

### 4.2 命名约定

| 元素 | 规则 | 示例 |
|---|---|---|
| Flow name | snake_case，{domain}\_{verb} | `pr_get_context`, `files_check_format` |
| 文件名 | 与 Flow name 一致，snake_case | `files_check_format.ts` |
| Schema 变量 | `{flow_name}_input` / `{flow_name}_output` | `files_check_format_input` |
| Input 类型 | `{PascalFlowName}Input` | `FilesCheckFormatInput` |
| Output 类型 | `{PascalFlowName}Output` | `FilesCheckFormatOutput` |
| barrel 导出 | 使用 Flow 原名 | `files_check_format` |
| meta.tags | 小写，分类标识 | `["files", "format", "pr"]` |

### 4.3 meta.tags 标签体系

| 标签 | 含义 | Agent 是否可见 |
|---|---|---|
| `pr` | PR 相关查询 | ✅ |
| `query` | 数据查询 | ✅ |
| `review` | Agent Review 相关 | ✅ |
| `translation` | 翻译分析 | ✅ |
| `info-comment` | 主信息评论 | ✅ |
| `files` | 文件操作 | ✅ |
| `git` | Git 操作 | ✅ |
| `labels` | 标签操作 | ✅ |
| `cache` | 缓存管理 | ✅ |
| `mappings` | CurseForge 映射 | ✅ |
| `packer` | PR Packer | ✅ |

> 注意：当前阶段管理员 Session 默认获得 Registry 中的全部 Flow。`tags` 用于描述、UI 分组和未来收窄，不在此阶段代表权限。

### 4.4 风险与副作用声明

| 风险等级 | 程序编排 | 管理员 Agent | 示例 |
|---|---|---|---|
| `read` | 自动执行 | 自动执行 | `pr_get_context`, `files_check_format` |
| `review_write` | 自动执行 | 自动执行 | `review_comment`, `info_comment_refresh` |
| `repository_write` | dispatch 列出的 system Flow 自动 | 等待管理员确认 | `files_move_project`, `labels_sync` |
| `destructive` | 默认禁止 | 等待管理员确认并展示精确目标 | `git_revert_commit` |

**副作用（effects）** 是描述性的（informational），不影响执行策略，仅用于文档和 Agent 透明度声明。

### 4.5 日志级别使用

| 级别 | 场景 | 示例 |
|---|---|---|
| `debug` | 开发调试，生产不输出 | 详细数据 dump |
| `info` | 正常业务流程关键节点 | Flow 开始/完成 |
| `warn` | 可恢复的异常 | 文件读取失败但跳过 |
| `error` | 需要关注的错误 | GitHub API 失败 |

---

## 5. 常见模式

### 5.1 Content Flow（纯计算，无副作用）

```typescript
import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";

export const content_analyze_input = Type.Object({
  en: Type.String(),
  cn: Type.String(),
});

export type ContentAnalyzeInput = Static<typeof content_analyze_input>;

export const content_analyze_output = Type.Object({
  issues: Type.Array(Type.String()),
  score: Type.Number(),
});

export type ContentAnalyzeOutput = Static<typeof content_analyze_output>;

export const content_analyze: Flow<typeof content_analyze_input, typeof content_analyze_output> = {
  name: "content_analyze",
  description: "分析翻译内容质量",
  input: content_analyze_input,
  output: content_analyze_output,
  meta: {
    tags: ["content"],
    risk: "read",
    effects: [],
  },

  // 纯计算: 不使用 ctx.github / ctx.store，只用 _shared 纯函数
  execute(_ctx: FlowContext, input: ContentAnalyzeInput): Promise<ContentAnalyzeOutput> {
    const issues = checkTerms(input.en, input.cn);
    return Promise.resolve({ issues, score: calculateScore(issues) });
  },
};
```

### 5.2 GitHub API Flow（有副作用）

```typescript
import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";

export const pr_labels_add_input = Type.Object({
  prNumber: Type.Number({ description: "PR 编号" }),
  labels: Type.Array(Type.String(), { description: "标签名列表" }),
});

export type PrLabelsAddInput = Static<typeof pr_labels_add_input>;

export const pr_labels_add_output = Type.Object({
  added: Type.Number(),
});

export type PrLabelsAddOutput = Static<typeof pr_labels_add_output>;

export const pr_labels_add: Flow<typeof pr_labels_add_input, typeof pr_labels_add_output> = {
  name: "pr_labels_add",
  description: "给 PR 添加标签（调用 GitHubClient.addLabels）",
  input: pr_labels_add_input,
  output: pr_labels_add_output,
  meta: {
    tags: ["pr", "labels"],
    risk: "repository_write",
    effects: ["github_metadata_write"],
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_labels_add_input>): Promise<Static<typeof pr_labels_add_output>> {
    await ctx.github.addLabels(input.prNumber, input.labels);

    ctx.logger.info({ prNumber: input.prNumber, labels: input.labels }, "pr_labels_add: 标签已添加");
    return { added: input.labels.length };
  },
};
```
### 5.3 File Operation Flow（Git 操作）

生产中的文件/Git 变更 Flow 应使用 `withPrWorkspace` 助手（`src/flows/_internal/with-pr-workspace.ts`），而非手写 clone/commit/push/cleanup。它自动处理：

- 拉取 PR 获取实际 head ref（分支名）
- 在 `git-workspace:{owner}/{repo}/{branch}` 上获取锁（含分支，避免冲突）
- 在 OS tmpdir 中 clone/fetch 目标分支
- 验证 HEAD SHA 是否与预期一致
- 执行回调中的变更
- 检测是否有变化；无变化则返回 `{ skipped: true }`
- 用显式 commit message commit + push
- 在 `finally` 中清理临时目录并释放锁

```typescript
import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import { rename } from "node:fs/promises";
import { join } from "node:path";

export const files_move_project_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  sourceProjectPath: Type.String({
    description: "源项目路径（相对 repo 根）",
  }),
  targetProjectPath: Type.String({
    description: "目标项目路径（相对 repo 根，不能已存在）",
  }),
  commitMessage: Type.String({
    description: "Commit message",
  }),
});

export type FilesMoveProjectInput = Static<typeof files_move_project_input>;

export const files_move_project_output = Type.Object({
  commitSha: Type.String({ description: "提交 SHA" }),
  movedFiles: Type.Array(Type.String(), {
    description: "已移动的文件路径列表（相对 repo 根）",
  }),
});

export type FilesMoveProjectOutput = Static<typeof files_move_project_output>;

export const files_move_project: Flow<typeof files_move_project_input, typeof files_move_project_output> = {
  name: "files_move_project",
  description:
    "Move an entire project directory from sourceProjectPath to targetProjectPath " +
    "within a PR branch. Uses withPrWorkspace for isolated clone → move → commit → push → cleanup.",
  input: files_move_project_input,
  output: files_move_project_output,
  meta: {
    tags: ["files", "mutation", "repository_write"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "github_read"],
    timeoutMs: 120_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:move_project:${input.sourceProjectPath}:${input.targetProjectPath}`,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_move_project_input>,
  ): Promise<Static<typeof files_move_project_output>> {
    const { prNumber, headSha, sourceProjectPath, targetProjectPath, commitMessage } = input;

    let movedFiles: string[] = [];

    const result = await withPrWorkspace(ctx, {
      prNumber,
      expectedHeadSha: headSha,
      operationName: "files_move_project",
      commitMessage,
    }, async (handle) => {
      // handle.dir: OS tmpdir 下的工作目录（已 clone 目标分支）
      // 将源项目目录移动到目标位置
      await rename(join(handle.dir, sourceProjectPath), join(handle.dir, targetProjectPath));

      // 生产中使用 collectMovedFiles 记录实际移动的文件列表：
      // movedFiles = await collectMovedFiles(handle, sourceProjectPath, targetProjectPath);
    });

    if (result.skipped) {
      return { commitSha: "", movedFiles };
    }

    ctx.logger.info(
      { prNumber, sourceProjectPath, targetProjectPath, sha: result.commitSha },
      "files_move_project: 完成",
    );
    return { commitSha: result.commitSha, movedFiles };
  },
};
```

> **注意**：`withPrWorkspace` 定义在 `src/flows/_internal/with-pr-workspace.ts`，自动管理 OS tmpdir 生命周期、分支锁（键格式 `git-workspace:{owner}/{repo}/{branch}`）、SHA 校验、commit + push 和清理。生产中的文件/Git 变更 Flow 优先使用此助手，不应手写 clone/cleanupRepo。

---

## 6. executeFlow — 统一执行入口

所有生产调用必须经过 `executeFlow()`。除 Flow 自身单元测试外，不直接调用 `flow.execute()`。

```typescript
// src/engine/execute.ts
async function executeFlow<InputSchema extends TSchema, OutputSchema extends TSchema>(
  flow: Flow<InputSchema, OutputSchema>,
  ctx: FlowContext,
  input: Static<InputSchema>,
): Promise<Static<OutputSchema>>
```

**执行生命周期：**

1. **Input 校验** — 用 TypeBox schema 校验输入，失败抛出 `INVALID_INPUT` 并写入执行记录；
2. **重试策略解析** — 校验 `retry` 与 `idempotencyKey` 的一致性；
3. **风险策略检查** — `destructive` 级别的 Flow 非 agent 来源直接拒绝；
4. **幂等检查** — 若有 `idempotencyKey`，查询之前是否已执行过，命中则返回缓存结果；
5. **执行** — 调用 `flow.execute()`，支持重试和超时；
6. **Output 校验** — 用 TypeBox schema 校验输出；
7. **执行记录** — 写入 NDJSON 到 `runtime/ops/executions/`；
8. **统一错误** — 所有异常转为 `FlowError`（含 code/message/retryable）。

**超时与取消：** `executeFlow` 将调用方 `ctx.signal` 与 `flow.meta.timeoutMs` 合并为 child signal 传入 Flow。两者任一先触发即取消执行。

**幂等实现：** 使用文件缓存（`runtime/ops/idempotency/`）+ 进程内排重锁。首次执行将结果持久化；后续相同 key 的调用直接返回首次结果，不重复外部副作用。

---

## 7. Agent 工具集成

Flow 注册到 Registry 后，通过 `flowToAgentTool` 自动暴露给 Agent：

```typescript
// src/agent/flow-adapter.ts
function flowToAgentTool(
  flow: Flow,
  ctx: FlowContext,
  sessionService?: SessionService,
  sessionId?: string,
): AgentTool
```

**适配器职责：**

1. 使用 Flow 的 TypeBox `input` 作为唯一参数 schema；
2. 注入 Session actor、invocation 和 PR scope；
3. 验证输入参数与 Session scope 一致（PR/head SHA 冲突检查）；
4. 根据风险等级决定执行策略：
   - `read` / `review_write` → 自动执行；
   - `repository_write` / `destructive` → 等待管理员确认（通过 SessionService）；
5. 调用 `executeFlow()` 执行；
6. 将结构化 output/error 返回 Agent。

**确认机制：** 高风险操作绑定 `sessionId + toolCallId + flowName + inputHash`。管理员在前端确认后，适配器继续执行。输入变化后旧确认失效。

---

## 8. 禁止事项

| 禁止 | 原因 | 替代方案 |
|---|---|---|
| `as any` / `@ts-ignore` | 类型安全 | 使用精确类型或 `unknown` + 类型守卫 |
| 裸 `catch {}` | 静默吞错误 | 至少 `ctx.logger.warn({ err }, "...")` |
| `console.log` | 不统一 | 使用 `ctx.logger` |
| 在 Flow 之外操作 `process.env` | 难以测试 | 通过 `ctx.config` 传递配置 |
| 直接调用另一个 Flow 的 `.execute()` | 绕过执行日志和校验 | 通过 `executeFlow()` 调用 |
| 在 `_shared/` 中使用 `FlowContext` | 纯计算层不应有依赖 | 需要 ctx 的逻辑放在 Flow 或 `_internal` |
| `Bun.write` 非原子写入 | 断电可能损坏文件 | 先写 `.tmp` 再 `rename` |
| Flow 直接读 `event.raw` | 依赖不稳定 payload | 使用稳定的 DTO 字段 |
| 在 Flow 中启动或操作 Agent Session | Session 是独立入口 | 通过 `SessionService` 统一管理 |

---

## 9. 调试技巧

```typescript
// 1. 使用 FlowContext.state 在请求内传递中间状态
ctx.state.set("check", "formatResults", formatResults);

// 2. 在另一个 Flow 中读取
const results = ctx.state.get<FormatResult[]>("check", "formatResults");

// 3. executeFlow 自动校验输入输出、记录执行 NDJSON
import { executeFlow } from "@/engine/execute.js";
const output = await executeFlow(someFlow, ctx, input);
// → 校验 input → 执行 → 校验 output → 写入 runtime/ops/executions/{date}.ndjson

// 4. 手动记录（Flow 内部）
ctx.logger.info({ key: value }, "操作描述");
// → 输出到控制台 + 日志文件
```

---

## 10. 文件清单模板

新增一个 Flow 涉及的文件变更：

```
✅ 新建  src/flows/{category}/{name}.ts              # Flow 实现
✅ 修改  src/flows/{category}/index.ts                # 领域 barrel 导出
✅ 修改  src/flows/index.ts                           # 总 barrel 导出 + allPublicFlows
🟡 可选 src/flows/_internal/{utils}.ts               # 如果需要领域内部操作
🟡 可选 src/flows/_shared/{utils}.ts                 # 如果需要纯函数
```

不再需要：
- ❌ `commandRouter` 注册（已删除）
- ❌ Composite Flow 编排（改用 dispatch 程序编排或 Agent 动态组合）
- ❌ JSON Schema + TypeBox 双轨 schema

---

## 11. 与旧版（C#）的对应关系
| 旧版组件 | 新版 Flow | 差异 |
|---|---|---|
| `CommandProcessor.cs` | `src/flows/files/*.ts` + `src/flows/git/*.ts` + Agent Session | 从 1 个 784 行类拆分为多个原子 Flow，命令路由由 Agent 替代 |
| `CommentBuilder.cs` | `info_comment_refresh` + `_shared/markdown/` | 从 1100+ 行拆分为 Flow + 纯函数 |
| `MyWebhookEventProcessor.cs` | `api/webhook/dispatch.ts` | 从 switch/case 拆分为 DTO 路由 + `executeFlow()` |
| `ChristinaController.LLMAssistant` | `agent/tools/` (review-moa, terms-extract, review-align) | batch×model 流水线改为 Agent ReAct 驱动的原生工具 |
| `LLMReviewCache.cs` | `flows/_shared/review/` | SQLite 索引 → NDJSON + 文件哈希 |
| `ProjectHex.cs` | ❌ 未实现 | 资源包构建系统 |
| `Utils/Labeler+LabelCheck` | `checks_run_label_guard` + `labels_sync` | 从 2 个方法拆分为 2 个原子 Flow |
