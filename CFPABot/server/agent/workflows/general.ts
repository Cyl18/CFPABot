import type { WorkflowDefinition } from "./types.ts";

export const generalWorkflow: WorkflowDefinition = {
  id: "general",
  title: ({ prNumber, message }) => {
    const head = message?.split(/\r?\n/)[0]?.trim();
    if (head) return head.slice(0, 60);
    return prNumber !== undefined ? `PR #${prNumber} 会话` : "新会话";
  },
  firstPrompt: ({ message }) => message || "请查看当前 PR，完成用户要求的操作（默认：理解并汇报 PR 内容）。",
  promptFiles: [],
  skills: [],
  defaults: { writeScope: "off", evalScope: "off" },
  requiresPr: false,
};
