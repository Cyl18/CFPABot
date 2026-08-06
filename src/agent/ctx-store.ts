// src/agent/ctx-store.ts
// Incremental persistence of session ctx (src/agent/session-ctx.ts).
//
// Contract (2026-08-01, rev 2026-08-03): 对齐、术语清洗、review_moa 模型级
// checkpoint、聚合、finalize 等工具完成时原子写入
// `runtime/sessions/ctx/{sessionId}.json`；会话终态（completed/aborted/
// archived/failed）必须先 persist 再 clearSessionCtx()，失败/中止也保留
// partial 结果。恢复语义：runLoop 启动时若内存 ctx 为空则从磁盘加载
// （后台多轮对话/continueSession 依赖它 —— 终态清了内存，续跑要能接上
// aligned/reviews/draft）；加载的是**数据**，不自动 resume agent 循环
// （与 SessionService 的 recovery 语义一致）。磁盘 ctx 同时也是审计/API
// 读取的真相源。审查会话的写放大控制见 review-moa.ts 的模型级 checkpoint
// 说明（崩溃重跑靠 versions 幂等替换自愈）。

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonLocked, readJsonFile } from "../_shared/fs-utils.js";
import { sessionCtxPath } from "../runtime-paths.js";
import { getSessionCtx, type Ctx } from "./session-ctx.js";

/** Atomic write of the session's current in-memory ctx to disk. Never throws. */
export async function persistSessionCtx(sessionId: string): Promise<void> {
  try {
    const ctx = getSessionCtx(sessionId);
    const path = sessionCtxPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeJsonLocked(path, { sessionId, savedAt: new Date().toISOString(), ctx });
  } catch (err) {
    // Persistence must never break the agent loop — log-only failure.
    console.error(`[ctx-store] persist failed for ${sessionId}:`, err);
  }
}

/** Read the last persisted ctx snapshot from disk. Returns null when absent/corrupt. */
export async function loadSessionCtx(sessionId: string): Promise<Ctx | null> {
  try {
    const raw = await readJsonFile<{ sessionId: string; savedAt: string; ctx: Ctx }>(
      sessionCtxPath(sessionId),
    );
    return raw?.ctx ?? null;
  } catch {
    return null;
  }
}
