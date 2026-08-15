# AGENTS.md

CFPABot — GitHub 机器人，服务于 [CFPAOrg/Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package) 仓库。自动处理 Minecraft 模组翻译 PR 的审查、标签管理、评论生成和 LLM 翻译质量评审。

## 技术栈

- **后端**: Bun + Hono (TypeScript), 端口 8080
- **前端**: Vite + React 19 + TypeScript + Monaco Editor (@monaco-editor/react), dev 端口 5173
- **AI**: @earendil-works/pi-coding-agent v0.80.6 (AgentSession + SessionManager), @earendil-works/pi-ai v0.80.6 (LLM), MoA 多模型审查
- **认证**: GitHub OAuth, cookie-based, AES-256-GCM 加密
- **数据**: 文件存储 (JSON / NDJSON), 无数据库
- **样式**: Tailwind CSS
- **状态**: Zustand

## 仓库布局

应用本体自包含在 `CFPABot/` 内层目录（对齐 ref .NET 仓库结构）；根目录只留协议文件、编排与文档：

```
CFPABot/                    # 仓库根
├── AGENTS.md / README.md / .gitignore / .gitattributes
├── docker-compose.yml / docker-up.bat / docker-build.bat
├── docs/                   # 开发文档
└── CFPABot/                # 应用本体（cwd，所有 bun 命令在此运行）
    ├── package.json / bun.lock / bunfig.toml / tsconfig.json
    ├── Dockerfile / .dockerignore / .env.example
    ├── src/                # 后端 (Bun + Hono)
    ├── web/                # 前端 (Vite + React)
    ├── config/             # 运行时配置（pi-agent/ 为 pi-agent 配置环境，git 跟踪）
    ├── runtime/ / logs/ / temp/   # 运行时数据（gitignored）
    └── scripts/ skills/
```

## 开发与构建

```bash
cd CFPABot && bun install   # 安装依赖 (workspaces: 根 + web/)
cd CFPABot && bun run dev   # 开发: concurrently 同时启动后端(8080) + Vite dev server(5173, HMR)
cd CFPABot && bun run build # 生产构建: Vite 构建前端到 public/ + Bun 构建后端到 dist/
cd CFPABot && bun run start # 生产运行: bun run dist/index.js
cd CFPABot && bun run typecheck  # 类型检查: tsc --noEmit
cd CFPABot && bun run check      # CI 级本地检查: arch lint + typecheck + 后端/前端测试
```

> 所有 bun 命令在 `CFPABot/` 内层运行（bun 从 cwd 找 package.json/bunfig.toml，不向上查找）。

### 开发模式

- **访问 `http://localhost:5173`** (不是 8080)
- Vite dev server 提供 HMR，API 请求通过 proxy 转发到后端 8080
- 代理配置见 `web/vite.config.ts`: `/api`, `/github`, `/callback`, `/signout`, `/me`
- 后端 `bun --watch` 文件变更自动重启

### 生产模式

- `bun run build` 先构建前端 (`public/`)，再构建后端 (`dist/`)
- `bun run start` 运行编译后的 `dist/index.js`，直接 serve `public/` 静态文件
- SPA fallback: 非 API 的 404 请求回退到 `public/index.html`

## 环境变量

参考 `.env.example`，关键变量:

| 变量 | 用途 |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID，JWT 认证 |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App Installation ID |
| `GITHUB_APP_PEM_PATH` | RSA 私钥路径（默认 `config/cfpa-bot.pem`） |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC 验证 |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | 前端用户 OAuth 登录 |
| `CF_API_KEY` | CurseForge 模组信息查询 |
| `PORT` | 服务端口 (默认 8080) |
| `LOG_LEVEL` | 日志级别 (debug/info/warn/error) |
| `REVIEW_PUBLISH_ENABLED` | 启用 `review_comment` Flow 的发表能力（默认 false）；false 时审查 E2E 仅产生 review 结果，不写入 GitHub。注意评论恢复需要三重开关同时打开，见 docs/TODO.md |
| `ASPNETCORE_ENVIRONMENT=Development` | 开发模式 (跳过启动时 GitHub 认证检查) |

LLM 审查通过 JSON 文件配置 (`config/llm-endpoints.json`):

| 字段 | 用途 |
|---|---|
| `provider` | 提供商 (openai/anthropic) |
| `baseUrl` | API 端点 |
| `apiKey` | API 密钥 |
| `modelId` | 模型名称 |

参考 `config/llm-endpoints.json.example`。

原版术语数据: `config/vanilla-terms.json`（curated 原版术语，多 en/多 zh + scope 约束，
`review_prep` 自动注入；当前为占位数据，最终格式以用户提供为准）。

## GitHub App 认证

GitHub API 认证使用 GitHub App JWT 流程（PAT 已弃用）：

```
config/cfpa-bot.pem (RSA 私钥)
        ↓
createAppAuth (appId + privateKey + installationId)
        ↓
自动签发 JWT (RS256, App ID 标识)
        ↓
GitHub 换取 Installation Token (~1h 有效)
        ↓
Octokit 实例 (retry + throttling 插件)
```

