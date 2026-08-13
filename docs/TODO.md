# CFPABot 技术债务 & 待办清单

## P2 — Agent 审查（轻量路径落地后）

- [ ] **词典真后端** — `dict_lookup` 目前 stub；接入现成词典库
- [ ] **forced_vanilla 原版术语** — 强制注入原版术语数据源，写入 `ctx.dict` source=`forced_vanilla`
- [ ] **inline comment** — `review_comment` 目前仅 Mode A issue comment；后续支持 PR inline
- [ ] **ctx 落盘** — session ctx 现为进程内存；需要时可落 `runtime/sessions/{id}/ctx.json`
- [ ] **PR 审查记录关联** — 同一 PR 的多个 /agent-review 会话保持独立运行，但提供按 PR 聚合的历史审查视图（feat；含 supersedesSessionId 引用 + inline review 整批事务方案：先验 hunk 再提交、坏行移入总正文、suggestion 仅 RIGHT side）
- [ ] 
 1. 评论功能现在是整体关闭状态(三重关闭:白名单摘除 + risk 卡 admin 确认 + REVIEW_PUBLISH_ENABLED 默认 false)。将来要恢复 /agent-review
    正常发表,需要三步一起开,且只能 admin 确认后放行 — 别只开 env 就以为能发。这是有意为之,但下次排障时最容易被忘。
 2. 旧报告已过时:PR #6105 上那条评论和 1b13446d 的 finalTable 都基于旧代码(batch=159、SKILL 未注入)。如果哪天想重新审这个 PR,建议新代码重跑 — 按 A/B
    数据,新配置会多发现约 20 条意见。当然,重跑 = 再发一条评论,需要你点头。
 3. gpt-5.6-luna 切换的前置检查已记入 memory 和文档:确认 opencode-go 平台的确切模型 ID(可能带 -chat 后缀)→ 直连验证 → 再加进
    llm-endpoints.json。llm-registry.ts 目前没有该条目,直接配会报模型未注册。
 4. temp/ab*.json 是运行时临时文件:cleanup cron 可能会清掉。结论已完整固化在 docs/review-pipeline-batch-research-2026-08-01.md,原始 JSON
    丢了也不影响,只是没法再逐条翻。