// src/agent/tools/terms-distill.ts
// Custom tool: terms_distill — agent 从三来源（+ngram/tm）候选裁决出真正有用
// 的术语表。写 ctx.termsDistilled = { cleaned, audit }：
// - cleaned: status=accepted 的词条 —— 后续 MoA 只注入这一份
// - audit: 全部裁决（含 rejected/conflict）—— 完整审计记录
// 契约 (2026-08-01): 不允许凭空造词 —— word+text 必须来自 ctx.dict（或已有
// audit）；forced_vanilla 来源的词条被 rejected 必须带 evidence（强制规则保护）；
// agent 只能裁决不能发明。

import { Type } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, setSessionCtx, type CleanedTerm, type DictEntry } from "../session-ctx.js";
import { persistSessionCtx } from "../ctx-store.js";

interface DistillDecision {
  word: string;
  text: string;
  status: "accepted" | "rejected" | "conflict";
  evidence?: string;
  reason?: string;
}

interface TermsDistillParams {
  decisions: DistillDecision[];
}

function isTermsDistillParams(x: unknown): x is TermsDistillParams {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return Array.isArray(p.decisions);
}

export function createTermsDistillTool(sessionId: string): ToolDefinition {
  const parameters = Type.Object({
    decisions: Type.Array(
      Type.Object({
        word: Type.String({ description: "词条（必须来自 ctx.dict，不能凭空发明）" }),
        text: Type.String({ description: "词条译文" }),
        status: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("conflict")]),
        evidence: Type.Optional(Type.String({ description: "依据（rejected 的 forced_vanilla 词条必填）" })),
        reason: Type.Optional(Type.String({ description: "rejected/conflict 理由" })),
      }),
      { description: "对每个候选术语的裁决" },
    ),
  });

  return {
    name: "terms_distill",
    label: "清洗术语表",
    description:
      "把三来源（agent_search/forced_vanilla/internal/ngram/tm）候选裁决为一份真正有用的术语表：accepted 进 cleaned（后续 MoA 只注入这份），全部裁决进 audit（审计）。词条必须来自 ctx.dict，不能发明；rejected 的 forced_vanilla 词条必须提供 evidence。写入 ctx.termsDistilled 并落盘。**清洗完成前不要调用 review_moa**（MoA 只注入 cleaned）。",
    parameters,
    execute: async (_toolCallId, params) => {
      if (!isTermsDistillParams(params)) {
        const err = { ok: false, errors: ["无效参数：需要 decisions[]"] };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }
      const ctx = getSessionCtx(sessionId);
      const dict = ctx.dict ?? [];
      const existingAudit = ctx.termsDistilled?.audit ?? [];

      // ── 词源校验：word+text 必须存在于 ctx.dict 或已有 audit ─
      const dictKeys = new Set(dict.map((e) => `${e.word}\u0000${e.text}`));
      const auditKeys = new Set(existingAudit.map((t) => `${t.word}\u0000${t.text}`));
      const sourceByKey = new Map<string, DictEntry["source"]>();
      for (const e of dict) sourceByKey.set(`${e.word}\u0000${e.text}`, e.source);
      for (const t of existingAudit) sourceByKey.set(`${t.word}\u0000${t.text}`, t.source);

      const errors: string[] = [];
      const nextAudit: CleanedTerm[] = [...existingAudit];
      const auditSeen = new Set(auditKeys);

      for (const d of params.decisions) {
        const key = `${d.word}\u0000${d.text}`;
        if (!dictKeys.has(key) && !auditKeys.has(key)) {
          errors.push(`词条不在 ctx.dict 中，不能发明: "${d.word}" → "${d.text}"`);
          continue;
        }
        const source = sourceByKey.get(key) ?? "internal";
        if (source === "forced_vanilla" && d.status === "rejected" && !d.evidence?.trim()) {
          errors.push(`rejected 的 forced_vanilla 词条必须提供 evidence: "${d.word}"`);
          continue;
        }
        const entry: CleanedTerm = {
          word: d.word,
          text: d.text,
          status: d.status,
          source,
          evidence: d.evidence,
          reason: d.reason,
        };
        if (auditSeen.has(key)) {
          const idx = nextAudit.findIndex((t) => t.word === d.word && t.text === d.text);
          if (idx >= 0) nextAudit[idx] = entry;
        } else {
          nextAudit.push(entry);
          auditSeen.add(key);
        }
      }

      if (errors.length > 0) {
        const err = { ok: false, errors };
        return { content: [{ type: "text", text: JSON.stringify(err) }], details: err };
      }

      const cleaned = nextAudit.filter((t) => t.status === "accepted");
      setSessionCtx(sessionId, {
        ...ctx,
        termsDistilled: { cleaned, audit: nextAudit },
      });
      await persistSessionCtx(sessionId);

      const summary = {
        ok: true,
        cleaned: cleaned.length,
        audit: nextAudit.length,
        rejected: nextAudit.filter((t) => t.status === "rejected").length,
        conflict: nextAudit.filter((t) => t.status === "conflict").length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        details: summary,
      };
    },
  };
}
