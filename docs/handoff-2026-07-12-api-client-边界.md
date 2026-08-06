# Handoff: api/client 边界重构

> **注意**: 本文为 2026-07-12 的架构决策记录。此后 batch 5 重构移除了 `api/reviews.ts`、`api/sessions-context.ts`，
> 将 `client/durable-json.ts` 移至 `_shared/fs-utils.ts`，并新增 `bootstrap/` 目录。
> 违反清单中标注的 RED/YELLOW/BLUE 项可能已部分修复；建议以最新代码为准。
> 本文的三层架构规则（api → flow → client）和直通例外原则仍然有效。

2026-07-12

## 已确定的架构规则

```
api/   = inbound adapter  — HTTP 职责；不关心业务；校验输入后调 flow
flows/ = orchestration    — 业务编排；不关心 HTTP；通过 flows/_shared/ 共享业务纯函数
client/ = outbound adapter — 外部数据源访问；不关心业务页面
```

### api/ 职责边界

```text
HTTP request
  ↓
api/
  - route 绑定
  - auth/session/cookie
  - 读取 path/query/body
  - 基础 schema 校验（HTTP body → Input DTO）
  - 构造 context/dependencies
  - 调用 flow
  - 把 flow result 转成 HTTP response
  ↓
flows/
  - 业务编排
  - 调多个 client
  - 业务判断、过滤、聚合、diff、生成结果
  ↓
client/
  - GitHub / 本地 repo / cache file / OAuth / 其他外部系统
```

**核心原则：`api` 可以薄，但不能透明。它是 HTTP adapter，不是业务层，也不是裸代理。**

api 关心 HTTP，不关心业务。api 接到请求后只做 HTTP 层职责，然后把请求交给 flows/；只有纯透传场景才可以直接打 client/。

POST body 不建议原样传到底。API 层至少应把"不可信 HTTP 输入"变成"已校验 Input DTO"：

```ts
// ✅ 正确：api 校验后传 Input DTO
const input = validateCreateCommentInput(await c.req.json())
await createCommentFlow({ github, input })

// ❌ 错误：HTTP body 原样往下传
await createCommentFlow({ github, body: await c.req.json() })
```

### 直通例外（api → client 可接受）

只有**同时满足所有条件**时才允许 api 直接调 client：

- 只调用**一个** client 方法
- 没有 `if`/`for`/`filter`/`map`/`reduce`
- 没有业务字段重组
- 没有多个数据源
- 没有缓存决策
- 没有错误语义转换（HTTP adapter 级别的 401/400/500 除外）

```ts
// ✅ 纯透传：单 client 调用 + 无转换
app.get('/api/frontend/rate-limit', async (c) => {
  const user = requireUser(c)
  const github = createUserGitHubClient(user.token)
  return c.json(await github.getRateLimit())
})
```

一旦出现以下任何一种情况，必须进 `flows/`：

```ts
// ❌ 应进 flow：有 filter/map、多数据源、字段重组
const prs = await github.listPulls(...)
const filtered = prs.filter(...)
const withMods = prs.map(...)
return c.json({ items: withMods })
```

### 硬约束

- `api/` 禁止 import: `node:fs`, `Bun.file` (数据读取), raw `fetch`, `octokit`
- `api/` 禁止 import: `flows/_shared/*`
- `api/` 禁止编排多个 `client/` 调用——超过一步必须走 Flow
- `flows/_shared/` 禁止被非 `flows/` 模块调用
- `client/` 只放"访问或解释外部数据源"的代码——不放业务语义函数

## 现状违规范总

### 🔴 RED — 直接外部访问（需封装到 client/）

| ID | 文件 | 违规内容 | 目标 |
|---|---|---|---|
| R1 | `api/frontend/modlist.ts:32-48` | `existsSync`/`readdirSync` 读 `projects/assets/` | 封装到 `client/local-repo.ts` |
| R2 | `api/frontend/compare.ts:59-129` | `existsSync`/`readFileSync`/`readdirSync` 读本地 repo | 封装到 `client/local-repo.ts` |
| R3 | `api/frontend/dev/index.ts:130-152` | `Bun.file("runtime/cache/*")` 读 cache | 封装到 `client/cache.ts` |
| R4 | `api/bmcl-modlist.ts:64-86` | `Bun.file("runtime/cache/*")` 读 cache | 封装到 `client/cache.ts` |

### 🟡 YELLOW — 走 client 但用 fetchJson 逃生口（需填充 typed methods）

