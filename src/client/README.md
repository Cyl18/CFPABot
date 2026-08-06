# client/

`client/` contains reusable integrations with external systems or persistent resources. This includes HTTP APIs, local Git repositories, authentication, and other stateful access layers. It should not contain Flow-specific orchestration.

**放这里**：
- HTTP API 客户端（GitHub Octokit、CurseForge、Modrinth）
- GitHub App JWT 认证
- 本地 Git 操作（clone/commit/push）
- 任何与外部资源对话的代码

**不放这里**：
- Flow 编排逻辑
- 业务模型（如 PR relation graph）
- Flow 专用的纯计算
