// src/agent/session-ctx.ts
// Session-scoped in-memory context for CFPABot agent sessions.
// One Ctx per sessionId. Holds todos, PR metadata, dict, terms, aligned
// pairs, manual plan, reviews and draft — agent data that does NOT belong
// in the transcript (pi-coding-agent JSONL) and is too large to paste.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type DictSource = "agent_search" | "forced_vanilla" | "internal" | "ngram" | "tm";

export interface DictEntry {
  word: string;
  text: string;
  source: DictSource;
  note?: string;
}

// ─── 审查流水线双层表 (2026-08-01 契约) ─────────────────────────────────

/** 单条程序/MoA 意见（中间表 findings 元素）。 */
export interface ReviewFinding {
  /** "program" 表示来自对齐器程序候选，否则为 `provider:modelId`。 */
  origin: "program" | string;
  severity: "info" | "warning" | "error";
  issueType?: string;
  detail?: string;
  suggestion?: string;
  /** 结构化差异: 缺失的占位符/标签/单位(程序候选透传) */
  missing?: string[];
  /** 结构化差异: 多余的占位符/标签/单位 */
  extra?: string[];
}

/** 中间表行 —— 全量保留（含 pass 与 unreviewed），供 agent 裁决。 */
export interface ReviewAggRow {
  itemId: string;
  key: string;
  mod: { slug: string; gameVersion: string; domain: string };
  path: string;
  /** 跨版本合并条目的版本明细（含各版本 zh 与 path）—— 裁决时逐版本查看。 */
  versions?: { gameVersion: string; path: string; zh?: string }[];
  /** 版本间 zh 有差异（版本敏感术语），裁决时注意。 */
  zhVariant?: boolean;
  /** head 优先，base 回退。 */
  en?: string;
  zh?: string;
  /** pass=已审无意见；flagged=有意见（程序或 MoA）；unreviewed=模型失败未覆盖；error=数据异常。 */
  status: "pass" | "flagged" | "unreviewed" | "error";
  /** 模型返回了不存在的 itemId 时生成的兜底行（key==itemId、mod/path 空）。
   *  意见保留供人工识别归属；review_finalize 不可引用（校验排除）。 */
  unknownItem?: boolean;
  /** program=仅程序候选；moa=仅模型意见；mixed=两者都有。 */
  source: "program" | "moa" | "mixed";
  /** 多模型意见分歧（有的模型 flag、有的 pass）。 */
  conflict?: boolean;
  findings: ReviewFinding[];
  /** agent 驳回审计 —— 被驳回的意见仅保留在中间表，不进最终表。 */
  dismissed?: { by: "agent"; reason: string; at: string };
}

/** 最终意见表行 —— 只含有意见的、agent 认可的条目。 */
export interface FinalRow {
  itemId: string;
  key: string;
  path: string;
  /** 单版本兼容字段（非合并条目）。 */
  version?: string;
  /** 跨版本合并条目的版本列表（报告层跨版本聚合的依据）。 */
  versions?: string[];
  domain?: string;
  en?: string;
  zh?: string;
  severity: "info" | "warning" | "error";
  /** 最终审查意见（agent 整理后）。 */
  review: string;
  suggestion?: string;
}

/** 洗后术语（terms_distill 产物）：cleaned 注入 MoA，audit 完整留审计。 */
export interface CleanedTerm {
  word: string;
  text: string;
  status: "accepted" | "rejected" | "conflict";
  source: DictSource;
  /** 依据（rejected 的 forced_vanilla 条目必填 —— 强制规则保护）。 */
  evidence?: string;
  /** rejected/conflict 理由。 */
  reason?: string;
}

/** 手册对齐表行（P1 manual DSL 产物）。 */
export interface ManualAlignedRow {
  /** zh 侧文件路径（手册表的展示 key）。 */
  path: string;
  enPath?: string;
  version?: string;
  domain?: string;
  key: string;
  en?: string;
  zh?: string;
  /** 条目在文件中的定位（起始行/结束行）。 */
  span?: { start: number; end: number };
}

export interface Ctx {
  todos?: TodoItem[];
  pr?: {
    prNumber?: number;
    title?: string;
    htmlUrl?: string;
    baseSha?: string;
    headSha?: string;
  };
  dict?: DictEntry[];
  terms?: Record<string, unknown>;
  aligned?: Record<string, unknown>;
  manualPlan?: { yaml?: string; pairs?: unknown[]; notes?: string };
  reviews?: unknown[];
  draft?: Record<string, unknown>;
  /** 中间表（程序聚合 + 驳回审计）。 */
  reviewTable?: ReviewAggRow[];
  /** 最终意见表（只含有意见的）。 */
  finalTable?: FinalRow[];
  /** 洗后术语双层。 */
  termsDistilled?: { cleaned: CleanedTerm[]; audit: CleanedTerm[] };
  /** 手册对齐表（P1）。 */
  manualAligned?: ManualAlignedRow[];
  [key: string]: unknown;
}

const sessions = new Map<string, Ctx>();

export function getSessionCtx(sessionId: string): Ctx {
  let ctx = sessions.get(sessionId);
  if (!ctx) {
    ctx = {};
    sessions.set(sessionId, ctx);
  }
  return ctx;
}

export function setSessionCtx(sessionId: string, ctx: Ctx): void {
  sessions.set(sessionId, ctx);
}

/** Merge (shallow) a partial into the existing ctx, returning the new ctx. */
export function mergeSessionCtx(sessionId: string, partial: Ctx): Ctx {
  const cur = getSessionCtx(sessionId);
  const next = { ...cur, ...partial };
  sessions.set(sessionId, next);
  return next;
}

/**
 * Drop the in-memory ctx of a session. Called when a session reaches a
 * terminal state (finalized / archived) — dict/terms/aligned/reviews
 * blobs would otherwise linger in memory for the process lifetime.
 */
export function clearSessionCtx(sessionId: string): void {
  sessions.delete(sessionId);
}


