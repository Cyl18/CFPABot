# src/flows/

原子业务操作层。公开 Flow 可独立校验、记录和执行，并由 Registry 适配为 Agent Tool。

## 可以做

- 业务操作定义（`Flow<I, O>` 实现）
- 编排多个 `client/` 调用
- 业务判断、过滤、聚合、retry、sequencing
- 调用 `flows/_shared/` 中的纯函数

## 禁止

- HTTP 相关操作（request/response/cookie/header 解析）
- 直接 import `node:fs` / `Bun.file` 做**数据**读取（基础设施型存储通过 `FileStore` 接口）
- 引用 `web/` 前端代码
- Flow 直接调用另一个 Flow 的 `execute()`；固定组合由入站 adapter 调 `executeFlow()`，动态组合由 Agent 完成

## 子目录约定

| 目录 | 用途 |
|---|---|
| `review/` | PR 上下文、代码/翻译分析与 Agent Review 发布 |
| `info-comment/` | 主 Bot 信息评论业务操作及其领域 internal helper |
| `checks/` | Check Run 与规则检查 |
| `labels/` | 标签计算与同步 |
| `files/` | 闭合的文件修改业务操作 |
| `git/` | 闭合的 Git 业务操作 |
| `mappings/` | 外部项目映射维护 |
| `_shared/` | **纯函数**工具库（无 I/O、无全局状态） |

## `_shared/` 铁律

- 只放纯计算、格式化、分析、组装函数
- **无 I/O**：不读文件、不写文件、不调用 API
- **无全局状态**：不维护可变 singleton
- 只有 `flows/` 可以 import它。`api/` 需要该功能 → 改为调 Flow

## Flow 注册

所有 Flow 在 `bootstrap.ts` 中显式注册到 `FlowRegistry`。

Flow name 使用可直接传给 LLM provider 的 `snake_case`；所有生产调用必须经过 `executeFlow()`。

完整约束见 [`docs/flow-architecture-spec.md`](../../docs/flow-architecture-spec.md)。
具体 Flow 清单、程序/Agent 编排和公共方法提取见 [`docs/specs/README.md`](../../docs/specs/README.md)。

## 原则

**flows 关心业务，不关心 HTTP。** 不知道请求从哪里来，也不知道结果去哪里。
