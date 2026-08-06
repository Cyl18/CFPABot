// src/agent/tools/review-moa.ts
// Custom tool: review_moa — lightweight multi-model review. Within one tool
// call, fan out to ≥2 review models from llm-endpoints (reviewModelSet), batch
// ctx.aligned to avoid over-long prompts, parse JSON schema with retries.
// Writes results to ctx.reviews (per-model checkpoint persist).
//
// 契约 (2026-08-01):
// - 调用失败/JSON 解析失败各重试 3 次；解析仍失败则换主 agent 模型（fallbackModel）
//   再跑 1 次（不进 agent 上下文）；仍失败 → batch.error + itemIds（unreviewed，
//   绝不等于 pass）
// - batch 记录 itemIds，供 review_aggregate 做覆盖推导（失败≠pass）
// - versions/domains 分桶过滤（渐进披露：先审最新版）
// - 多轮调用结果按 (provider, modelId, versions) 三元组追加/替换（mergeMoaModelResult）
// - 落盘为模型级 checkpoint（每模型一次），崩溃重跑靠幂等替换自愈
// - 术语注入源：ctx.termsDistilled.cleaned 非空时只注入清洗后术语；
//   否则回退 ctx.dict 按来源分段

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getSessionCtx, setSessionCtx, type Ctx, type DictEntry, type CleanedTerm } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";
import { syncLlmRegistry, getLlmModel, llmComplete, LlmCallError } from "../llm-registry.js";
import { parseLlmEndpoints, parseLlmDefaults } from "../llm-endpoints.js";
import type { LangReviewItem, ProgramCandidate } from "../../flows/_shared/language/align-review-items.js";

// ─── Constants ────────────────────────────────────────────────────────────

const CALL_RETRY_MAX = 3; // 调用失败重试次数
const PARSE_RETRY_MAX = 3; // JSON 解析失败重试次数

// 重试退避: 指数 + 抖动, 上限 30s; 429/5xx 是上游常态, 无退避的密集重试
// 既烧 token 又加剧限流。服务端 Retry-After 存在时优先(经 LlmCallError 透传)。
const RETRY_BASE_MS = 1_000; // 首次重试前等待
const RETRY_MAX_MS = 30_000; // 退避上限
const RETRY_JITTER_RATIO = 0.3; // ±30% 抖动

// 模型间并发上限: reviewModelSet 的模型同时打上游的最大数量。
// 默认 2: 手动触发场景下足够快, 又不会多个模型同时把某个 batch 的
// 重试叠加成瞬时突发(每个模型内部 batch 串行, 单次重试可能 ×3 请求)。
const MAX_CONCURRENT_MODELS = 2;

// ─── Param types ────────────────────────────────────────────────────────

export interface MoaReviewFinding {
  itemId?: string;
  key?: string;
  issueType?: string;
  severity?: "info" | "warning" | "error";
  detail?: string;
  suggestion?: string;
}

export interface MoaReviewBatchResult {
  batchIndex: number;
  reviewedItems: number;
  /** All itemIds in this batch — coverage derivation for review_aggregate. */
  itemIds: string[];
  findings: MoaReviewFinding[];
  /** Set when the batch LLM call failed or its output could not be parsed. */
  error?: string;
  /**
   * 兜底模型(主 agent 模型)实际产出本 batch 时的 origin(provider:modelId)。
   * 聚合时 findings/覆盖归属应使用该 origin, 而非声明模型的 provider:modelId。
   */
  fallbackOrigin?: string;
}

export interface MoaReviewModelResult {
  provider: string;
  modelId: string;
  ok: boolean;
  error?: string;
  batches: MoaReviewBatchResult[];
  totalFindings: number;
  /**
   * 本次调用的版本范围（渐进披露分桶）。同 (provider, modelId, versions)
   * 的重跑替换旧结果（修正语义）；不同 versions 的轮次共存，供
   * review_aggregate 全量聚合。未传（一次性审全部）为 undefined。
   */
  versions?: string[];
}

export interface ReviewMoaParams {
  /** Cap of items per batch. Default 30. */
  itemsPerBatch?: number;
  /** Max tokens per LLM call. Default 16384. */
  maxTokens?: number;
  /** 同时审查的模型数上限。默认 2（限并发，防多模型重试叠加成突发）。 */
  maxConcurrentModels?: number;
  /** 渐进披露分桶：只审这些 gameVersion（精确匹配，任一命中即包含）。 */
  versions?: string[];
  /** 渐进披露分桶：只审这些 domain/namespace（精确匹配，任一命中即包含）。 */
  domains?: string[];
}

export interface DictBySource {
  agent_search: DictEntry[];
  forced_vanilla: DictEntry[];
  internal: DictEntry[];
  ngram: DictEntry[];
  tm: DictEntry[];
}

