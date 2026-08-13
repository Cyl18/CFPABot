// src/agent/review-aggregate.ts
// PURE: aggregate MoA model results + align program candidates into the
// review table (ctx.reviewTable). No I/O, no globals.
//
// 契约 (2026-08-01):
// - 模型失败 ≠ pass：batch.error 覆盖的 item → unreviewed，绝不推导为 pass
// - findings=[] 仅在调用成功且解析成功时推导为 pass
// - 程序候选（candidates）按 itemId join 同 pair 的 items（candidates 可引用
//   historical 条目 —— 表不假设 ⊆ changed 集）
// - 多模型分歧（有的 flag 有的 pass）→ conflict
// - 已有表的 dismissed 状态保留（幂等重建）

import type {
  ReviewAggRow,
  ReviewFinding,
} from "./session-ctx.js";
import type { MoaReviewModelResult, MoaReviewBatchResult } from "./tools/review-moa.js";
import type { LangReviewItem } from "../flows/_shared/language/align-review-items.js";

/** 一条 aligned pair 结果（与 ctx.aligned 元素同构）。 */
export interface AlignedPairResult {
  items: LangReviewItem[];
  candidates: unknown[];
}

interface ProgramCandidateShape {
  itemId?: string;
  issueType?: string;
  severity?: "error" | "warning";
  detail?: string;
  path?: string;
  key?: string;
  missing?: string[];
  extra?: string[];
}

function asProgramCandidate(c: unknown): ProgramCandidateShape | null {
  if (!c || typeof c !== "object") return null;
  const p = c as Record<string, unknown>;
  if (typeof p.itemId !== "string") return null;
  const out: ProgramCandidateShape = { itemId: p.itemId };
  if (typeof p.issueType === "string") out.issueType = p.issueType;
  if (p.severity === "error" || p.severity === "warning") out.severity = p.severity;
  if (typeof p.detail === "string") out.detail = p.detail;
  if (typeof p.path === "string") out.path = p.path;
  if (typeof p.key === "string") out.key = p.key;
  if (Array.isArray(p.missing) && p.missing.every((x): x is string => typeof x === "string")) out.missing = p.missing;
  if (Array.isArray(p.extra) && p.extra.every((x): x is string => typeof x === "string")) out.extra = p.extra;
  return out;
}

interface MoaFindingShape {
  itemId?: string;
  key?: string;
  issueType?: string;
  severity?: "info" | "warning" | "error";
  detail?: string;
  suggestion?: string;
}

function asMoaFinding(f: unknown): MoaFindingShape | null {
  if (!f || typeof f !== "object") return null;
  const p = f as Record<string, unknown>;
  if (typeof p.itemId !== "string" && typeof p.key !== "string") return null;
  const out: MoaFindingShape = {};
  if (typeof p.itemId === "string") out.itemId = p.itemId;
  if (typeof p.key === "string") out.key = p.key;
  if (typeof p.issueType === "string") out.issueType = p.issueType;
  if (p.severity === "info" || p.severity === "warning" || p.severity === "error") out.severity = p.severity;
  if (typeof p.detail === "string") out.detail = p.detail;
  if (typeof p.suggestion === "string") out.suggestion = p.suggestion;
  return out;
}

/**
 * Aggregate aligned program candidates + MoA model results into review rows.
 *
 * @param reviews  ctx.reviews (MoaReviewModelResult[])
 * @param aligned  ctx.aligned (AlignedPairResult[])
 * @param existing 现有 ctx.reviewTable —— 用于保留 dismissed 审计（幂等重建）
 * @returns { rows, ambiguousFindings } — ambiguousFindings 为因同 key 多文件
 *   无法消歧而跳过的 key-only finding 数
 */