| ID | 文件 | 原始 API 路径 | 修复方式 |
|---|---|---|---|
| Y1 | `frontend/prs.ts:64` | `GET /repos/.../pulls` | 新增 `GitHubClient.listPulls()` |
| Y2 | `frontend/prs.ts:76` | `GET /repos/.../pulls/{num}/files` | 使用已有的 `getPullRequestFiles()` |
| Y3 | `frontend/stats.ts:34-68` | `GET /search/issues` (x4) | 新增 `GitHubClient.searchIssues()` |
| Y4 | `frontend.ts:53` | `GET /rate_limit` | 使用已有的 `getRateLimit()` |
| Y5 | `frontend.ts:107` | `POST /repos/.../issues/{id}/comments` | 使用已有的 `createIssueComment()` |
| Y6 | `frontend/csv.ts:29-35` | `GET /repos/.../pulls/{id}` | 使用已有的 `getPullRequest()` |
| Y7 | `frontend/compare.ts:86` | Git Trees API | 新增 `GitHubClient.getGitTree()` |

### 🔵 FLOW — api 厚逻辑应提取为 Flow（削薄阶段）

| 文件 | 当前行数 | 建议 Flow |
|---|---|---|
| `frontend/prs.ts` | ~150 | `listFrontendPrsFlow` |
| `frontend/stats.ts` | ~100 | `getFrontendStatsFlow` |
| `frontend/compare.ts` | ~580 | `compareModsFlow` |
| `frontend/csv.ts` | ~130 | `exportCompareCsvFlow` |
| `frontend/diff.ts` | ~100 | `getModDiffFlow` |
| `frontend/modlist.ts` | ~90 | （RED 修复后可能不再需要 Flow，直通即可） |

### 🟢 MOVE — 函数归属调整（HTTP helper 留在 api，其余归位）

| 函数 | 当前位置 | 应去位置 |
|---|---|---|
| `csvEscape` | `api/frontend/helpers.ts` | 留 `api/`（HTTP 表达格式） |
| `generateCsv` | `api/frontend/helpers.ts` | 随 csv Flow 迁移，或留 api 如果只负责格式 |
| `listZipEntries` | `api/frontend/compare-utils.ts` | `client/local-repo.ts` 内部（zip 是数据源解析） |
| `extractZipEntry` | `api/frontend/compare-utils.ts` | 同上 |
| `normalizeModPath` | `api/frontend/helpers.ts` | `flows/_shared/mod-path.ts`（现有）——前提是 api 不再直接调用 |
| `countMods` | `api/frontend/helpers.ts` | `flows/_shared/mod-groups.ts`——前提同上 |
| `groupFilesByMod` | `api/frontend/helpers.ts` | `flows/_shared/mod-groups.ts`——前提同上 |
| `parseModPath` | `flows/_shared/parse-mod-path.ts` | 留在原处 ✅ |

## 推荐执行顺序（三阶段）

### 阶段 1：立规矩（封住恶化）

1. 统一 `GitHubClient` 接口：
   - 当前 `GitHubClient`（Octokit，给 flows）和 `UserGitHubClient`（raw fetch，给 api）统一为同一 interface
   - 三实现：`OctokitGitHubClient` / `UserTokenGitHubClient` / `MockGitHubClient`
2. 填充 typed methods：
   - `listPulls(params)` → 修 Y1
   - `searchIssues(query)` → 修 Y3
   - `getGitTree(path, recursive?)` → 修 Y7
3. 替换已有方法的原始调用：
   - `getPullRequestFiles()` → 修 Y2
   - `getRateLimit()` → 修 Y4
   - `createIssueComment()` → 修 Y5
   - `getPullRequest()` → 修 Y6
4. `fetchJson` 降级为 private/internal（仅实现类内部可见，interface 不暴露）
5. 加架构 lint（CI 脚本禁止 `node:fs`/`Bun.file`/`octokit` import 到 api/）

### 阶段 2：堵 RED（移除直接外部访问）

1. 新增 `client/local-repo.ts`（封装 `projects/assets/` 读取）
2. 新增 `client/cache.ts`（封装 `runtime/cache/*.json` 读取）
3. 改 `modlist.ts`、`compare.ts`、`dev/index.ts`、`bmcl-modlist.ts` 改为调用新 client

### 阶段 3：削薄（api → flow）

按影响面从小到大：
1. `prs.ts` → `listFrontendPrsFlow`
2. `stats.ts` → `getFrontendStatsFlow`
3. `diff.ts` → `getModDiffFlow`
4. `csv.ts` → `exportCompareCsvFlow`
5. `compare.ts` → `compareModsFlow`

## 关键设计决策记录

1. **不加根级 `shared/`：** 通过削薄 api 层让函数留在原主那里，避免为"被多处调用"而造共享目录。
2. **`client/` 不是工具函数收纳箱：** 只放"访问或解释外部数据源"的代码。业务语义函数（groupFilesByMod, countMods）留在 `flows/_shared/`。
3. **`flows/_shared/` 是 flows 内部共享域：** 只有 flows 可以 import。api/ 需要该功能 → api 应改为调 Flow，不能直接 import。
4. **直通例外：** 单 client 方法 + 无转换 → 可以不走 Flow。
5. **阶段 1 和 2 可并行：** 改的文件几乎没有重叠。