/** 主 agent 模型（兜底重试用）。 */
export interface FallbackModelSpec {
  provider: string;
  modelId: string;
}

/** onUpdate 进度载荷（经 tool_execution_update 事件透传到前端渲染）。 */
export interface MoaProgress {
  phase: "model_start" | "batch_done" | "model_done";
  provider: string;
  modelId: string;
  /** 1-based; batch_done 时存在。 */
  batchIndex?: number;
  totalBatches: number;
  status?: "ok" | "failed";
  /** batch_done 时为本批 findings 数; model_done 时为累计。 */
  findings?: number;
  totalFindings?: number;
}

/**
 * (provider, modelId, versions) 三元组 key。versions 排序后 join —— 顺序无关。
 */
function modelResultKey(r: { provider: string; modelId: string; versions?: string[] }): string {
  const v = r.versions && r.versions.length > 0 ? [...r.versions].sort().join("|") : "";
  return `${r.provider}:${r.modelId}:${v}`;
}

/**
 * 渐进披露追加合并：结果按 (provider, modelId, versions) 三元组 upsert。
 * 同版本范围的重跑替换旧结果（修正语义）；不同版本范围的轮次共存
 * （多版本聚合，review_aggregate 按 itemId 全量 join）。versions 顺序无关。
 */
export function mergeMoaModelResult(
  existing: MoaReviewModelResult[],
  next: MoaReviewModelResult,
): MoaReviewModelResult[] {
  const key = modelResultKey(next);
  const idx = existing.findIndex((r) => modelResultKey(r) === key);
  return idx >= 0
    ? [...existing.slice(0, idx), next, ...existing.slice(idx + 1)]
    : [...existing, next];
}

function isReviewMoaParams(x: unknown): ReviewMoaParams {
  if (!x || typeof x !== "object") return {};
  const p = x as Record<string, unknown>;
  const out: ReviewMoaParams = {};
  if (typeof p.itemsPerBatch === "number") out.itemsPerBatch = p.itemsPerBatch;
  if (typeof p.maxTokens === "number") out.maxTokens = p.maxTokens;
  if (typeof p.maxConcurrentModels === "number") out.maxConcurrentModels = p.maxConcurrentModels;
  if (Array.isArray(p.versions)) out.versions = p.versions.filter((v): v is string => typeof v === "string");
  if (Array.isArray(p.domains)) out.domains = p.domains.filter((d): d is string => typeof d === "string");
  return out;
}

// ─── Pure helpers ────────────────────────────────────────────────────────

interface ReviewModelSpec {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
}

/** Resolve review model set from defaults; require at least 2. */
function resolveReviewModels(): ReviewModelSpec[] {
  const defaults = parseLlmDefaults();
  const set = defaults?.reviewModelSet ?? [];
  if (set.length < 2) {
    throw new Error(
      `review_moa 需要 llm-endpoints.json 中 defaults.reviewModelSet 至少配置 2 个模型，当前只有 ${set.length} 个`,
    );
  }
  return set.map((m) => ({
    provider: m.provider,
    modelId: m.modelId,
    thinkingLevel: m.thinkingLevel,
  }));
}

/** 条目的版本视图: 合并条目用 versions, 旧形状回退单版本。 */
function itemVersions(it: LangReviewItem): { gameVersion: string; path: string; headZh?: string; baseZh?: string }[] {
  if (it.versions && it.versions.length > 0) {
    return it.versions;
  }
  return [{ gameVersion: it.mod.gameVersion, path: it.path, headZh: it.headZh, baseZh: it.baseZh }];
}

/** Flatten aligned items, keep only changed scope, apply version/domain buckets. */
function flattenChangedItems(
  ctx: Ctx,
  filter?: { versions?: string[]; domains?: string[] },
): LangReviewItem[] {
  const aligned = (ctx.aligned as unknown as { items: LangReviewItem[]; candidates: unknown[] }[]) ?? [];
  const out: LangReviewItem[] = [];
  for (const res of aligned) {
    for (const it of res.items) {
      if (it.scope !== "changed") continue;
      // 合并条目: versions 过滤 = 条目涉及任一指定版本(交集)。
      const reqVersions = filter?.versions;
      if (reqVersions && reqVersions.length > 0) {
        const vlist = itemVersions(it);
        if (!vlist.some((v) => reqVersions.includes(v.gameVersion))) continue;
      }
      if (filter?.domains && filter.domains.length > 0 && !filter.domains.includes(it.mod.domain)) continue;
      out.push(it);
    }
  }
  return out;
}

