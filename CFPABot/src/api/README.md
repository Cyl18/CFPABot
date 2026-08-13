# src/api/

入站适配层。接收 HTTP 请求，做 HTTP 职责，然后交给 `flows/`。

## 可以做

- 路由绑定 (`app.get`, `app.post` ...)
- auth / session / cookie 读取
- 解析 path / query / body
- schema 校验（HTTP body → Input DTO）
- 构造 FlowContext / dependencies
- 调用 flow
- flow result → HTTP response

## 禁止

- `import` `node:fs`, `Bun.file`, raw `fetch`, `octokit`
- `import` `flows/_shared/*`
- 编排多个 `client/` 调用
- 业务判断、字段聚合、filter/map/reduce
- 直接操作 GitHub API endpoint 选择

## 唯一例外：直通

满足以下**全部**条件时才允许直接调 `client/`：

1. 只调一个 client 方法
2. 无业务逻辑（无 filter/map/多数据源/字段重组/缓存决策）
3. 直接返回 client 结果

示例：`GET /api/frontend/rate-limit` → `github.getRateLimit()` → `c.json(...)`

## 原则

**api 可以薄，但不能透明。它是 HTTP adapter，不是业务层，也不是裸代理。**

HTTP body 必须经过 schema 校验变成可信的 Input DTO，才能传给 flow。禁止原样下传。
