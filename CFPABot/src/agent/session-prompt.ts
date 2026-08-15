// src/agent/session-prompt.ts
// Pure prompt construction for agent sessions. Pi resource loading
// (extensions/MCP/skills) lives in src/agent/pi-runtime.ts.

import type { SessionRecord } from "./session-types.js";

/**
 * Validate that active tool names include all expected names. Extension tools
 * (pi-mcp-adapter 的 mcp/mcp_script 等官方机制注册的额外工具) are allowed and
 * ignored — only missing expected tools are an error.
 */
export function validateToolSet(
  activeNames: ReadonlySet<string>,
  expectedNames: ReadonlySet<string>,
): string | null {
  const missing: string[] = [];
  for (const name of expectedNames) {
    if (!activeNames.has(name)) missing.push(name);
  }
  if (missing.length === 0) return null;
  return `Missing tools: [${missing.join(", ")}]. `;
}

/**
 * Build the prompt text for an agent session.
 * When promptOverride is provided (from continueSession), use it directly.
 * Otherwise derive a first-turn prompt from the PR scope + objective.
 *
 * For sessions whose objective starts with /skill:translation-review (the
 * /agent-review command), emit the skill command so pi-coding-agent expands
 * config/pi-agent/skills/translation-review/SKILL.md into the first-turn
 * user message
 * (SDK `_expandSkillCommand`, see agent-session.js).
 *
 * 注意: SDK 的 _expandSkillCommand 用「第一个空格」分隔 skill 名与参数 ——
 * 这里必须用单空格连接 `/skill:name args`, 换行会把 skill 名截断成
 * "translation-review\n\nPR" 导致查找失败、skill 正文不注入(实测踩过)。
 * headSha 必须用全 SHA(40 位): 短 SHA 会被 STALE_HEAD 校验拒绝。
 */
export function resolvePromptText(
  session: SessionRecord,
  promptOverride?: string,
): string {
  if (promptOverride) return promptOverride;
  const obj = session.objective ?? "";
  if (obj.startsWith("/skill:translation-review")) {
    const rest = obj.replace(/^\/skill:translation-review\b/, "").trim();
    const prLine = session.prNumber !== undefined
      ? `PR #${session.prNumber}${session.headSha ? ` (head ${session.headSha})` : ""}`
      : null;
    const tail = [prLine, rest].filter(Boolean).join(" — ");
    return `/skill:translation-review ${tail}`.trimEnd();
  }
  if (session.prNumber !== undefined) {
    let scopeDesc = `PR #${session.prNumber}`;
    if (session.baseSha && session.headSha) {
      scopeDesc += ` (base: ${session.baseSha.slice(0, 7)}, head: ${session.headSha.slice(0, 7)})`;
    }
    return `请审查 ${scopeDesc} 的翻译质量。\n\n目标: ${obj}`;
  }
  return obj;
}

export function buildSystemPrompt(session: SessionRecord): string {
  return [
    "# CFPABot Agent",
    "",
    "你是 CFPABot，为 CFPAOrg/Minecraft-Mod-Language-Package 提供翻译审查服务。",
    "使用白名单工具完成工作；高风险操作需要管理员确认。",
    "大数据走 ctx（ctx_get/ctx_set），不要粘贴到消息里；结束前检查 todo 全部 complete。",
    "",
    "## 当前会话",
    "",
    `- 目标: ${session.objective}`,
    `- 仓库: ${session.repo.owner}/${session.repo.name}`,
    session.prNumber ? `- PR: #${session.prNumber}` : undefined,
    session.baseSha ? `- base: ${session.baseSha}` : undefined,
    session.headSha ? `- head: ${session.headSha}（全 SHA，工具入参需要全 SHA，勿截短）` : undefined,
  ].filter((l) => l !== undefined).join("\n");
}