/** Batch items into roughly equal chunks. */
function batchItems<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// ─── 预算驱动的默认 batch 大小 / maxTokens ────────────────────────────────
// 利用 llm-endpoints.json 的 inputLimit(→Model.contextWindow) 与
// maxOutputTokens(→Model.maxTokens): 输入侧按实际条目文本长度估算每条目
// token, 输出侧按「每条目最多 60 token 意见输出」预留, 两者取小。
// 结果 clamp 到 [min, max](默认 30..500)。

export interface BatchBudgetSpec {
  /** 模型输入上下文上限(Model.contextWindow, 来自 inputLimit)。 */
  contextWindow: number;
  /** 模型输出上限(Model.maxTokens, 来自 maxOutputTokens)。 */
  maxTokens: number;
}

const MIN_BATCH = 10;
// 受控 A/B 实测(同 ctx/术语/模型/maxTokens, 唯一变量 itemsPerBatch, 26.2 子集 159 条):
//   batch=30 → error 29 / warning 25(去重 56 条, 511s)
//   batch=60 → error 19 / warning 29(去重 49 条, 381s)
//   batch=159 → error 8 / warning 35(去重 43 条, 253s)
// error 级意见与 batch 长度强负相关(29→8, 漏报 3 + 严重度降级 23);
// mimo 在长 batch 下塌方(39→9), deepseek 相对稳(54→41);
// 同配置跨次运行方差极小(mimo@30: 39 vs 旧会话 40) — 效应真实, 非采样噪声。
// 结论: 默认 batch 上限 30(预算公式只用于小 context/超长条目时收紧, 不放大)。
const MAX_BATCH = 30;
/** 输入预算安全系数(给系统提示/术语表/输出留余量)。 */
const INPUT_SAFETY = 0.8;
/** 每条目最坏情况下的意见输出 token 预算(含 detail)。 */
const OUTPUT_TOKENS_PER_ITEM = 60;
/** 字符 → token 的粗略换算(中英混合)。 */
const CHARS_PER_TOKEN = 2.5;
/** 条目行的固定格式化开销 token。 */
const ITEM_OVERHEAD_TOKENS = 40;

/**
 * 按模型 context 预算计算默认每批条目数(纯函数)。
 * 输入预算 = min(所有模型 contextWindow) - max(所有模型 maxTokens)(给输出留足);
 * 输出预算 = min(所有模型 maxTokens) / 每条目输出预算。
 * 取两者较小值, clamp 到 [min, max]。
 */
export function computeDefaultBatchSize(
  items: LangReviewItem[],
  specs: BatchBudgetSpec[],
  opts: { min?: number; max?: number } = {},
): number {
  const min = opts.min ?? MIN_BATCH;
  const max = opts.max ?? MAX_BATCH;
  if (items.length === 0 || specs.length === 0) return min;
  const minContext = Math.min(...specs.map((s) => s.contextWindow));
  const maxOutputCap = Math.max(...specs.map((s) => s.maxTokens));
  const minOutputCap = Math.min(...specs.map((s) => s.maxTokens));
  const inputBudget = Math.max(0, minContext - maxOutputCap) * INPUT_SAFETY;
  const totalChars = items.reduce(
    (n, it) =>
      n +
      (it.headEn?.length ?? 0) +
      (it.headZh?.length ?? 0) +
      (it.baseEn?.length ?? 0) +
      (it.baseZh?.length ?? 0) +
      64,
    0,
  );
  const estPerItem = Math.max(32, totalChars / items.length / CHARS_PER_TOKEN + ITEM_OVERHEAD_TOKENS);
  const byInput = Math.floor(inputBudget / estPerItem);
  const byOutput = Math.floor(minOutputCap / OUTPUT_TOKENS_PER_ITEM);
  return Math.min(max, Math.max(min, Math.min(byInput, byOutput)));
}

/**
 * 默认每次 LLM 调用的输出上限: 随 batch 放大(每条目预留 200 token 输出),
 * 下限 16384, 上限不超过模型输出能力。
 */
export function computeDefaultMaxTokens(batchSize: number, modelOutputCap: number): number {
  return Math.min(modelOutputCap, Math.max(16_384, batchSize * 200));
}

/** Format ctx.dict segmented by source for MoA prompts. */
function formatDictBySource(dict: DictEntry[] | undefined): DictBySource {
  const out: DictBySource = {
    agent_search: [],
    forced_vanilla: [],
    internal: [],
    ngram: [],
    tm: [],
  };
  for (const e of dict ?? []) {
    if (e.source in out) out[e.source as keyof DictBySource].push(e);
  }
  return out;
}

function renderDictSection(title: string, entries: DictEntry[]): string {
  if (entries.length === 0) return `### ${title}\n（无）\n`;
  const lines = entries.map((e) => `- "${e.word}" → "${e.text}"${e.note ? ` （${e.note}）` : ""}`);
  return `### ${title}\n${lines.join("\n")}\n`;
}

