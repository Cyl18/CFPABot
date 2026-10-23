# CFPABot v2

CFPA 汉化包仓库（`CFPAOrg/Minecraft-Mod-Language-Package`）的 PR 审查面板与自动化 Bot。

- 后端：Bun + Hono，负责 GitHub App/OAuth、PR 数据抓取、语言文件检查、webhook 与 Agent 会话
- 前端：React 19 + Vite + Tailwind，构建产物由后端直接托管
- Agent：基于 `@oh-my-pi/pi-coding-agent`，在会话里读文件、跑命令、写审查草稿

## 功能

- PR 列表与详情：概览、文件、工作区对比、跨版本、特殊格式、已有 Review
- 语言文件检查：JSON 语法、重复/缺失 key、术语一致性、错别字
- 模组与版本浏览、任意两个版本的键值对比、Bot 命令速查
- GitHub Bot：PR webhook 评论、`/` 命令
- Agent 会话：模型/思考级别/关联 PR 可在会话内切换；执行与 GitHub 写权限按会话开关；审查草稿可在面板里编辑并发布
- 管理面板：LLM 端点、CurseForge 映射、日志、缓存刷新

## 目录

```
CFPABot/
  server/              后端（Bun）
    http/              Hono 路由
    bot/               webhook 与命令
    agent/             Agent 会话、工具、工作流
    domain/            语言文件、术语、检查等纯逻辑
  web/                 前端（Vite）
  packages/contracts/  前后端共享类型
  packages/review-core/ 审查领域逻辑（可单测）
  config/              运行时配置（llm.json 等不入库）
  skills/              Agent 技能
  scripts/             构建辅助
```

## 本地开发

需要 [Bun](https://bun.sh)（构建镜像用 1.4）。

```bash
cd CFPABot
bun install
cp .env.example .env      # Windows: copy .env.example .env
bun run dev
```

- 后端 `http://localhost:8080`
- 前端 `http://localhost:5173`，`/api`、`/auth`、`/healthz` 代理到 8080

开发模式可以跳过 OAuth：设置 `DEV_LOGIN` 与 `DEV_GITHUB_TOKEN`（同一账号），请求会按该账号的仓库管理员处理。生产环境务必设 `NODE_ENV=production`，否则同样会开启这个后门。

## 配置

### 环境变量

完整列表见 `.env.example`，常用的：

| 变量 | 说明 |
|---|---|
| `NODE_ENV` | `development` / `production` / `test` |
| `PORT` | 监听端口，默认 8080 |
| `PUBLIC_URL` | 对外地址，OAuth 回调与评论里的链接都以它为准 |
| `GITHUB_REPO` | 目标仓库，`owner/name` |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub App 凭据，三者齐全时优先使用 |
| `GITHUB_WEBHOOK_SECRET` | 未配置时 `/api/webhook` 返回 503 |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | 面板登录；未配置时无法登录 |
| `GITHUB_PAT` | 没有 App 凭据时的回退；都没有则匿名只读 |
| `BOT_LOGIN` | Bot 账号名，用于判定评论作者 |
| `CURSEFORGE_API_KEY` | 未配置时跳过 CurseForge 查询与映射扫描 |
| `GLOSSARY_BIN` | 术语查询工具，未配置时该工具报告不可用 |

认证优先级：GitHub App → PAT → 匿名只读。

### LLM

Agent 会话需要 `config/llm.json`（**不入库**）：

```json
{
  "endpoints": [
    {
      "id": "openai/gpt-4o",
      "provider": "openai",
      "protocol": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-4o",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "thinking": "medium"
    }
  ],
  "roles": {
    "default": "openai/gpt-4o:medium",
    "taska": "openai/gpt-4o"
  }
}
```

- `protocol`：`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`
- `roles`：模型别名，值为 `<endpoint id>[:<thinking>]`，思考强度绑在别名上；`default` 是主模型，其余别名用 `delegate` 工具派子代理，或在 eval 里 `await completion(prompt, model="@taska")` 单次调用
- 也可以登录面板后在「管理 → LLM」里增删端点，保存时写回这个文件
- 没有可用模型时仍能创建会话，但错误会显示在会话里，配好模型后直接再发消息即可

## 部署（Docker）

```bash
cd CFPABot
cp .env.example .env      # 填生产值
docker compose up -d --build
```

- 构建上下文是仓库根（compose 里 `context: ..`），镜像里跑 `bun dist/main.js`
- 端口 `8080`，健康检查 `GET /healthz` 返回 `OK`
- 卷：
  - `./config → /app/config`：放 `llm.json`、`*.pem`、术语表等，**不要打进镜像**
  - `./runtime → /app/runtime`：会话、缓存、工作区。迁移机器时带上它（至少 `sessions/`）
- 升级：改完代码重新 `docker compose up -d --build`，数据都在卷里

反向代理把整站转到 8080 即可。SSE（`/api/sessions/:id/events`）经过 nginx 时建议关闭缓冲，否则消息会攒批：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## 检查与测试

```bash
cd CFPABot
bun run typecheck
bun test server
bun test packages/review-core
```

## 不入库的文件

`.env`、`config/llm.json`、`config/*.pem`、`config/secret.key`、`runtime/` 都被 `.gitignore` 排除。提交前确认没有把凭据带进仓库。