- 实现: `src/client/github-app-auth.ts` — `createAuthenticatedOctokit()` + `createPersonalOctokit()`
- 配置: `GITHUB_APP_ID` + `GITHUB_APP_INSTALLATION_ID` + `GITHUB_APP_PEM_PATH`；`GITHUB_OAUTH_TOKEN` (PAT) 可选，用于个人操作
- 双客户端: `Instance` (App JWT) 用于主 API + `InstancePersonal` (PAT) 用于 Gist/GraphQL（与 ref .NET 仓库对齐）
- Token 由 `@octokit/auth-app` 自动管理刷新，无需手动干预

REST API → Hono路由 → OAuth认证 → 业务逻辑
  → /api/sessions/* (CRUD + SSE streaming)
  → /api/frontend/* (PR列表、对比、标签、special-diff等)



### Web Compare & SpecialDiff

- Compare 工具的业务逻辑已迁移到 `flows/compare/` 域（4 个 Flow）：
  `compare_get_sources`、`compare_workspace`、`compare_upload`、`compare_special_diff`、`compare_cross_version`。
  API 层 (`api/frontend/compare.ts`) 仅做 HTTP DTO 解析 + `executeFlow()` 调用。
- **非语言文件**（如 `.txt` 手册/manual 文件）不走普通 compare 端点，而是通过
  `GET /compare/:prId/special-diff`（`compare_special_diff` Flow）获取原始内容，
  由前端 Monaco 双窗格展示 diff。
- 普通 compare 的 `POST /compare/:prId/workspace`（`compare_workspace` Flow）中 source 解析
  已加固：每个 source 独立解析，fetch 失败时返回 `{}` 而非抛出，保证单 source 失败不会拖垮整次对比。

SSE → PiSessionManager(pi-coding-agent AgentSession)
  → Flow作为Tool被调用 → flowToToolDefinition适配(ToolDefinition)
  → AgentSession内置transcript持久化(runtime/sessions/transcripts/ JSONL)

### 核心抽象: Flow

每个业务操作是一个 `Flow` 对象 (`src/types.ts`):

```typescript
interface Flow<I, O> {
  name: string;
  description: string;
  input: I;                     // TypeBox schema → 运行时校验
  output: O;                    // TypeBox schema → 输出校验
  meta: {
    tags: readonly string[];    // 分类标签 (info-comment, pr, review 等)
    risk: FlowRisk;             // read | review_write | repository_write | destructive
    effects: readonly FlowEffect[];
    timeoutMs?: number;
    retry?: { maxAttempts: number; backoffMs: number };
    idempotencyKey?: (invocation, input) => string;
  };
  execute(ctx: FlowContext, input: I): Promise<O>;
}
```

- 注册到 `FlowRegistry` (`src/engine/registry.ts`)，共享存储于 `src/engine/registry-store.ts`
- 执行时自动记录到 `runtime/ops/executions/{id}.ndjson` (通过 `src/engine/record.ts`)，使用 O(1) append
- 可被 AI Agent 作为工具调用 (`src/agent/flow-adapter.ts` 的 `flowToToolDefinition`)
- 依赖可通过工厂函数注入: `createAllPublicFlows(options)` 在 `src/bootstrap/flows.ts` 中完成
- FlowContext 由 `src/context.ts` 构建，API 发起的由 `src/api/flow-context.ts` 构建

### FlowContext

每次 Flow 执行的上下文 (`src/context.ts` 构建):

```typescript
interface FlowContext {
  repo: { owner, name, defaultBranch };
  actor: { kind, login? };      // "admin" | "system"
  invocation: { id, source, sessionId?, deliveryId?, parentId? };
  github: GitHubClient;         // Octokit 封装 (retry + throttling)
  store: FileStore;             // 文件读写
  logger: Logger;
  config: EntryConfig;
  state: ScopedState;           // 请求内内存状态
  signal: AbortSignal;          // 取消信号
}
```

## 目录结构

以下目录树路径均相对 **`CFPABot/` 内层目录**（应用本体）：
```
src/
├── index.ts              # 入口: 加载配置 + 启动 bootstrap
├── bootstrap.ts          # 引导入口薄代理 (导出 bootstrap + createCSRFOptions)
├── bootstrap/            # 引导分解模块
│   ├── deps.ts             # 依赖创建 (GitHubClient, FileStore, SessionService等)
│   ├── flows.ts            # FlowRegistry 创建 + Flow 注册
│   ├── app.ts              # Hono App 创建 + 路由挂载 + CORS/CSRF
│   ├── orchestrator.ts     # 主引导编排 (export bootstrap 函数)
│   └── server.ts           # Bun.serve 启动 + SSE 挂载
├── config.ts             # 环境变量加载 + 常量 (REPO, AUTH, REQUIRED_DIRS)
├── constants.ts          # 应用常量
├── context.ts            # FlowContext 构建器
├── types.ts              # 核心类型定义 (Flow, FlowContext, FlowError 等)
├── store.ts              # 文件存储 (read/write/append/list, 原子写, 串行append)
├── logger.ts             # 日志 (Pino, console + 文件 + 2000条内存环形缓冲)
├── cron.ts               # Cron 调度器 (CronTask 接口 + startCronTasks)
├── runtime-paths.ts      # 运行时路径常量
├── cron-tasks/           # 定时任务 (modlist-refresh, curseforge-mapping, pr-cache-refresh, cleanup)
├── _shared/              # 项目级共享工具
│   └── fs-utils.ts         # 文件读写工具 (readJsonFile, writeJsonLocked, 原 durable-json)
├── agent/                # AI Agent 模块 (pi-coding-agent 集成)
│   ├── session-manager.ts   # PiSessionManager — AgentSession 封装 (prompt/SSE/transcript)
│   ├── session-service.ts   # 会话业务元数据持久化 + confirmation 生命周期
│   ├── session-types.ts     # 会话类型定义
│   ├── session-ctx.ts       # Agent FlowContext 构建
│   ├── session-prompt.ts    # Agent 提示词注入
│   ├── session-projection.ts# 会话消息投影 (DB → API DTO)
│   ├── session-sse.ts       # SSE 事件流 (流式消息 + 进度)
│   ├── ctx-store.ts         # 会话 ctx 增量持久化 (runtime/sessions/ctx/)
│   ├── review-aggregate.ts  # 审查中间表聚合纯函数 (MoA + 程序候选)
│   ├── flow-adapter.ts      # Flow → AgentTool 转换
│   ├── llm-registry.ts      # LLM 模型注册表 (pi-ai Models)
│   ├── llm-endpoints.ts     # LLM 端点配置解析
│   ├── llm-config-store.ts  # LLM 端点配置持久化
│   ├── llm-config-manager.ts# LLM 配置管理器 (CRUD + 默认值)
│   ├── llm-types.ts         # LLM 领域类型
│   ├── pi-transcript-reader.ts # Agent 会话转录读取器
│   ├── _shared/
│   │   └── serialized-queue.ts # 串行任务队列
│   ├── tools/               # Agent 原生工具 (直接调用 LLM，不经过 Flow 引擎)
│       ├── ctx.ts             # 工具上下文构建
│       ├── todo.ts            # 工作项管理工具
│       ├── dict-lookup.ts     # 术语词典查询工具
│       ├── terms-extract.ts   # 对齐条目 n-gram 术语候选 (跨条目高频+stop word 过滤)
│       ├── terms-distill.ts   # 术语清洗工具 (三层来源 → cleaned/audit 双层表)
│       ├── review-align.ts    # 翻译对齐工具
│       ├── review-moa.ts      # MoA 多模型审查核心工具 (retry×3 + 主模型兜底 + 分桶)
│       ├── review-aggregate.ts# 审查意见聚合工具 (→ ctx.reviewTable)
│       ├── review-finalize.ts # 最终意见表生成工具 (→ ctx.finalTable + 驳回审计)
│       ├── review-manual-plan.ts # 人工审查计划工具
│       ├── tm-query.ts        # 翻译记忆查询工具 (BM25 + fuzzy, 多候选)
│       └── review-prep.ts     # 译前准备 (自动批量: TM 批量查询 + 术语匹配 + 原版注入 → 行 prep 字段)
├── api/                  # Hono 路由 (HTTP 入站适配层)
│   ├── auth.ts             # OAuth cookie 认证 (AES-256-GCM)
│   ├── oauth.ts            # /api/oauth/* (GitHub OAuth)
│   ├── frontend.ts         # /api/frontend/* 入口 (挂载 frontend/ 子路由)
│   ├── flow-context.ts     # API 发起的 FlowContext 构建
│   ├── sessions.ts         # /api/sessions/* (CRUD + SSE)
│   ├── bmcl-modlist.ts     # BMCL 模组列表兼容端点
│   ├── frontend/           # 前端 API 子路由 (prs, pr, compare, modlist, admin-llm, dev)
│   │   ├── prs.ts            # PR 列表查询
│   │   ├── pr.ts             # 单个 PR 详情
│   │   ├── modlist.ts        # 模组列表
│   │   ├── compare.ts        # Compare 对比工具路由
│   │   ├── helpers.ts        # HTTP 辅助函数
│   │   ├── admin-llm.ts      # LLM 配置管理路由
│   │   └── dev/              # 开发工具路由
│   │       ├── index.ts        # Dev panel 路由 (mock-github, cache, logs)
│   │       └── mock-github.ts  # Mock GitHub API
│   └── webhook/            # Webhook 处理
│       ├── receiver.ts      # HMAC验证 + 事件反序列化 + 安全检查
│       ├── dto.ts           # 类型化 DTO 提取
│       ├── dispatch.ts      # 事件 → switch/case 路由到各 Flow
│       ├── route.ts         # POST /api/webhook + GET 手动触发
│       └── agent-command.ts # /agent-review 命令处理 (从 route.ts 提取)
├── engine/               # Flow 引擎 (执行生命周期)
│   ├── registry.ts         # FlowRegistry (Map + tag索引)
│   ├── registry-store.ts   # 共享 FlowRegistry 单例
│   ├── execute.ts          # 统一执行入口: 输入校验 → 风险策略 → 幂等 → 执行 → 输出校验 → 记录
│   ├── idempotency.ts      # 幂等性保障 (FileStore 双检锁)
│   ├── retry.ts            # 重试策略 (退避 + 可取消)
│   ├── timeout.ts          # 超时 + 取消信号合并
│   ├── validate.ts         # TypeBox 运行时校验 (decodeOrThrow)
│   ├── record.ts           # NDJSON 执行记录写入
│   ├── lock.ts             # 进程内并发锁
│   └── pr-index.ts         # PR 索引缓存管理 (从 client/ 移入)
├── flows/                # 全部业务 Flow
│   ├── index.ts            # Barrel + createAllPublicFlows() 工厂
│   ├── _internal/          # 跨域内部操作 (load-pr-snapshot, load-pr-diff等)
│   ├── _shared/            # 纯函数共享库 (无 I/O, 无状态)
│   │   ├── index.ts            # Barrel
│   │   ├── types.ts            # 领域类型 (DiffRow, Finding, ReviewDraft等)
│   │   ├── lock.ts             # 进程内并发锁 (withLock)
│   │   ├── pr-relation-format.ts # PR 关系格式化
│   │   ├── project-path/       # 模组路径解析 (parse, extract-mod-set)
│   │   ├── language/           # 语言文件解析、对比、格式化
│   │   ├── markdown/           # Markdown 渲染 (评论, 审查报告)
│   │   ├── terminology/        # 术语检查 (check-terms, rules) + term-match (行级术语匹配: hash 短语 + regex/version 逐条)
│   │   └── review/             # 审查共享算法 (term-projection)
│   ├── pr/                 # PR 查询: list, get-detail, get-diff, get-context, compare, find-related, read-file
│   ├── translation/        # 翻译分析: analyze, check-terms, check-keys
│   ├── info-comment/       # 信息评论: refresh, refresh-artifacts, force-refresh + _internal/
│   ├── review/             # 审查工具 Flow: thread-reply, comment (完整审查管线已迁移到 agent/tools/)
│   ├── files/              # 文件操作: move-project, rename, fetch-en-us, replace-text, sort-keys, format + _internal/
│   ├── git/                # Git操作: revert-commit, coauthor-add + _internal/
│   ├── labels/             # 标签同步: sync
│   ├── checks/             # 检查: label-guard
│   ├── packer/             # Packer: auto-approve
│   ├── cache/              # 缓存刷新: pr-cache-refresh, modlist-refresh, mapping-refresh, modlist-build
│   ├── mappings/           # 映射: mapping-add, unmapped-slugs
│   ├── terminology/        # 术语/TM 基建: terms_ngram_build (n-gram 自动术语表), tm_build (BM25+fuzzy TM 索引)
│   └── compare/            # Compare 工具: get-sources, run, upload, special-diff, workspace, cross-version
├── __tests__/             # 集成测试 + 契约测试
│   ├── api-route-contracts.test.ts # API 路由契约测试
│   ├── integration.test.ts         # 架构边界集成测试
│   └── helpers/
│       └── mock-context.ts
│
├── client/               # 外部 API 客户端
│   ├── index.ts            # Barrel export
│   ├── github/             # GitHub API (Octokit 封装)
│   │   ├── index.ts, octokit-client.ts, types.ts, mappers.ts, helpers.ts
│   ├── github-app-auth.ts  # GitHub App JWT 认证
│   ├── curseforge-client.ts   # CurseForge API
│   ├── modrinth-client.ts     # Modrinth API
│   ├── git.ts                 # 本地 Git 操作 (Bun.spawn)
│   ├── pr-relations-cache.ts  # PR 关系有状态缓存
│   ├── local-repo.ts          # 本地仓库文件读取
│   ├── cache.ts               # 缓存读写辅助 (包装 fs-utils)
│   ├── llm-models.ts          # pi-ai 模型列表
│   └── terminology/           # 术语服务 (types only, 实现待接入)
│
web/
├── index.html              # Vite入口HTML
├── vite.config.ts          # Vite配置 (proxy, outDir: ../public)
├── src/
│   ├── main.tsx            # React入口 (BrowserRouter)
│   ├── App.tsx             # React Router 路由定义 (含 RouteErrorBoundary)
│   ├── index.css           # Tailwind 样式
│   ├── components/         # Layout, Skeleton, ErrorBoundary, RouteErrorBoundary
│   ├── pages/              # Dashboard, PrList, PrDetail, Compare, Sessions,
│   │   │                   # SpecialDiff, CompareIndex, AdminPanel, CrossVersion, Logs, NotFound
│   │   ├── admin/          # AdminLlmConfig, AdminMock, AdminUnmapped, AdminWebhook, AdminOutbound
│   │   ├── sessions/       # SessionSidebar, components (无 ReviewRunPanel)
│   │   ├── compare/        # InlineTextDiff, WorkspaceDiffTable, StatBadge
│   │   ├── dashboard/      # Dashboard: helpers
│   │   └── pr-detail/      # PrDetail: file-list
│   ├── hooks/useAgentChat/ # useAgentChat: protocol, normalize, index, useSseStream
│   ├── stores/authStore.ts # Zustand认证状态
│   ├── lib/                # 前端库
│   │   ├── api/              # 拆分后的 API 客户端
│   │   │   ├── index.ts       # 统一 barrel (兼容旧 import)
│   │   │   ├── client.ts      # HTTP 基础客户端 (fetch 封装)
│   │   │   ├── frontend.ts    # /api/frontend/* 方法
│   │   │   ├── sessions.ts    # /api/sessions/* 方法
│   │   │   └── types.ts       # API 请求/响应类型
│   │   └── helpers.tsx      # 前端辅助函数
│   └── types/              # (空: 前端类型移至 lib/api/types.ts)
│
config/                         # 运行时配置 (encrypt_key.txt, cfpa-bot.pem)
runtime/                        # 运行时数据
├── cache/                      # 可重建缓存
│   ├── modlist.json
│   ├── curseforge-mapping.json
│   ├── pr_index.json
│   ├── pr_files/               # 原 runtime/pr_cache/*.json
│   │   └── {prId}.json
│   └── pr_files_watermark.json
├── state/                      # 持久化业务状态
│   ├── info-comments/          # 原 runtime/cache/info-comments
│   │   └── {owner}/{repo}/{pr}.json
│   └── review-publications/    # 原 runtime/cache/review-publications
│       └── {repoId}/{pr}/{session}.json
├── sessions/                   # Agent 会话 JSON 元数据
│   ├── {uuid}.json
│   ├── _dedup/
│   ├── ctx/                     # 会话 ctx 增量快照 (审查中间表/最终表/术语)
│   └── transcripts/            # 原 runtime/pi-sessions
│       └── {ts}_{id}.jsonl
├── agent/                      # Pi agent 目录 (settings.json 注册 extensions, 如 pi-mcp-adapter)
├── ops/
│   ├── executions/             # 原 runtime/executions
│   └── idempotency/            # 原 runtime/idempotency
└── repo/                       # 浅克隆仓库
logs/                           # 日志文件
temp/                           # 临时文件
docs/                           # 开发文档
├── flow-authoring-guide.md
├── flow-architecture-spec.md
├── semantic-layer-analysis.md  # 语义层分析
└── handoff-2026-07-12-api-client-边界.md
skills/                         # Agent 技能 (SKILL.md)
└── translation-review/
    └── SKILL.md
```

## 模块放置规则

项目遵循三层架构，边界由**依赖方向**决定：

| 层 | 目录 | 放什么 | 不放什么 |
|---|---|---|---|
| **入站适配** | `api/` | HTTP 路由绑定、auth/session/cookie、body 解析、schema 校验（HTTP body → Input DTO）、构造 context、调 flow、flow result → HTTP response | 业务判断、多 client 编排、`node:fs`/`Bun.file`/`octokit` 直接调用 |
| **编排** | `flows/` | 业务操作、workflow、retry、sequencing | 纯算法、HTTP 调用 |
| **共享算法** | `flows/_shared/` | 纯计算、格式化、分析、组装（无 I/O、无全局状态） | 外部系统交互、认证、有状态的基础设施、有状态缓存 |
| **外部系统** | `client/` | HTTP API、Git 仓库、OAuth、auth、缓存包装；维护从外部数据源派生的状态缓存（如 PR relation cache） | Flow 编排逻辑、纯算法 |

> **例外**: `src/api/auth.ts` 在 boot-time 通过 node:fs 读取 `config/encrypt_key.txt`，是为 AES-GCM cookie 密钥加载配置的正常职责。不允许 api/ 中其他 node:fs 使用。
> **例外 (pi-coding-agent)**: `src/agent/session-manager.ts` (PiSessionManager)
> 通过 @earendil-works/pi-coding-agent 的 AgentSession/SessionManager 管理
> ReAct loop transcript 持久化到 `runtime/sessions/transcripts/` JSONL 文件。
> 这是 pi-coding-agent 的内部职责 — SessionManager 维护 append-only JSONL 作为
> 对话真相源，SessionRecord.messages 仅作为前端 API 的投影视图。
> 业务 Session metadata (SessionRecord) 仍走 FileStore (`runtime/sessions/`）。
> 不允许在其他地方以 `node:fs` 直接读写 `runtime/sessions/transcripts/`。
>

**api → client 直通例外**：单 client 方法 + 无任何转换逻辑时可跳过 flow（如 `GET /rate-limit`）。一旦出现 filter/map/reduce、多数据源、字段重组、缓存决策之一，必须进 `flows/`。

**判断不了的**：看它的依赖。
- 依赖 `octokit` / `Bun.spawn` / `fetch` 或者维护从外部数据源构建的内存缓存 → `client/`
- 纯计算、无状态、格式化 → `_shared/`
- 处理 HTTP 入站/编解码/校验 → `api/`
- 无法归类为以上三者 → `flows/`（如果主要被 Flow 使用）

**api/ 的职责哲学：可以薄，但不能透明。它是 HTTP adapter，不是业务层，也不是裸代理。**

**`_shared/` 与 `client/` 的正确拆分模式**：当一个模块中同时存在纯算法和有状态两部分时，按职责拆分到两个文件：
- 纯函数（格式化、路径解析）→ `flows/_shared/`
- 有状态部分（缓存、初始化、刷新）→ `client/`

例如 `pr-relation` 已拆分为：
- `_shared/pr-relation-format.ts` — `parseProjectPath()`, `formatRelationsWarning()`
- `client/pr-relations-cache.ts` — `initRelation()`, `refreshRelation()`, `getRelation()`, `getRelationsForPR()`

**_internal 目录放置规则**：内部逻辑（不被其他 Flow 直接调用的模块私有函数）放在所在域的 `_internal/` 目录下。
跨域共享的内部操作（被两个或以上 Flow 域使用的辅助操作）放在 `flows/_internal/` 中。
Flow 域级别示例: `flows/info-comment/_internal/`, `flows/files/_internal/`。
跨域共享示例: `flows/_internal/load-pr-snapshot.ts`, `flows/_internal/load-pr-diff.ts`。

## Webhook 事件流

dispatch.ts 直接通过 switch/case 路由到各 Flow，无中间的 composite Flow 层:

| GitHub事件 | dispatch 处理 | 串行 | 并行 |
|---|---|---|---|
| `pull_request.opened` / `synchronize` | packer_auto_approve → info_comment_refresh + checks_run_label_guard + labels_sync + pr_cache_refresh | packer_auto_approve 先执行 | 剩余四 Flow 并行 (Promise.allSettled) |
| `pull_request.edited` | checks_run_label_guard + labels_sync | — | 并行 |
| `pull_request.labeled` / `unlabeled` | checks_run_label_guard | 单独执行 | — |
| `pull_request.closed` | pr_cache_refresh (remove_closed) | 单独执行 | — |
| `issue_comment.created` (`/agent` / `/agent-review` 命令) | 由 route.ts 检测 → agent-command.ts 处理 Session 创建 | — | — |
| `issue_comment.edited` (复选框已勾选) | info_comment_force_refresh | 单独执行 | — |
| `workflow_run.completed` (PR Packer) | info_comment_refresh_artifacts | 单独执行 | — |

## Agent 会话 (/agent / /agent-review)

PR 评论中以 `/agent` 或 `/agent-review` 开头的命令（首行）由 `src/api/webhook/route.ts` 检测并通过 `src/api/webhook/agent-command.ts` 处理:

- `/agent <目标说明>` — 创建一个完整的 Agent ReAct 会话，通过 `flowToAgentTool` 暴露所有注册的 Flow 作为工具，Agent 可自主编排执行顺序
- `/agent-review` — 创建 Agent 会话并加载 `skills/translation-review/SKILL.md` 技能，进入翻译审查流水线。审查逻辑由 Agent 通过 `agent/tools/` 中的原生工具执行，不经过 Flow 引擎

会话创建后由 `SessionService` (`src/agent/session-service.ts`) 持久化到 `runtime/sessions/`，
通过 `AgentSessionManager` (`src/agent/session-manager.ts`) 驱动 pi-agent ReAct loop，
前端通过 `/api/sessions/:sessionId/stream` 接收 SSE 事件流。

管理端可通过 Admin 面板 (`/admin`) 查看活跃会话、发送消息、确认高危操作。
## LLM 审查

Agent 翻译审查通过 `src/agent/tools/` 中的原生工具执行，不经过 Flow 引擎:

1. **术语识别** (`tools/terms-extract.ts`) — 对齐条目 n-gram 术语候选（跨条目高频 + stop word 过滤，只统计单一版本），agent 裁决后经 `dict_lookup` op=set（source=internal）写入
2. **翻译对齐** (`tools/review-align.ts`) — 对齐 base/head 语言条目，跨版本合并为一条（同 key 同 headEn），生成 DiffRow 资产 + 程序候选（含 FormatChecker 确定性格式检查）
3. **译前准备** (`tools/review-prep.ts`) — 自动批量（不调 LLM）：对对齐表每行做 TM 批量查询（每模组索引一次加载）+ 术语匹配（agent 术语库 + 原版 vanilla 自动注入，绕过 agent）→ 写入行 prep 字段（软意见，无 verdict/reason）；MoA prompt 渲染 prep（程序摘要/术语命中/tm 参考）
4. **MoA 多模型审查** (`tools/review-moa.ts`) — 对每个 review unit（仅 scope=changed 差分条目）调用多个 LLM 模型独立审查，聚合模型意见后形成候选发现；程序意见为软参考，模型可输出 `program_false_positive` 反驳
5. **人工审查计划** (`tools/review-manual-plan.ts`) — 辅助人工审查的计划生成
6. **词典查询** (`tools/dict-lookup.ts`) — 术语词典查询

模型通过 `llm-registry.ts` (基于 `@earendil-works/pi-ai`) 注册和管理，API Key 从 `config/llm-endpoints.json` 配置。

Agent ReAct loop 自身的 LLM 调用也使用同一注册表 (`src/agent/session-manager.ts`)。

## 术语资产

术语分三层（对应三个注入程度，2026-08-04 定稿）：

- **internal（程序构建，LLM 清洗）** — `terms_extract` 从对齐条目构建 n-gram 候选
  （跨条目高频 + stop word 过滤，只统计单一版本，与 `terms_ngram_build` 全文件术语库
  互补），agent 裁决后经 `dict_lookup` op=set（显式 source=internal）写入 ctx.dict，
  再经 `terms_distill` 清洗（cleaned/audit 双层）；外部也会对这些术语查一遍
- **external/TM（LLM 主动查）** — `tm_query` 翻译记忆、glossary 外部术语（MCP 接入后），
  agent 主动查询
- **vanilla（原版，自动注入，LLM 不清洗）** — `config/vanilla-terms.json`（curated 原版术语，
  含多 en/多 zh 与 scope 约束），`review_prep` 自动注入、绕过 agent；非 regex 术语 hash
  短语匹配，regex scope 逐条匹配（O(n·m)）

行级消费：`review_prep` 对对齐表每行做术语匹配（agent 库 + 原版自动注入）写入 `prep.terms`
（ok=false = 未遵守），MoA prompt 逐行渲染 + 头部整合词表（原版命中节最高优先级）。

## MCP 集成

审查 Agent 通过 `pi-mcp-adapter` extension 使用 MCP server（如 packtrans-glossary 术语库）：

- **extension 注册**：`config/pi-agent/settings.json`（git 跟踪）的
  `extensions` 数组记录 adapter 路径（标准 Pi settings 机制，与 `pi install` 等价）；
  global scope 相对路径以 agentDir（`PI_CODING_AGENT_DIR` → `config/pi-agent`）为基准解析
- **server 配置**：`config/pi-agent/mcp.json`（git 跟踪；`PI_CODING_AGENT_DIR` env
  指向 config/pi-agent，本机与 Docker 同机制；server `cwd` 用 `${CFPABOT_GLOSSARY_DIR}`
  插值，`command` 相对 cwd 解析）——加新 server 无需改代码
- **生产镜像**：Dockerfile runtime 阶段下载 `packtrans/glossary` release 的
  `x86_64-unknown-linux-gnu` 二进制到 `/app/bin/`（`GLOSSARY_VERSION` ARG 钉版本，
  构建期 `mcp --help` 冒烟），并设 `ENV PI_CODING_AGENT_DIR=/app/config/pi-agent
  CFPABOT_GLOSSARY_DIR=/app/bin`（不再生成 `.mcp.json`，配置走 git 跟踪的
  `config/pi-agent/mcp.json`，经 compose volume `./CFPABot/config:/app/config` 挂载）。
  注意：上游只有 glibc 资产（无 musl），runtime 必须是 glibc 基础镜像（`oven/bun:1`），不能用 `-alpine`
- **二进制**：本机 `bun run fetch:glossary` 自动从 GitHub release 下载到
  `runtime/bin`（gitignored；`CFPABOT_GLOSSARY_DIR` 缺省 = `<cwd>/runtime/bin`，
  幂等：存在即跳过）；容器由 Dockerfile 下载到 `/app/bin`。跨机器克隆无需改配置
- **加载链路**：`CfpabotResourceLoader`（`session-prompt.ts`）委托
  `DefaultResourceLoader`（`extensionFactories` 官方机制）加载 extensions；
  `session-manager.ts` 在 `createAgentSession` 前显式 `await resourceLoader.reload()`
  （SDK 契约：自定义 loader 由调用方负责 reload）
- **工具校验**：`validateToolSet` 只查 missing——extension 注册的额外工具
  （`mcp`/`mcp_script`）合法
- **依赖**：`pi-mcp-adapter` + `zod`（peer）；`@modelcontextprotocol/sdk` 为直接依赖
  （bun 未 hoist adapter 的依赖到顶层，adapter 懒加载时解析不到，需顶层链接）
- glossary MCP server 为 `packtrans-glossary` v0.0.12+ 的 `mcp` 子命令（stdio）


## 认证流程

1. 用户访问 `/api/oauth/github` → 重定向到 GitHub OAuth
2. GitHub回调 `/api/oauth/callback` → 交换 token → AES-256-GCM 加密 → 存入 cookie
3. `authMiddleware` 读取 cookie → 解密 → 调用 `/user` API 验证 → 设置 `c.get("user")`
4. `requireAuth` 中间件保护需要登录的路由
5. 加密密钥持久化在 `config/encrypt_key.txt`

`isAdmin` 在认证流程中表示该 GitHub 身份对目标仓库具有 push/write 权限（包括 write collaborator、仓库 owner、以及 org 级别有 write 权限的成员），不等同于 GitHub 的 "admin" 角色名。判断依据为 GitHub `GET /repos/{owner}/{name}/collaborators/{username}` 接口，结果通过 5 分钟 TTL 的进程内缓存减少 API 调用。

## 代码规范

- **Flow 命名**: snake_case, 领域前缀 + 动词 (pr_get_context, info_comment_refresh, review_prepare)
- **路径别名**: `@/*` → `src/*` (tsconfig paths, 前端使用)
- **Barrel exports**: 每个目录有 `index.ts` 统一导出
- **严格模式**: `strict: true`, `noUncheckedIndexedAccess: true`
- **无 `as any` / `@ts-ignore`**: 类型安全优先
- **缓存写规范**: `runtime/cache/*.json` 的写入必须通过 `_shared/fs-utils.ts`（或 `client/cache.ts` 的写辅助函数），不得裸调 `Bun.write`。共享多写入者路径使用 `writeJsonLocked` 保证原子性。运行时会话/执行记录走 `store.ts`，不在此列。

## 运行时目录

以下路径均相对 **`CFPABot/` 内层目录**（cwd）。`ensureDirectories` 自动创建所需目录：

```
config/                         # 运行时配置（pi-agent/ 为 pi-agent 配置环境，git 跟踪；
                                #  encrypt_key.txt、cfpa-bot.pem、llm-endpoints.json gitignored）
runtime/
├── cache/                      # 可重建缓存
│   ├── modlist.json
│   ├── curseforge-mapping.json
│   ├── pr_index.json
│   ├── pr_files/               # 原 runtime/pr_cache/*.json
│   │   └── {prId}.json
│   ├── pr_files_watermark.json
│   └── tm/                     # 翻译记忆索引
├── state/                      # 持久化业务状态
│   ├── info-comments/          # 原 runtime/cache/info-comments
│   │   └── {owner}/{repo}/{pr}.json
│   └── review-publications/    # 原 runtime/cache/review-publications
│       └── {repoId}/{pr}/{session}.json
├── sessions/                   # Agent 会话 JSON 元数据
│   ├── {uuid}.json
│   ├── _dedup/
│   ├── ctx/                     # 会话 ctx 增量快照 (审查中间表/最终表/术语)
│   └── transcripts/            # 原 runtime/pi-sessions
│       └── {ts}_{id}.jsonl
├── bin/                        # glossary 二进制（fetch-glossary 自动下载，gitignored）
├── ops/
│   ├── executions/             # 原 runtime/executions
│   └── idempotency/            # 原 runtime/idempotency
└── repo/                       # 浅克隆仓库
logs/                           # 日志文件
temp/                           # 临时文件
```

所有运行时路径常量集中在 `src/runtime-paths.ts`，生产代码不得硬编码
`runtime/...` 路径字符串（迁移函数除外）。这些目录在 `.gitignore` 中被忽略。

## 关键设计决策
- **Flow 即 Agent Tool**: Flow 通过 `flowToAgentTool` 适配为 pi-agent 工具。所有注册 Flow 均暴露给 Agent，tag 仅用于分类和可观测性
- **Flow 注册集中在 bootstrap/flows.ts**: `registerFlows()` 中创建 FlowRegistry 并注册所有 Flow
- **Vite outDir 到 CFPABot/public/**: 生产时后端直接 serve，无需额外静态服务器
- **Agent 审查不经过 Flow 引擎**: 翻译审查使用 `agent/tools/` 中的原生工具直接调用 LLM，仅评论发布等写操作通过 Flow 引擎执行

## 部署约束

### 单实例部署（当前架构假设）

整个应用假设**单进程、单实例**部署。以下机制在单实例下工作，多实例部署会静默失效：

| 机制 | 实现 | 多实例风险 |
|---|---|---|
| 并发锁 (`withLock`) | `src/flows/_shared/lock.ts` — 进程内 `Map<string, Promise>` | 两个实例可同时持有"同一把锁"，导致并发 git push 冲突、重复评论 |
| 内存缓存 | `modlistCache`, `prsData` 等模块级变量 | 实例间缓存不同步，客户端看到过期数据 |
| Cron 任务 | `startCronTasks()` — `setInterval` | 每个实例都跑一遍，重复刷新、重复清理 |
| 执行记录 (NDJSON) | 文件 append | 两个实例可写同一文件，记录交错不可读 |

**扩展到多实例需要**：
- 用外部协调替代内存锁（如 Redis `SET NX`、文件锁 `flock`）
- 用外部缓存替代内存变量（如 Redis、共享 NFS）
- 用 leader-election 或外部调度替代本地 cron（如 BullMQ、Hangfire）
- 写日志到独立文件或集中式日志系统（避免 NDJSON 交错）

**不要**在未做上述改造的情况下启动多个实例。当前代码无分布式协调逻辑。