function renderCleanedSection(cleaned: CleanedTerm[]): string {
  if (cleaned.length === 0) return "### 清洗后术语表\n（无）\n";
  const lines = cleaned.map((t) => `- "${t.word}" → "${t.text}" （来源: ${t.source}${t.status === "conflict" ? "，存在冲突" : ""}${t.reason ? `，理由: ${t.reason}` : ""}）`);
  return `### 清洗后术语表（唯一注入源，必须遵守）\n${lines.join("\n")}\n`;
}

// ─── Build prompts ───────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return [
    "# 翻译审查 MoA 评审员",
    "",
    "你是一个 Minecraft 模组翻译审查员。你将收到一个批次对齐的 EN/ZH 翻译条目（包含 base/head 变更），请结合术语表找出翻译质量问题。",
    "",
    "## 输出格式",
    "严格输出 JSON，不要 markdown 包裹，不要解释文本。结构：",
    '{ "findings": [ { "itemId"?: string, "key"?: string, "issueType"?: string, "severity"?: "info"|"warning"|"error", "detail"?: string, "suggestion"?: string} ] }',
    "",
    "itemId 使用条目列表中的序号（0 起始整数），key 也一并给出；引用条目时两者都填。",
    "",
    "## 严重级别",
    "- error: 必改（明显错误、漏译、关键字丢失等）",
    "- warning: 建议改（措辞/格式/不一致）",
    "- info: 可选优化",
    "",
    "## 审查重点",
    "1. 一致性：相同英文是否译法相同；术语表是否被遵守",
    "2. 完整性：是否有漏译、EN=ZH、占位符丢失",
    "3. 准确性：翻译是否正确传达了原意",
    "4. 格式：printf 占位符 %s %d、{template} 等是否保留",
    "",
    "## 程序意见（软参考）",
    "条目行中的「程序」是程序化检查摘要（格式检查/术语匹配），仅作参考：",
    "- 无异议 → 无需重复输出该问题（程序已记录）",
    "- 认为某条程序意见是误报 → 输出一条 finding：{ itemId, issueType: \"program_false_positive\", detail: \"误报理由\" }",
    "「术语」行是术语表命中：✓=译文遵守术语，✗=译文未使用术语译法（需你判断是否合理，如语境不适合可判误报）。",
    "",
    "只输出能找到依据的发现；如果全部 ok，输出 { \"findings\": [] }。",
  ].join("\n");
}

