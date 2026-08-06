// src/agent/tools/todo.ts
// Todo tool — session-scoped task list that the agent must keep in sync.
// State lives in session ctx (src/agent/session-ctx.ts), not persisted to disk.
// The runLoop reads ctx.todos to decide whether to continue prompting.

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getSessionCtx,
  setSessionCtx,
  type TodoItem,
  type Ctx,
} from "../session-ctx.js";

export interface TodoParams {
  op: "set" | "list" | "complete";
  items?: { id: string; title: string; notes?: string }[];
  id?: string;
}

function coerceTodoParams(params: unknown): TodoParams {
  if (!params || typeof params !== "object") return { op: "list" };
  const p = params as Record<string, unknown>;
  if (p.op === "set" && Array.isArray(p.items)) {
    return { op: "set", items: p.items as TodoParams["items"] };
  }
  if (p.op === "complete") {
    return { op: "complete", id: typeof p.id === "string" ? p.id : undefined };
  }
  return { op: "list" };
}

export function createTodoTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    op: Type.Union([
      Type.Literal("set"),
      Type.Literal("list"),
      Type.Literal("complete"),
    ], { description: "操作类型：set=用 items 替换全量, list=查询, complete=标记完成" }),
    items: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ description: "todo 唯一标识" }),
          title: Type.String({ description: "任务标题" }),
          notes: Type.Optional(Type.String()),
        }),
        { description: "op=set 时的全量 todo 列表" },
      ),
    ),
    id: Type.Optional(Type.String({ description: "op=complete 时的 todo id" })),
  });

  return {
    name: "todo",
    label: "Todo 管理",
    description:
      "管理审查生命周期任务列表。op=set 用 items 替换全量；op=list 查询当前列表；op=complete(id) 标记任务完成。每条 todo 有 pending/in_progress/completed 三态。结束前必须 list 检查全部完成。",
    parameters,
    execute: async (_toolCallId, params) => {
      const p = coerceTodoParams(params);
      const ctx: Ctx = getSessionCtx(sessionId);
      let result: unknown;

      if (p.op === "set") {
        const now = new Date().toISOString();
        const todos: TodoItem[] = (p.items ?? []).map((it, idx) => ({
          id: it.id ?? `todo-${idx}`,
          title: it.title,
          status: "pending",
          notes: it.notes,
          createdAt: now,
          updatedAt: now,
        }));
        setSessionCtx(sessionId, { ...ctx, todos });
        result = { ok: true, op: "set", count: todos.length, items: todos };
      } else if (p.op === "complete") {
        const todos: TodoItem[] = (ctx.todos ?? []).map((t) =>
          t.id === p.id
            ? { ...t, status: "completed", updatedAt: new Date().toISOString() }
            : t,
        );
        setSessionCtx(sessionId, { ...ctx, todos });
        result = { ok: true, op: "complete", id: p.id, items: todos };
      } else {
        // list
        result = { ok: true, op: "list", items: ctx.todos ?? [] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
