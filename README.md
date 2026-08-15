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
                 ┌────────────────────────────────────────────┐
                 │                Entry Points                │
                 │  Webhook (202 后后台执行)                  │
                 │  REST API (/api/frontend, /api/sessions)   │
                 │  SSE (/api/sessions/:id/stream)            │
                 └────────┬──────────────┬─────────────┬──────┘
                          │              │             │
               ┌──────────▼─────┐  ┌─────▼──────┐  ┌───▼───────────┐
               │ webhook/       │  │ api/       │  │ agent/        │
               │ dispatch.ts    │  │ frontend/  │  │ session-*     │
               │ direct/agent   │  │ sessions   │  │ flow-adapter  │
               │ commands       │  │ (HTTP DTO) │  │ ReAct loop    │
               └──────────┬─────┘  └─────┬──────┘  └───┬───────────┘
                          │              │             │
                          └──────────────┼─────────────┘
                                         ▼
                              executeFlow(flow, ctx, input)
                                · TypeBox 校验 · 风险策略
                                · 幂等 · 重试 · 超时 · NDJSON
                                         │
                                  FlowRegistry
                                         │
                          ┌──────────────┴──────────────┐
                          │  flows/  (原子业务操作)     │
                          │  flows/_shared/ (纯函数)    │
                          │  client/   (外部副作用)     │
                          └─────────────────────────────┘
```

入口层只做协议转换和编排，所有业务副作用都经 `executeFlow()` 进入 Flow。Webhook 在完成
HMAC / 去重 / DTO 转换后立即返回 202，真实处理在后台任务中执行并由优雅停机逻辑 drain。

### 核心概念

**Flow** — 每个业务操作是一个 Flow，使用 TypeBox 作为唯一 schema：

```ts
interface Flow<InputSchema, OutputSchema> {
  name: string;                 // snake_case，1-64 字符
  description: string;
  input: InputSchema;           // TypeBox
  output: OutputSchema;         // TypeBox
  meta: {
    tags: readonly string[];
    risk: "read" | "review_write" | "repository_write" | "destructive";
    effects: readonly FlowEffect[];
    timeoutMs?: number;
    retry?: { maxAttempts: number; backoffMs: number };
    idempotencyKey?: (invocation, input) => string;
    agent_callable?: boolean;
  };
  execute(ctx: FlowContext, input: Input): Promise<Output>;
}
```

- 生产调用必须经过 `executeFlow()`，不直接 `flow.execute()`。
- Flow 之间不互相调用；固定编排在 dispatch，动态编排由 Agent 连续调用 Tool。
- 注册时校验元数据：`read` 不能声明写 effect，配置 retry 必须提供幂等键，写风险必须声明写 effect。
- Agent 可见性由 `src/agent/flow-policy.ts` 的显式白名单控制，不自动等同于 `agent_callable`。

**Shared Utilities** — `flows/_shared/` 保持纯函数、无 I/O、无全局状态；实际子目录：

| 模块 | 职责 |
|---|---|
| `language/` | 语言文件解析、差异计算、格式化、键分析 |
| `terminology/` | 术语检查、n-gram、TM 匹配 |
| `project-path/` | Minecraft 模组路径解析 |
| `markdown/` | Markdown 转义与评论/审查报告渲染 |
| `review/` | 审查共享算法（term projection 等） |

外部副作用封装在 `client/`：GitHub、本地 Git、CurseForge、Modrinth、LLM 模型探测。

### Webhook 事件流（当前实现）

| 事件 | 路由 | 执行的 Flow |
|---|---|---|
| `pull_request.opened` / `synchronize` | dispatch.ts | `packer_auto_approve` → 并行 `info_comment_refresh` + `checks_run_label_guard` + `labels_sync` + `pr_cache_refresh` |
| `pull_request.edited` | dispatch.ts | 并行 `checks_run_label_guard` + `labels_sync` |
| `pull_request.labeled` / `unlabeled` | dispatch.ts | `checks_run_label_guard` |
| `pull_request.closed` | dispatch.ts | `pr_cache_refresh(mode=remove_closed)` |
| `issue_comment.created` | direct-commands / agent-command | 单列命令直连 Flow；`/agent`、`/agent-review` 创建 Session |
| `issue_comment.edited` | dispatch.ts | 复选框触发 `info_comment_force_refresh` |
| `workflow_run.completed` | dispatch.ts | PR Packer 成功时 `info_comment_refresh_artifacts` |
| `push`（默认分支） | dispatch.ts | `modlist_refresh(force=true)` |

完整目录树以 `AGENTS.md` 为准。关键结构：

```
src/
├── bootstrap/          # 组合根：deps → routers → app → server
├── api/
│   ├── webhook/        # HMAC、DTO、dispatch、命令处理（router factory）
│   ├── frontend/       # 薄 HTTP 路由，调用 executeFlow
│   └── sessions.ts     # createSessionsRouter(deps) 工厂
├── agent/              # SessionService、PiSessionManager、原生 Agent tools
│   └── tools/          # review-moa/align/aggregate/finalize 等 LLM 工具
├── engine/             # registry、executeFlow、policy、idempotency、retry、timeout
├── flows/              # 原子业务 Flow（pr/info-comment/files/git/compare/cache/...）
└── client/             # GitHub/Git/CurseForge/Modrinth 适配器
```

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