export function buildBatchUserPrompt(
  items: LangReviewItem[],
  dictBySource: DictBySource | undefined,
  cleaned: CleanedTerm[] | undefined,
  candidatesByItem?: ReadonlyMap<string, ProgramCandidate[]>,
): string {
  // 头部术语表：dict 分节（现有）+ 原版自动注入节（只投影本批命中，1101 全量过大）
  const vanillaHits = new Map<string, string[]>();
  for (const it of items) {
    for (const t of it.prep?.terms ?? []) {
      if (t.source === "vanilla") {
        const existing = vanillaHits.get(t.en);
        if (existing) {
          for (const zh of t.zh) if (!existing.includes(zh)) existing.push(zh);
        } else {
          vanillaHits.set(t.en, [...t.zh]);
        }
      }
    }
  }
  const header = [
    "## 术语表",
    "",
    cleaned && cleaned.length > 0
      ? renderCleanedSection(cleaned)
      : [
          "以下各节分别列出 agent 主动搜索到的术语、原版自动注入术语、内部一致性候选、n-gram 自动术语候选、翻译记忆参考。原版术语具有最高优先级（若出现必须遵守）；其余为参考。",
          "",
          renderDictSection("agent_search（agent 搜索）", dictBySource?.agent_search ?? []),
          renderDictSection("internal（内部一致性候选）", dictBySource?.internal ?? []),
          renderDictSection("ngram（自动术语候选）", dictBySource?.ngram ?? []),
          renderDictSection("tm（翻译记忆参考）", dictBySource?.tm ?? []),
          ...(vanillaHits.size > 0
            ? [
                "### 原版术语（自动注入，本批命中）",
                ...[...vanillaHits.entries()].map(([en, zh]) => `"${en}" → "${zh.join(" / ")}"`),
              ]
            : []),
        ].join("\n"),
    "",
    "---",
    "",
    `## 待审查条目（${items.length} 个）`,
    "",
    "每条格式：序号 | key | base→head 变更（如有）| zh(版本) | changed(en,zh)。itemId 用序号（0 起始）；跨版本合并条目会列出每个版本的 zh；zhVariant 条目各版本翻译不同，请对比并分别评价。",
    "",
    "行内附注（软参考，无异议无需重复输出）：",
    "- 「程序」= 程序化检查摘要（格式检查等，只给类型与计数，完整意见在聚合表）",
    "- 「术语」= 术语表命中：✓=译文遵守，✗=译文未使用术语译法（判断是否合理，不合适可判误报）",
    "- 「tm」= 翻译记忆参考（相邻模组/历史译法）",
    "",
  ];
  const lines = items.map((it, idx) => {
    const flags = `${it.changed.en ? "E" : "-"}${it.changed.zh ? "Z" : "-"}`;
    // base→head 变更列（单版本条目；合并条目 base 侧未保留）
    const diffEn =
      it.baseEn !== undefined && it.baseEn !== it.headEn
        ? ` baseEn="${it.baseEn}"→headEn="${it.headEn ?? ""}"`
        : it.baseEn !== undefined
          ? ` en="${it.baseEn}"`
          : "";
    const diffZh =
      it.baseZh !== undefined && it.baseZh !== it.headZh
        ? ` baseZh="${it.baseZh}"→headZh="${it.headZh ?? ""}"`
        : "";
    const line = [
      `${idx} | ${it.key}`,
      it.headEn !== undefined ? `headEn="${it.headEn}"${diffEn}` : undefined,
      it.versions && it.versions.length > 1
        ? it.versions
            .map((v) => `zh(${v.gameVersion})="${v.headZh ?? "（缺失）"}"`)
            .join(" | ")
        : `zh(${it.versions?.[0]?.gameVersion ?? it.mod.gameVersion})="${it.versions?.[0]?.headZh ?? it.headZh ?? ""}"${diffZh}`,
      flags,
      it.zhVariant ? "⚠️zhVariant" : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join(" | ");
    // 行内附注
    const notes: string[] = [];
    const cands = candidatesByItem?.get(it.itemId) ?? [];
    if (cands.length > 0) {
      const counts = new Map<string, number>();
      for (const c of cands) counts.set(c.issueType, (counts.get(c.issueType) ?? 0) + 1);
      notes.push(`程序: ${[...counts.entries()].map(([t, n]) => `${t}${n > 1 ? `×${n}` : ""}`).join(", ")}`);
    }
    const terms = it.prep?.terms ?? [];
    if (terms.length > 0) {
      notes.push(
        `术语: ${terms
          .map((t) => `"${t.en}"→"${t.zh.join(" / ")}"${t.ok ? "✓" : "✗(未遵守)"}${t.source === "vanilla" ? "·原版" : ""}`)
          .join("  ")}`,
      );
    }
    if (it.prep?.tm && it.prep.tm.length > 0) {
      notes.push(
        `tm: ${it.prep.tm
          .slice(0, 2)
          .map((h) => `"${h.en}"→"${h.zh}"`)
          .join("  ")}`,
      );
    }
    return notes.length > 0 ? `${line}\n    ${notes.join("\n    ")}` : line;
  });
  return [...header, ...lines, "", "请对上述条目输出 JSON 审查结果。"].join("\n");
}

// ─── Parse LLM JSON with retries ─────────────────────────────────────────

interface ParsedBatch {
  findings: MoaReviewFinding[];
}

export function tryParseBatch(text: string): ParsedBatch | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const json = t.slice(start, end + 1);
  try {
    const parsed = JSON.parse(json) as { findings?: MoaReviewFinding[] };
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.findings)) return null;
    return { findings: parsed.findings };
  } catch {
    return null;
  }
}

/**
 * 模型返回的序号 itemId（batch 内 0 起始整数）→ 真实条目 id（batch.itemIds 索引映射）。
 * 非数字/越界保留原值 —— 聚合层按 key fuzzy 兜底。旧会话数据（真实 id 直返）不受影响。
 */
export function remapFindingItemIds(
  findings: MoaReviewFinding[],
  itemIds: string[],
): MoaReviewFinding[] {
  return findings.map((f) => {
    if (f.itemId === undefined) return f;
    const n = Number(f.itemId);
    if (Number.isInteger(n) && n >= 0 && n < itemIds.length) {
      return { ...f, itemId: itemIds[n]! };
    }
    return f;
  });
}

async function callReviewModel(
  model: Model<Api>,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  return llmComplete(model, systemPrompt, userPrompt, {
    apiKey,
    signal,
    maxTokens,
  });
}

// ─── 退避重试 ────────────────────────────────────────────────────────────

/** 429/408/5xx 视为可重试; 其余 4xx(校验/鉴权)重试无意义。 */
function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status === 408 || status >= 500;
}