export function aggregateReviewTable(
  reviews: MoaReviewModelResult[] | undefined,
  aligned: AlignedPairResult[] | undefined,
  existing?: ReviewAggRow[],
): { rows: ReviewAggRow[]; ambiguousFindings: number } {
  // ── Item index: itemId → LangReviewItem ────────────────────────
  const itemsById = new Map<string, LangReviewItem>();
  for (const res of aligned ?? []) {
    for (const it of res.items ?? []) {
      itemsById.set(it.itemId, it);
    }
  }

  // 模型偶发返回拼接/截断的 itemId（真实 id 的 SHA256 前缀 + 垃圾尾巴）：
  // 唯一前缀命中才修正（≥8 字符防短 id 误配）。
  const resolveItemId = (raw: string): string | null => {
    if (itemsById.has(raw)) return raw;
    if (raw.length >= 8) {
      const byPrefix = [...itemsById.keys()].filter((id) => id.startsWith(raw));
      if (byPrefix.length === 1) return byPrefix[0]!;
      const containing = [...itemsById.keys()].filter((id) => raw.startsWith(id));
      if (containing.length === 1) return containing[0]!;
    }
    return null;
  };

  // itemId 对不上时按 key 归属（MoA batch 展示 id+key，模型回答 id+key，
  // id 错但 key 对 → 用 key 精确/fuzzy 修复）。CFPA 同 key 多文件是常态，
  // 因此只接受唯一命中；多个命中不猜（走 unknownItem 兜底）。
  const normalizeKey = (k: string) => k.trim().toLowerCase();
  const resolveByKey = (rawKey: string | undefined): string | null => {
    if (!rawKey) return null;
    const norm = normalizeKey(rawKey);
    const all = [...itemsById.values()];
    const exact = all.filter((it) => it.key === rawKey);
    if (exact.length === 1) return exact[0]!.itemId;
    const fuzzy = all.filter((it) => {
      const k = normalizeKey(it.key);
      return k === norm || k.includes(norm) || norm.includes(k);
    });
    if (fuzzy.length === 1) return fuzzy[0]!.itemId;
    return null;
  };

  // key-only finding（无 itemId）只能在同 batch 的 itemIds 内消歧：
  // 恰好 1 个命中才归属；多个命中（CFPA 同 key 多文件是常态）跳过并计数。
  let ambiguousFindings = 0;

  const rows = new Map<string, ReviewAggRow>();
  const getRow = (itemId: string, it?: LangReviewItem): ReviewAggRow => {
    const hit = rows.get(itemId);
    if (hit) return hit;
    // 合并条目: versions 全量保留(裁决按版本细看), mod/path/zh 取首版本作摘要。
    const versions = it?.versions && it.versions.length > 0 ? it.versions : undefined;
    const firstV = versions?.[0];
    const unknownItem = it === undefined && !itemsById.has(itemId);
    const row: ReviewAggRow = {
      itemId,
      key: it?.key ?? itemId,
      ...(unknownItem ? { unknownItem: true } : {}),
      mod: {
        slug: it?.mod.slug ?? "",
        gameVersion: firstV?.gameVersion ?? it?.mod.gameVersion ?? "",
        domain: it?.mod.domain ?? "",
      },
      path: firstV?.path ?? it?.path ?? "",
      ...(versions
        ? {
            versions: versions.map((v) => ({
              gameVersion: v.gameVersion,
              path: v.path,
              ...((v.headZh ?? v.baseZh) !== undefined ? { zh: v.headZh ?? v.baseZh } : {}),
            })),
            ...(it?.zhVariant ? { zhVariant: true } : {}),
          }
        : {}),
      en: it?.headEn ?? it?.baseEn,
      zh: firstV?.headZh ?? firstV?.baseZh ?? it?.headZh ?? it?.baseZh,
      status: "pass",
      source: "moa",
      findings: [],
    };
    rows.set(itemId, row);
    return row;
  };

  // ── Program candidates (join by itemId within the same pair) ───
  for (const res of aligned ?? []) {
    for (const c of res.candidates ?? []) {
      const cand = asProgramCandidate(c);
      if (!cand?.itemId) continue;
      const it = itemsById.get(cand.itemId);
      const row = getRow(cand.itemId, it);
      row.status = "flagged";
      // 只存失败态 + 按 (itemId, issueType) 去重(mergeAlignedItems 已做, 此处幂等重建保险;
      // 仅作用于程序候选, 不误伤多模型 MoA 意见)
      if (row.findings.some((f) => f.origin === "program" && f.issueType === cand.issueType)) continue;
      row.findings.push({
        origin: "program",
        severity: cand.severity === "warning" ? "warning" : "error",
        issueType: cand.issueType,
        detail: cand.detail,
        ...(cand.missing !== undefined ? { missing: cand.missing } : {}),
        ...(cand.extra !== undefined ? { extra: cand.extra } : {}),
      });
    }
  }

  // ── MoA model results ──────────────────────────────────────────
  // Per item: 覆盖它的模型数、有意见的模型数、error 覆盖数。
  const moaFindingsByItem = new Map<string, ReviewFinding[]>();
  const flaggedModels = new Map<string, Set<string>>(); // itemId → 有意见的模型
  const coveredModels = new Map<string, Set<string>>(); // itemId → 成功覆盖的模型
  const errorModels = new Map<string, Set<string>>(); // itemId → error 覆盖的模型

  for (const mr of reviews ?? []) {
    const modelOrigin = `${mr.provider}:${mr.modelId}`;
    for (const batch of mr.batches ?? []) {
      // 兜底模型产出的 batch 归属实际来源(provider:modelId), 保证 conflict/来源统计正确。
      const origin = batch.fallbackOrigin ?? modelOrigin;
      const batchFindings = (batch.findings ?? []).map(asMoaFinding).filter((f): f is MoaFindingShape => f !== null);
      // findings 归属：优先 itemId；否则在同 batch 的 itemIds 内按 key 消歧
      // （恰好 1 个命中才归属，多个命中跳过 —— 不跨 pair 猜测）。
      const batchItemIds = batch.itemIds ?? [];
      for (const f of batchFindings) {
        let itemId = f.itemId;
        if (itemId) {
          // 未知 itemId: id 前缀修复 → key 精确/fuzzy → 全失败保留原 id
          // （生成 unknownItem 兜底行, 意见不丢）。
          itemId = resolveItemId(itemId) ?? resolveByKey(f.key) ?? itemId;
        } else if (f.key) {
          const candidates = batchItemIds.filter((id) => itemsById.get(id)?.key === f.key);
          if (candidates.length === 1) {
            itemId = candidates[0];
          } else if (candidates.length > 1) {
            ambiguousFindings++;
            continue;
          }
        }
        if (!itemId) continue;
        if (!moaFindingsByItem.has(itemId)) moaFindingsByItem.set(itemId, []);
        moaFindingsByItem.get(itemId)!.push({
          origin,
          severity: f.severity ?? "warning",
          issueType: f.issueType,
          detail: f.detail,
          suggestion: f.suggestion,
        });
        if (!flaggedModels.has(itemId)) flaggedModels.set(itemId, new Set());
        flaggedModels.get(itemId)!.add(origin);
      }
      // 覆盖推导：batch.itemIds 全量（无 itemIds 的旧记录退化为 findings 归属）
      const ids = batch.itemIds?.length ? batch.itemIds : [];
      const target = batch.error ? errorModels : coveredModels;
      for (const id of ids) {
        if (!target.has(id)) target.set(id, new Set());
        target.get(id)!.add(origin);
      }
    }
  }

  // ── Merge MoA signals into rows ────────────────────────────────
  for (const itemId of new Set([...moaFindingsByItem.keys(), ...coveredModels.keys(), ...errorModels.keys()])) {
    const it = itemsById.get(itemId);
    const row = getRow(itemId, it);
    const findings = moaFindingsByItem.get(itemId);
    if (findings && findings.length > 0) {
      row.findings.push(...findings);
      row.status = "flagged";
    } else if (errorModels.has(itemId) && row.status !== "flagged") {
      // 有模型失败未覆盖 —— 失败 ≠ pass；但程序候选的必改意见不能被降级
      row.status = "unreviewed";
    }
    // conflict：有意见的模型数 ≥ 1 且成功覆盖的模型数 > 有意见的模型数
    const flagged = flaggedModels.get(itemId)?.size ?? 0;
    const covered = coveredModels.get(itemId)?.size ?? 0;
    if (flagged > 0 && covered > flagged) row.conflict = true;
  }

  // ── source 统一派生（程序/模型意见混合判定）────────────────────
  for (const row of rows.values()) {
    const hasProgram = row.findings.some((f) => f.origin === "program");
    const hasMoa = row.findings.some((f) => f.origin !== "program");
    row.source = hasProgram && hasMoa ? "mixed" : hasProgram ? "program" : "moa";
  }

  // ── Preserve dismissed audit (idempotent rebuild) ──────────────
  const existingDismissed = new Map<string, NonNullable<ReviewAggRow["dismissed"]>>();
  for (const r of existing ?? []) {
    if (r.dismissed) existingDismissed.set(r.itemId, r.dismissed);
  }

  const out = [...rows.values()];
  for (const row of out) {
    const d = existingDismissed.get(row.itemId);
    if (d) row.dismissed = d;
  }
  out.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.key.localeCompare(b.key));
  return { rows: out, ambiguousFindings };
}

/** 汇总统计（供工具返回给 agent）。 */
export function summarizeReviewTable(rows: ReviewAggRow[], ambiguousFindings = 0): {
  total: number;
  flagged: number;
  pass: number;
  unreviewed: number;
  conflict: number;
  dismissed: number;
  ambiguousFindings: number;
} {
  return {
    total: rows.length,
    flagged: rows.filter((r) => r.status === "flagged").length,
    pass: rows.filter((r) => r.status === "pass").length,
    unreviewed: rows.filter((r) => r.status === "unreviewed").length,
    conflict: rows.filter((r) => r.conflict).length,
    dismissed: rows.filter((r) => r.dismissed).length,
    ambiguousFindings,
  };
}
