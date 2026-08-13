# CFPABot

> [CFPAOrg/Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package) 的 PR 管理工具 + 网页面板。
>
> 原 [.NET 版](https://github.com/Cyl18/CFPABot) 的 TypeScript 重写，架构更干净，维护更轻松。

---

## 功能特性

### GitHub 机器人

- **自动 PR 评论** - 每个 PR 上自动发布动态评论，包含：
  - 🔍 **模组检测** - 识别 PR 中的模组并链接到 CurseForge / Modrinth
  - 📦 **构建产物** - PR Packer 生成的资源包下载链接
  - ✅ **自动检查** - 路径校验、大写警告、跨 PR 冲突检测、术语合规检查
  - 📊 **文件差异** - 中英文语言文件对比表
- **Webhook 事件处理** - PR 开启/同步/编辑/标签/关闭、Issue 评论、Workflow 运行
- **自动打标签** - 根据 PR 修改的行数和路径自动应用 `size:` / `area:` 标签
- **评论命令** - PR 评论中执行斜杠命令

### Web 面板

- PR 列表 + PR 详情（评论历史、文件变更）
- 交互式双语差异查看器（Compare Tool）
- LLM 驱动的翻译审查（实时 SSE 进度）
- Agent 对话（ReAct loop，Flow 即工具）
- Mod 列表浏览 + CurseForge 映射管理
- 日志查看、缓存管理、标签管理

### Agent 系统

- **ReAct Loop** - LLM 直接调用 Flow，不加 Planner 层
- **Mixture of Agents (MoA)** - 多模型并行审查 + 仲裁
- **Flow 即工具** - 每个业务操作是一个 Flow，Agent 自动发现可用工具

---

## 命令列表

所有命令仅 PR 提交者和仓库协作者可用。PR 评论中 `/` 开头触发。

| 命令 | 说明 |
|---|---|
| `/mv <a> <b>` | 移动文件或文件夹（支持引号包裹含空格的路径） |
| `/rename <a> <b>` | 重命名文件 |
| `/update-en <模组名> <版本>` | 更新英文源文件（版本: `1.12.2` `1.16` `1.18` `1.16-fabric` `1.18-fabric`） |
| `/sort-keys <路径>` | 重排 JSON 键序（适用于 MCreator） |
| `/format <文件>` | 格式化语言文件 |
| `/replace <旧文本> <新文本>` | 在翻译文件中批量替换文本 |
| `/add-co-author <用户>` | 为提交添加 co-author |
| `/revert <hash>` | 回退指定提交 |
| `/add-mapping <slug> <projectID>` | 添加 CurseForge slug -> ID 映射 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| **运行时** | Bun |
| **后端** | Hono + TypeScript |
| **前端** | Vite + React 19 + TypeScript |
| **样式** | Tailwind CSS |
| **AI** | @earendil-works/pi-agent-core (ReAct loop) |
| **状态** | Zustand |
| **存储** | 文件 (JSON / NDJSON)，无数据库 |
| **认证** | GitHub OAuth + cookie (AES-256-GCM) |

---

## 架构

```
                    ┌─────────────────────────────────────┐
                    │         Entry Points                │
                    │  GitHub Webhook │ REST API │ SSE    │
                    └────────┬────────┬──────────┬────────┘
                     │         │          │
                     ┌────────▼────────▼──────────▼────────┐
                     │         dispatch()                  │
                     │   switch/case → composite Flows     │
                     └────────┬────────────────────┬───────┘
                              │                    │
               ┌──────────────▼──┐     ┌───────────▼──────────┐
               │  Composite     │     │  Agent Session       │
               │  Event Flows   │     │  Manager (ReAct)     │
               │  (onPrOpened,  │     │  /api/sessions/*     │
               │   onPrSync...) │     │  (SSE streaming)     │
               └────────┬───────┘     └───────────┬──────────┘
                        │                         │
                     ┌──▼─────────────────────────▼──────────┐
                     │          Flow Registry                 │
                     │  register / get / list / search        │
                     └───────────────────────────────────────┘
                                      │
                                      ▼
                      ┌──────────────────────────────────────┐
                      │       Shared Utilities               │
                      │  flows/_shared (pure functions)      │
                      │  client/ (transport: GitHub, CF, MR) │
                      └──────────────────────────────────────┘
```

### 核心概念

**Flow** - 一等公民，每个业务操作是一个 Flow：

```ts
interface Flow<I, O> {
  name: string;
  description: string;
  meta: { timeout?, retry?, permission?, tags? };
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  execute(ctx: FlowContext, input: I): Promise<O>;
}
```

Agent 只认识 Flow，编排函数也只调 Flow。Flow 之间直接 `await flow.execute()` 组合，不需要 DAG 引擎。

**Shared Utilities** — 纯函数工具库 (`src/flows/_shared/`)，无副作用：

| 模块 | 职责 | 示例 |
|---|---|---|
| **analysis/** | PR 分析、路径校验、术语检查 | `validatePaths`, `analyzePR`, `formatRelationsWarning` |
| **diff/** | 语言文件差异计算 | `computeLangDiff`, `formatDiffTable` |
| **comment/** | 评论内容组装 | `assembleComment`, `buildCheckContent`, `chooseDeliveryChannel` |
| **term/** | 术语表格格式化 | `formatTermCheckTable` |
| **llm-review/** | LLM 审查流水线 | `LlmReviewPipelineImpl` |

外部副作用（GitHub API、磁盘、CurseForge/Modrinth）在 `src/client/` 中封装。

### Webhook 事件流

| 事件 | 编排器 | 执行的 Flow |
|---|---|---|
| `pull_request.opened` | onPrOpened (composite) | updatePrComment + checkLabels + updateLabels + refreshPrData + checkContributor (并行) |
| `pull_request.synchronize` | onPrSynchronized (composite) | updatePrComment + checkLabels + updateLabels + refreshPrData (并行) |
| `pull_request.edited` / `labeled` / `unlabeled` | onPrLabelChanged (composite) | checkLabels + updateLabels + refreshPrsCache; labeled 时额外触发 triggerAgentReview |
| `pull_request.closed` | onPrClosed (composite) | refreshPrData + refreshPrsCache |
| `issue_comment.created` / `edited` | dispatch.ts | forceRefresh（复选框）/ commandRouter（/cmd 命令） |
| `workflow_run` | dispatch.ts | updatePrComment（PR Packer artifacts）+ triggerAgentReview |

### 目录结构

以下路径相对 `CFPABot/` 内层目录（应用本体）：

```
src/
├── index.ts               # 入口：加载配置 + 启动 bootstrap
├── bootstrap.ts           # 服务器启动：Hono app + Flow 注册 + Bun.serve

├── config.ts              # 环境变量 + 常量
├── context.ts             # FlowContext 构建器
├── types.ts               # 核心类型定义
├── store.ts               # 文件存储
├── logger.ts              # 日志
├── cron.ts                # Cron 调度器
├── cron-tasks/            # 定时任务 (modlist-refresh, curseforge-mapping, pr-cache-refresh, cleanup)
├── agent/                 # Agent 系统
│   ├── session-manager.ts # ReAct loop + 会话管理
│   ├── llm-endpoints.ts   # LLM 模型注册/解析
│   ├── review-run/        # ReviewRun 状态机 + LLM worker 流水线
│   └── tools/
│       └── flow-adapter.ts # Flow -> AgentTool 转换
├── api/                   # HTTP 路由 (文件直接挂载, 无子目录)
│   ├── auth.ts            # OAuth cookie 认证 (AES-256-GCM)
│   ├── oauth.ts           # /api/oauth/* (GitHub OAuth)
│   ├── frontend.ts        # /api/frontend/* 薄入口
│   ├── frontend/          # 前端 API 子路由 (prs/pr/compare/compare-utils/modlist/csv/diff/stats/helpers, dev/)
│   ├── sessions.ts        # /api/sessions/* (CRUD + SSE)
│   ├── sessions-context.ts    # Session FlowContext 构建
│   └── compare-utils.ts       # Compare 工具 (ZIP 提取等)
├── engine/                # Flow 引擎
│   ├── registry.ts        # FlowRegistry 接口
│   ├── registry-store.ts  # 共享 FlowRegistry 单例
│   └── execute.ts         # Flow 执行 + NDJSON 日志
├── flows/                 # 全部业务逻辑 (Flow)
│   ├── index.ts           # Barrel export
│   ├── pr/                # PR 相关 Flow
│   │   ├── updatePrComment.ts
│   │   ├── checkLabels.ts / updateLabels.ts
│   │   ├── refreshPrData.ts / checkContributor.ts
│   │   ├── forceRefresh.ts
│   │   ├── llmReview.ts / postComment.ts / triggerAgentReview.ts
│   │   ├── onPrOpened.ts / onPrSynchronized.ts / onPrLabelChanged.ts / onPrClosed.ts
│   │   └── ...
│   ├── comment/           # 评论组装 Flow
│   │   ├── assembleComment.ts
│   │   ├── buildArtifactsSegment.ts
│   │   ├── buildCheckSegment.ts
│   │   ├── buildDiffSegment.ts
│   │   └── buildModLinkSegment.ts
│   ├── file/              # 文件操作 Flow
│   │   ├── moveProject.ts / renameFile.ts / fetchEnUs.ts
│   │   ├── replaceText.ts / sortKeys.ts / formatFile.ts
│   ├── git/               # Git 操作 Flow
│   │   ├── revertCommit.ts
│   ├── misc/              # 杂项 Flow
│   │   ├── commandRouter.ts / addCoAuthor.ts / addMapping.ts
│   │   └── refreshPrsCache.ts
│   └── _shared/           # 可复用工具库 (纯函数，无副作用)
│       ├── index.ts           # Barrel export
│       ├── event-utils.ts     # 共享 payload 提取工具
│       ├── parse-mod-path.ts  # Minecraft 模组路径解析
│       ├── pr-relation.ts     # PR 关系映射
│       ├── git-repo.ts        # 本地 Git 操作 (Bun.spawn)
│       ├── lock.ts            # 进程内并发锁
│       ├── check-run-format.ts    # CheckRun 格式化
│       ├── analysis/          # PR 分析
│       │   ├── pr-analyzer.ts / path-validator.ts / label-helper.ts
│       │   ├── mod-table.ts / key-analyzer.ts / mc-version.ts
│       │   ├── file-ops.ts / error-formatter.ts
│       ├── diff/              # 差异计算
│       │   ├── lang-file.ts / lang-differ.ts / diff-table.ts / format-lang.ts
│       ├── comment/           # 评论组装
│       │   ├── comment-assembler.ts / check-content.ts / delivery.ts
│       ├── term/              # 术语处理
│       │   ├── data.ts / checker.ts / table.ts
│       └── llm-review/        # LLM 审查
│           ├── pipeline.ts / pipeline-utils.ts / types.ts
├── client/                # 外部 API 客户端
│   ├── index.ts           # Barrel export
│   ├── github-client.ts   # GitHub API (Octokit 封装)
│   ├── github-app-auth.ts # GitHub App JWT 认证
│   ├── curseforge-client.ts   # CurseForge API
│   └── modrinth-client.ts     # Modrinth API
└── webhook/               # Webhook 处理
    ├── receiver.ts        # HMAC 验证 + 事件反序列化
    ├── dispatch.ts        # 事件 -> composite Flow 路由
    └── route.ts           # POST /api/webhook + GET 手动触发

web/
├── index.html             # Vite 入口 HTML
├── vite.config.ts         # Vite 配置 (proxy, outDir: ../public)
└── src/
    ├── main.tsx           # React 入口
    ├── App.tsx            # React Router 路由定义
    ├── index.css          # Tailwind 样式
    ├── components/        # Layout, Skeleton, ErrorBoundary
    ├── pages/             # 页面组件
    │   ├── Dashboard.tsx / dashboard/helpers.tsx
    │   ├── PrList.tsx / PrDetail.tsx
    │   ├── Compare.tsx / CompareIndex.tsx / compare/ (DiffTable, SourcePanel, StatBadge, types)
    │   ├── Sessions.tsx / sessions/ (helpers, components)
    │   ├── AdminPanel.tsx / Cache.tsx / Logs.tsx
    │   └── NotFound.tsx
    ├── hooks/
    │   └── useAgentChat/  # useAgentChat 拆分 (protocol, normalize, index)
    ├── stores/
    │   └── authStore.ts   # Zustand 认证状态
    ├── lib/
    │   └── api.ts         # API 客户端
    └── types/             # 前端类型 (空目录, 类型集中在 lib/api.ts)
```

---

## 快速开始

### 前置要求

- [Bun](https://bun.sh) ≥ 1.0
- GitHub App（PEM 私钥 + Installation ID）

### GitHub App 设置

1. 在 GitHub 创建 GitHub App（组织设置 → Developer settings → GitHub Apps → New）
2. 配置权限：Commit statuses (RW), Contents (RW), Issues (RW), Metadata (RO), Pull requests (RW)
3. 生成 Private Key（PEM），下载后放到 `config/cfpa-bot.pem`
4. 安装 App 到目标仓库，从 URL 获取 Installation ID（`/settings/installations/{id}`）
5. 填入 `.env`：`GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`

### 安装 & 开发

```bash
# 克隆
git clone https://github.com/Cyl18/CFPABot.git
cd CFPABot/CFPABot    # 应用本体（仓库根下的 CFPABot/ 内层目录）

# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_WEBHOOK_SECRET

# 开发模式（同时启动后端 + Vite HMR）
bun run dev
```

> 所有 bun 命令在 `CFPABot/` 内层目录运行（bun 从 cwd 找 package.json/bunfig.toml）。

开发模式下访问 `http://localhost:5173`（Vite dev server，API 自动代理到 8080）。

### 生产构建

```bash
bun run build      # 前端 -> public/，后端 -> dist/
bun run start      # bun run dist/index.js
```

### 类型检查

```bash
bun run typecheck  # 内层 (后端 tsc --noEmit)
cd web && bun run typecheck  # 前端 tsc --noEmit
```

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `GITHUB_APP_ID` | ✅ | GitHub App ID（JWT 认证） |
| `GITHUB_APP_INSTALLATION_ID` | ✅ | GitHub App Installation ID |
| `GITHUB_APP_PEM_PATH` | ❌ | RSA 私钥路径（默认 `config/cfpa-bot.pem`） |
| `GITHUB_OAUTH_TOKEN` | ❌ | PAT（个人操作：Gist、GraphQL） |
| `GITHUB_WEBHOOK_SECRET` | ✅ | Webhook HMAC 验证密钥 |
| `OAUTH_CLIENT_ID` | ❌ | GitHub OAuth App ID（前端登录） |
| `OAUTH_CLIENT_SECRET` | ❌ | GitHub OAuth App Secret |
| `CF_API_KEY` | ❌ | CurseForge API 密钥 |
| `PORT` | ❌ | 服务端口（默认 8080） |
| `LOG_LEVEL` | ❌ | 日志级别（debug/info/warn/error） |
| `ASPNETCORE_ENVIRONMENT` | ❌ | 设为 `Development` 跳过 OAuth 检查 |

LLM 审查通过通用插槽配置（支持任意数量和提供商）：

```
LLM_1_PROVIDER=openai           # openai | anthropic
LLM_1_URL=https://api.openai.com/v1
LLM_1_KEY=sk-...
LLM_1_MODEL=gpt-4o

LLM_2_PROVIDER=anthropic
LLM_2_URL=https://api.anthropic.com/v1
LLM_2_KEY=sk-ant-...
LLM_2_MODEL=claude-sonnet-4-20260514
```

---

## 部署

### Docker

```bash
docker build -t cfpabot .
docker run -d \
  -p 8080:8080 \
  -e GITHUB_APP_ID=xxx \
  -e GITHUB_APP_INSTALLATION_ID=xxx \
  -e GITHUB_WEBHOOK_SECRET=xxx \
  -v ./config:/app/config \
  -v ./runtime:/app/runtime \
  cfpabot
```

### 手动

```bash
bun install --production
bun run build
bun run start
```

Nginx 反代需配置 SSE（`/api/sessions/:sessionId/stream` 路径，需禁用代理缓冲）。

---

## 设计哲学

- **Flow 是一等公民** - Agent 只认识 Flow，编排只调 Flow
- **Shared Utilities 纯函数分离** - `flows/_shared/` 纯计算，`client/` 封装外部副作用
- **Imperative 组合** - Flow A 直接 `await Flow B.execute()`，不引入 DAG
- **ReAct 不过度设计** - 决策深度 1~3 层，不加 Planner
- **文件即存储** - JSON + NDJSON，不引入数据库
- **自动执行记录** - 每次 Flow 调用写入 `runtime/ops/executions/{prId}.ndjson`

---