/** 第 attempt 次重试前的等待: 服务端 Retry-After 优先, 否则指数+抖动。 */
function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs + 500, RETRY_MAX_MS);
  }
  const exp = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  const jitter = exp * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/** AbortSignal 感知的 sleep: 取消时抛 AbortError。 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * 调用 + 退避重试(CALL_RETRY_MAX 次)。全部失败抛 Error(携带最后一次原因);
 * 取消期间抛原 AbortError。非可重试错误(4xx 除 408/429)立即抛出不消耗重试。
 */
async function callLlmWithRetry(
  model: Model<Api>,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < CALL_RETRY_MAX; attempt++) {
    try {
      return await callReviewModel(model, apiKey, systemPrompt, userPrompt, maxTokens, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err instanceof Error ? err.message : String(err);
      const retryable =
        err instanceof LlmCallError ? isRetryableStatus(err.status) : true;
      if (!retryable || attempt >= CALL_RETRY_MAX - 1) break;
      const delayMs = retryDelayMs(
        attempt,
        err instanceof LlmCallError ? err.retryAfterMs : undefined,
      );
      try {
        await sleep(delayMs, signal);
      } catch {
        throw err; // abort during sleep
      }
    }
  }
  throw new Error(lastErr ?? "LLM call failed");
}

/** 限并发 map: 最多 limit 个任务同时执行, 结果保序。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ─── Tool ────────────────────────────────────────────────────────────────

export function createReviewMoaTool(
  sessionId: string,
  fallbackModel?: FallbackModelSpec,
): ToolDefinition {
  const parameters = Type.Object({
    itemsPerBatch: Type.Optional(Type.Number({ description: "每批条目数上限，默认 30（预算公式仅在小 context/超长条目时自动收紧）" })),
    maxTokens: Type.Optional(Type.Number({ description: "每次 LLM 调用最大 token，默认随 batch 放大(16384–模型上限)" })),
    maxConcurrentModels: Type.Optional(Type.Number({ description: "同时审查的模型数上限，默认 2（限并发，防多模型的重试叠加成突发）" })),
    versions: Type.Optional(Type.Array(Type.String(), { description: "渐进披露分桶：只审这些 gameVersion（不传=全部）" })),
    domains: Type.Optional(Type.Array(Type.String(), { description: "渐进披露分桶：只审这些 domain/namespace（不传=全部）" })),
  });

  return {
    name: "review_moa",
    label: "多模型审查 (MoA)",
    description:
      "在单个工具调用内并行打多个 review 模型（来源 llm-endpoints.json 的 reviewModelSet，至少 2 个；模型间限并发，默认同时 2 个，可用 maxConcurrentModels 调整）。对 ctx.aligned 按 batch 防超长，调用失败退避重试 3 次（429/5xx 感知，尊重服务端 Retry-After），JSON 解析失败重试 3 次，仍失败换主 agent 模型再跑 1 次，最终失败标 unreviewed（不等于 pass）。默认 batch 与输出上限按模型 contextWindow/maxTokens 自动推导（可用 itemsPerBatch/maxTokens 覆盖）。**渐进披露：先传 versions 只审最新版（如 versions:[\"26.2\"]），逐版本轮次推进；不同 versions 的轮次结果按版本共存追加（可多次调用分版本审，全部版本的意见都会进聚合），同版本范围重跑替换旧结果。** 术语注入：ctx.termsDistilled.cleaned 非空则只注入清洗后术语，否则按来源分段注入 ctx.dict。结果写入 ctx.reviews（每 batch 增量落盘）。模型返回的 itemId 为 batch 内序号（0 起始整数），工具自动映射回真实条目 id。",
    parameters,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const p = isReviewMoaParams(params);
      const ctx: Ctx = getSessionCtx(sessionId);

      let models: ReviewModelSpec[];
      try {
        syncLlmRegistry();
        models = resolveReviewModels();
      } catch (err) {
        const error = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [{ type: "text", text: JSON.stringify(error) }],
          details: error,
        };
      }

      const items = flattenChangedItems(ctx, { versions: p.versions, domains: p.domains });
      if (items.length === 0) {
        const error = { ok: false, error: "ctx.aligned 中没有匹配 scope=changed 的条目，请先调用 review_align" };
        return {
          content: [{ type: "text", text: JSON.stringify(error) }],
          details: error,
        };
      }

      // ── 预算: 利用模型 contextWindow/maxTokens 配置推导默认 batch 与输出上限 ──
      const modelEntries = models.map((spec) => ({ spec, model: getLlmModel(spec.provider, spec.modelId) }));
      const budgetSpecs: BatchBudgetSpec[] = [];
      for (const e of modelEntries) {
        if (!e.model) continue;
        budgetSpecs.push({
          contextWindow: e.model.contextWindow ?? 128_000,
          maxTokens: e.model.maxTokens ?? 4096,
        });
      }
      const itemsPerBatch = p.itemsPerBatch ?? computeDefaultBatchSize(items, budgetSpecs);
      const outputCap = budgetSpecs.length > 0 ? Math.min(...budgetSpecs.map((b) => b.maxTokens)) : 16_384;
      const maxTokens = p.maxTokens ?? computeDefaultMaxTokens(itemsPerBatch, outputCap);
      const batches = batchItems(items, itemsPerBatch);
      const cleaned =
        ctx.termsDistilled && ctx.termsDistilled.cleaned.length > 0
          ? ctx.termsDistilled.cleaned
          : undefined;
      const dictBySource = cleaned ? undefined : formatDictBySource(ctx.dict);
      const systemPrompt = buildSystemPrompt();

      // 程序候选按 itemId 索引（prompt 逐行渲染「程序」摘要；软参考）
      const candidatesByItem = new Map<string, ProgramCandidate[]>();
      for (const res of (ctx.aligned as unknown as { candidates: unknown[] }[]) ?? []) {
        for (const c of res.candidates ?? []) {
          const cand = c as ProgramCandidate;
          if (!cand?.itemId) continue;
          const arr = candidatesByItem.get(cand.itemId);
          if (arr) arr.push(cand);
          else candidatesByItem.set(cand.itemId, [cand]);
        }
      }

      const endpoints = parseLlmEndpoints();
      const findApiKey = (provider: string, modelId: string): string => {
        const ep = endpoints.find((e) => e.provider === provider && e.modelId === modelId);
        return ep?.apiKey ?? "";
      };

      // 写入串行链: 模型并行时对 ctx.reviews 的读改写必须排队, 否则互相覆盖。
      let writeChain: Promise<void> = Promise.resolve();
      // 渐进披露追加语义见 mergeMoaModelResult 注释。versions 排序存储。
      // 落盘策略: 每 batch 全量写 ctx 会带来 ~60×/会话 的几百 KB 序列化写放大,
      // 改为模型级 checkpoint — runModelReview 完成时统一 persist 一次。
      // 崩溃恢复窗口 = 最后模型的最后若干 batch, 重跑该版本即可
      // (versions 三元组幂等替换, 与恢复语义自洽)。
      const doUpsertReviews = async (partial: MoaReviewModelResult): Promise<void> => {
        const cur = getSessionCtx(sessionId);
        const existing = (cur.reviews as MoaReviewModelResult[]) ?? [];
        const stamped: MoaReviewModelResult = {
          ...partial,
          versions: p.versions && p.versions.length > 0 ? [...p.versions].sort() : undefined,
        };
        const next = mergeMoaModelResult(existing, stamped);
        setSessionCtx(sessionId, { ...cur, reviews: next });
      };
      // Incremental persist after every batch — partial results must survive.
      const upsertReviews = (partial: MoaReviewModelResult): Promise<void> => {
        writeChain = writeChain.then(() => doUpsertReviews(partial));
        return writeChain;
      };

      // ── 单模型审查: 模型内部 batch 串行, 多个模型之间并行(Promise.all)──
      const runModelReview = async (spec: ReviewModelSpec, model: Model<Api> | undefined): Promise<MoaReviewModelResult> => {
        if (!model) {
          const failed: MoaReviewModelResult = {
            provider: spec.provider,
            modelId: spec.modelId,
            ok: false,
            error: `模型 ${spec.provider}/${spec.modelId} 未在 registry 中找到（缺少 apiKey）`,
            batches: [],
            totalFindings: 0,
          };
          await upsertReviews(failed);
          return failed;
        }
        const apiKey = findApiKey(spec.provider, spec.modelId);
        if (!apiKey) {
          const failed: MoaReviewModelResult = {
            provider: spec.provider,
            modelId: spec.modelId,
            ok: false,
            error: `模型 ${spec.provider}/${spec.modelId} 没有配置 apiKey`,
            batches: [],
            totalFindings: 0,
          };
          await upsertReviews(failed);
          return failed;
        }

        const mr: MoaReviewModelResult = {
          provider: spec.provider,
          modelId: spec.modelId,
          ok: true,
          batches: [],
          totalFindings: 0,
        };
        onUpdate?.({
          content: [],
          details: {
            phase: "model_start",
            provider: spec.provider,
            modelId: spec.modelId,
            totalBatches: batches.length,
          },
        });

        for (let bi = 0; bi < batches.length; bi++) {
          const batch = batches[bi]!;
          const itemIds = batch.map((it) => it.itemId);
          const userPrompt = buildBatchUserPrompt(batch, dictBySource, cleaned, candidatesByItem);

          // ── Call with backoff retry (callLlmWithRetry) ─────────
          let text: string | null = null;
          let lastErr: string | null = null;
          try {
            text = await callLlmWithRetry(model, apiKey, systemPrompt, userPrompt, maxTokens, signal);
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err);
            if (signal?.aborted) break;
          }
          if (text === null) {
            mr.batches.push({
              batchIndex: bi,
              reviewedItems: batch.length,
              itemIds,
              findings: [],
              error: lastErr ?? undefined,
            });
            onUpdate?.({
              content: [],
              details: {
                phase: "batch_done",
                provider: spec.provider,
                modelId: spec.modelId,
                batchIndex: bi + 1,
                totalBatches: batches.length,
                status: "failed",
              },
            });
            await upsertReviews(mr);
            continue;
          }

          // ── Parse with retry (PARSE_RETRY_MAX) ─────────────────
          let parsed = tryParseBatch(text);
          let attempt = 0;
          while (!parsed && attempt < PARSE_RETRY_MAX) {
            const retryPrompt = `${userPrompt}\n\n上次响应解析失败。请严格输出 JSON：{ "findings": [...] }，不要 markdown 包裹，不要额外文本。`;
            let retryText: string | null = null;
            try {
              retryText = await callLlmWithRetry(model, apiKey, systemPrompt, retryPrompt, maxTokens, signal);
            } catch (err) {
              lastErr = err instanceof Error ? err.message : String(err);
              if (signal?.aborted) break;
            }
            if (retryText === null) break;
            parsed = tryParseBatch(retryText);
            attempt++;
          }

          // ── Fallback: main agent model (never enters agent ctx) ─
          let fallbackOrigin: string | undefined;
          if (!parsed && !signal?.aborted && fallbackModel && !(fallbackModel.provider === spec.provider && fallbackModel.modelId === spec.modelId)) {
            const fb = getLlmModel(fallbackModel.provider, fallbackModel.modelId);
            const fbKey = findApiKey(fallbackModel.provider, fallbackModel.modelId);
            if (fb && fbKey) {
              try {
                const fbText = await callReviewModel(fb, fbKey, systemPrompt, userPrompt, maxTokens, signal);
                parsed = tryParseBatch(fbText);
                if (parsed) fallbackOrigin = `${fallbackModel.provider}:${fallbackModel.modelId}`;
              } catch (err) {
                lastErr = err instanceof Error ? err.message : String(err);
              }
            }
          }

          if (!parsed) {
            // Failure ≠ pass: mark unreviewed with the batch's itemIds.
            mr.batches.push({
              batchIndex: bi,
              reviewedItems: batch.length,
              itemIds,
              findings: [],
              error: lastErr ?? "重试后仍无法解析 JSON",
            });
            onUpdate?.({
              content: [],
              details: {
                phase: "batch_done",
                provider: spec.provider,
                modelId: spec.modelId,
                batchIndex: bi + 1,
                totalBatches: batches.length,
                status: "failed",
              },
            });
            await upsertReviews(mr);
            continue;
          }

          mr.batches.push({
            batchIndex: bi,
            reviewedItems: batch.length,
            itemIds,
            findings: remapFindingItemIds(parsed.findings, itemIds),
            ...(fallbackOrigin ? { fallbackOrigin } : {}),
          });
          onUpdate?.({
            content: [],
            details: {
              phase: "batch_done",
              provider: spec.provider,
              modelId: spec.modelId,
              batchIndex: bi + 1,
              totalBatches: batches.length,
              status: "ok",
              findings: parsed.findings.length,
            },
          });
          mr.totalFindings += parsed.findings.length;
          await upsertReviews(mr);
        }

        onUpdate?.({
          content: [],
          details: {
            phase: "model_done",
            provider: spec.provider,
            modelId: spec.modelId,
            totalBatches: batches.length,
            status: mr.ok ? "ok" : "failed",
            totalFindings: mr.totalFindings,
          },
        });
        // 模型级 checkpoint: 该模型全部 batch 结果一次落盘（见 doUpsertReviews 注释）。
        await persistSessionCtx(sessionId);
        return mr;
      };

      const maxConcurrentModels = p.maxConcurrentModels ?? MAX_CONCURRENT_MODELS;
      const modelResults = await mapWithConcurrency(
        modelEntries,
        maxConcurrentModels,
        ({ spec, model }) => runModelReview(spec, model),
      );

      const summary = {
        ok: true,
        modelsAttempted: models.length,
        modelsOk: modelResults.filter((m) => m.ok).length,
        totalFindings: modelResults.reduce((s, m) => s + m.totalFindings, 0),
        totalBatches: modelResults.reduce((s, m) => s + m.batches.length, 0),
        unreviewedBatches: modelResults.reduce((s, m) => s + m.batches.filter((b) => b.error).length, 0),
        itemsReviewed: items.length,
        versionsFilter: p.versions ?? [],
        domainsFilter: p.domains ?? [],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  };
}
