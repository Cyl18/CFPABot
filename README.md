# CFPABot v2

CFPA 汉化包仓库（`CFPAOrg/Minecraft-Mod-Language-Package`）的 PR 审查面板与自动化 Bot。

- 后端 Bun + Hono，构建产物自带前端；前端 React 19 + Vite + Tailwind
- Agent 基于 `@oh-my-pi/pi-coding-agent`，在会话里读文件、跑命令、写审查草稿

## 功能

- PR 列表与详情：概览、文件、工作区对比、跨版本、特殊格式、已有 Review
- 语言文件检查：JSON 语法、重复/缺失 key、术语一致性、错别字
- 模组与版本浏览、任意两版键值对比、Bot 命令速查
- GitHub Bot：webhook 评论与 `/` 命令
- Agent 会话：模型/思考级别/关联 PR 可在会话内切换，执行与 GitHub 写权限按会话开关，草稿可编辑后发布
- 管理面板：LLM 端点、CurseForge 映射、日志、缓存刷新

## 目录

```
CFPABot/
  server/              后端：http 路由、bot、agent、harness（审查数据面）、domain
  web/                 前端
  packages/            contracts（共享类型）、review-core（审查领域逻辑）
  config/              运行时配置（不入库）
  skills/              Agent 技能：prep、translate、post
  scripts/             构建辅助
```

## 本地开发

需要 [Bun](https://bun.sh) 1.4。

```bash
cd CFPABot
bun install
cp .env.example .env      # Windows: copy .env.example .env
bun run dev               # 后端 :8080，前端 :5173（/api /auth /healthz 代理到 8080）
```

开发模式可跳过 OAuth：设 `DEV_LOGIN` 与 `DEV_GITHUB_TOKEN`（同一账号）即按仓库管理员处理。生产必须 `NODE_ENV=production`，否则该后门同样生效。

## 配置

环境变量完整列表见 `.env.example`，常用的：

| 变量 | 说明 |
|---|---|
| `PUBLIC_URL` | 对外地址，OAuth 回调与评论链接以它为准 |
| `GITHUB_REPO` | 目标仓库，`owner/name` |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub App 凭据 |
| `GITHUB_WEBHOOK_SECRET` | 未配置时 `/api/webhook` 返回 503 |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | 面板登录；未配置时无法登录 |
| `GITHUB_PAT` | 读取回退；另用于超长内容的 Gist 外链 |
| `CURSEFORGE_API_KEY` | 未配置时跳过 CurseForge 查询与映射扫描 |

身份分工：

- 读取：`DEV_GITHUB_TOKEN` → GitHub App → `GITHUB_PAT` → 匿名只读；review thread 这类 GraphQL 读取优先 App
- 写入（评论、标签、check run、review、打包器审批）：固定 App 身份，缺少 App 凭据时整体停用，返回 403 `bot_writes_disabled`
- 代表本人的操作（发 review 评论、回复 thread、标记已读）：用你的 OAuth token

### LLM

Agent 会话需要 `config/llm.json`（**不入库**，也可在「管理 → LLM」里改）：

```json
{
  "endpoints": [
    {
      "id": "openai/gpt-4o",
      "provider": "openai",
      "protocol": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "env:OPENAI_API_KEY",
      "model": "gpt-4o",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "thinking": "medium"
    }
  ],
  "roles": { "default": "openai/gpt-4o:medium", "taska": "openai/gpt-4o" }
}
```

- `protocol`：`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`
- `apiKey` 可写 `env:变量名` 从环境变量取；面板里留空表示保留原值
- 同一 `provider` 的端点必须共用 `baseUrl`、`protocol` 与密钥，否则保存报错、会话也打不开。官方与中转、不同协议请各起一个 `provider` 名
- `roles` 是模型别名，`default` 为主模型，其余别名供 `delegate` 派子代理或 eval 里 `await completion(prompt, model="@taska")`

## 部署（Docker）

```bash
cd CFPABot
cp .env.example .env      # 填生产值
docker compose up -d --build
```

- 构建上下文是仓库根（compose 里 `context: ..`），镜像跑 `bun dist/main.js`，端口 8080，健康检查 `GET /healthz`
- 卷：`./config → /app/config`（`llm.json`、`*.pem`、术语表等，不打进镜像）、`./runtime → /app/runtime`（会话、缓存、工作区，迁移机器时带上）
- 升级：重新 `docker compose up -d --build`，数据都在卷里

反代整站到 8080 即可；SSE（`/api/sessions/:id/events`）经 nginx 时关闭 `proxy_buffering` 并调大 `proxy_read_timeout`。

## 检查与测试

```bash
cd CFPABot
bun run typecheck
bun test server
```

`.env`、`config/llm.json`、`config/*.pem`、`config/secret.key`、`runtime/` 均被 `.gitignore` 排除，提交前确认没带凭据。
