import crypto from "node:crypto";

// src/flows/_shared/language/align-review-items.ts
// PURE: Align four lang-entry maps into stable LangReviewItems with program candidates.
// No I/O, no globals, no side effects.
//
//   alignLangReviewItems({ baseEn, headEn, baseZh, headZh, mod, path, scope })
//
// Produces items keyed by stable itemId (derived from repo/PR/head/path/key, never an
// array index) and program candidates (missing/orphan/empty/stale/untranslated/format
// mismatches). Optional four-value fields: absent = undefined, "" = real empty string.

import { checkEntryFormat } from "./format-checks.js";

// ─── Item ID ────────────────────────────────────────────────────────────

/**
 * Deterministic, collision-resistant SHA-256 hex digest from fixed scope
 * components. Uses synchronous node:crypto.createHash (existing project
 * convention — see engine/execute.ts, info-comment/state.ts).
 * Never uses an array index.
 */
function computeItemId(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  headSha: string,
  path: string,
  key: string,
): string {
  const input = `${repoOwner}/${repoName}#${prNumber}@${headSha}:${path}/${key}`;
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}


// ─── Types ──────────────────────────────────────────────────────────────

export interface LangReviewItem {
  /** Stable ID derived from repo/PR/head/path/key — never an array index. */
  itemId: string;
  mod: {
    slug: string;
    gameVersion: string;
    domain: string;
  };
  path: string;
  key: string;
  /**
   * English value at base ref. `undefined` when base file was missing
   * or the key was absent. `""` is a real value, not a sentinel.
   */
  baseEn?: string;
  /**
   * English value at head ref. `undefined` when head file was missing
   * or the key was absent. `""` is a real value, not a sentinel.
   */
  headEn?: string;
  /**
   * Chinese value at base ref. `undefined` when base file was missing
   * or the key was absent. `""` is a real value, not a sentinel.
   */
  baseZh?: string;
  /**
   * Chinese value at head ref. `undefined` when head file was missing
   * or the key was absent. `""` is a real value, not a sentinel.
   */
  headZh?: string;
  /** Whether this key's en_us and/or zh_cn value changed between base and head. */
  changed: {
    en: boolean;
    zh: boolean;
  };
  /**
   * 跨版本合并条目的版本明细 (2026-08-03): 对齐后同 (slug, domain, key, headEn)
   * 的条目合并为一条, 各版本 zh/path 全保留。未合并的单版本条目无此字段。
   * mod.gameVersion 保留首版本值(兼容), 版本全量以本字段为准。
   */
  versions?: {
    gameVersion: string;
    path: string;
    baseZh?: string;
    headZh?: string;
  }[];
  /** 版本间存在多个不同的非空 headZh(版本敏感术语, 提示模型注意差异)。 */
  zhVariant?: boolean;
  /**
   * "changed" if en or zh values differ between base and head (including key
   * added/removed). "historical" if neither value changed — the item is an
   * existing entry untouched by this PR.
   */
  scope: "changed" | "historical";
  /**
   * 译前准备意见（review_prep 填充，2026-08-04）：TM 批量命中 + 术语匹配
   * （含原版自动注入）。无 verdict/reason —— 只供 MoA prompt 渲染与主 agent
   * 综合裁决参考，全部为软意见。未跑 review_prep 的条目无此字段。
   */
  prep?: PrepRow;
  /**
   * Source line location. The pure function leaves this undefined; callers
   * that have access to the raw file content may enrich items with the
   * correct LEFT/RIGHT line numbers.
   */
  sourceLocation?: {
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
  };
}

/** 译前准备行级意见（review_prep 产出，软参考，无 verdict/reason）。 */
export interface PrepRow {
  /** TM 批量命中（同一模组索引，BM25/模糊 前 N 条）。 */
  tm?: {
    en: string;
    zh: string;
    path: string;
    score: number;
  }[];
  /** 本行命中的术语（agent 库 + 原版自动注入），ok=false = 术语匹配失败。 */
  terms?: {
    source: "vanilla" | "agent_search" | "forced_vanilla" | "internal" | "ngram" | "tm";
    en: string;
    zh: string[];
    ok: boolean;
  }[];
}

export type ProgramIssueType =
  | "missing_translation"
  | "orphan_translation"
  | "empty_value"
  | "stale_translation"
  | "untranslated_value"
  // 确定性格式检查 (format-checks.ts, 2026-08-04 移植)
  | "placeholder_count_mismatch"
  | "special_tag_mismatch"
  | "tellraw_mismatch"
  | "music_disc_translated"
  | "punctuation_issue"
  | "energy_unit_translated"
  | "ellipsis_issue"
  | "subtitle_format_issue";

export interface ProgramCandidate {
  itemId: string;
  issueType: ProgramIssueType;
  severity: "error" | "warning";
  detail?: string;
}

export interface AlignReviewItemsInput {
  /** English entries at base ref, or undefined if the file was missing/unparseable. */
  baseEn?: Record<string, string>;
  /** English entries at head ref, or undefined. */
  headEn?: Record<string, string>;
  /** Chinese entries at base ref, or undefined. */
  baseZh?: Record<string, string>;
  /** Chinese entries at head ref, or undefined. */
  headZh?: Record<string, string>;
  /** Mod identity (slug / version / domain). */
  mod: {
    slug: string;
    gameVersion: string;
    domain: string;
  };
  /** Changed file path (e.g. "projects/1.20.1/.../zh_cn.json"). */
  path: string;
  /** Fixed review scope for stable itemId generation. */
  scope: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    headSha: string;
  };
}

export interface AlignReviewItemsResult {
  /** Aligned LangReviewItems, sorted by path then key. */
  items: LangReviewItem[];
  /** Program candidates detected from the four-value alignment. */
  candidates: ProgramCandidate[];
}

// ─── Helpers ────────────────────────────────────────────────────────────

function valueOrUndefined(
  map: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (map === undefined) return undefined;
  // hasOwnProperty check to distinguish missing key from empty string
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  return map[key];
}

// ─── Main ───────────────────────────────────────────────────────────────

/**
 * Align four optional lang-entry maps into a stable array of LangReviewItems
 * with detected program candidates.
 *
 * The four maps are aligned by key union. Every key appears exactly once
 * in the output; absent maps produce undefined values (never `""` sentinels).
 * The output is sorted by path then key for stable ordering.
 *
 * Program candidates are generated for:
 * - **missing_translation**: head en present, head zh absent
 * - **orphan_translation**: head en absent, head zh present
 * - **empty_value**: head zh is `""` (distinct from missing)
 * - **stale_translation**: en changed, zh unchanged (both present in head)
 * - **untranslated_value**: head zh equals head en and contains ASCII text
 * - **format_mismatch**: head en has printf specifiers absent from head zh
 * - **placeholder_mismatch**: head en has placeholders absent from head zh
 */
export function alignLangReviewItems(
  input: AlignReviewItemsInput,
): AlignReviewItemsResult {
  const { baseEn, headEn, baseZh, headZh, mod, path, scope } = input;

  const baseEnMap = baseEn ?? {};
  const headEnMap = headEn ?? {};
  const baseZhMap = baseZh ?? {};
  const headZhMap = headZh ?? {};

  // Key union across all four maps
  const allKeys = new Set([
    ...Object.keys(baseEnMap),
    ...Object.keys(headEnMap),
    ...Object.keys(baseZhMap),
    ...Object.keys(headZhMap),
  ]);

  // Stable ordering: sort by key
  const sortedKeys = [...allKeys].sort();

  const items: LangReviewItem[] = [];
  const candidates: ProgramCandidate[] = [];

  for (const key of sortedKeys) {
    // Resolve values with explicit undefined vs "" distinction
    const bEn = valueOrUndefined(baseEn, key);
    const hEn = valueOrUndefined(headEn, key);
    const bZh = valueOrUndefined(baseZh, key);
    const hZh = valueOrUndefined(headZh, key);

    // Presence changes
    const enAdded = bEn === undefined && hEn !== undefined;
    const enRemoved = bEn !== undefined && hEn === undefined;
    const enChanged = bEn !== undefined && hEn !== undefined && bEn !== hEn;

    const zhAdded = bZh === undefined && hZh !== undefined;
    const zhRemoved = bZh !== undefined && hZh === undefined;
    const zhChanged = bZh !== undefined && hZh !== undefined && bZh !== hZh;

    const enIsChanged = enAdded || enRemoved || enChanged;
    const zhIsChanged = zhAdded || zhRemoved || zhChanged;
    const isChanged = enIsChanged || zhIsChanged;

    const itemId = computeItemId(
      scope.repoOwner,
      scope.repoName,
      scope.prNumber,
      scope.headSha,
      path,
      key,
    );

    const item: LangReviewItem = {
      itemId,
      mod,
      path,
      key,
      baseEn: bEn,
      headEn: hEn,
      baseZh: bZh,
      headZh: hZh,
      changed: {
        en: enIsChanged,
        zh: zhIsChanged,
      },
      scope: isChanged ? "changed" : "historical",
    };
    items.push(item);

    // ── Program candidates ──────────────────────────────────────────

    // 1. Missing translation: head en present, head zh absent
    if (hEn !== undefined && hZh === undefined) {
      candidates.push({
        itemId,
        issueType: "missing_translation",
        severity: "error",
        detail: `Key "${key}" is present in head en_us but missing from zh_cn`,
      });
    }

    // 2. Orphan translation: head en absent, head zh present
    if (hEn === undefined && hZh !== undefined) {
      candidates.push({
        itemId,
        issueType: "orphan_translation",
        severity: "warning",
        detail: `Key "${key}" is present in head zh_cn but absent from en_us`,
      });
    }

    // 3. Empty value: head zh exists and is ""
    if (hZh !== undefined && hZh === "") {
      candidates.push({
        itemId,
        issueType: "empty_value",
        severity: "warning",
        detail: `zh_cn value for "${key}" is an empty string`,
      });
    }

    // 4. Stale translation: en changed (in head), zh unchanged
    if (enChanged && hZh !== undefined && !zhChanged) {
      candidates.push({
        itemId,
        issueType: "stale_translation",
        severity: "warning",
        detail: `English "${bEn}" → "${hEn}" but Chinese remains "${hZh}"`,
      });
    }

    // 5. Untranslated value: head zh equals head en and contains ASCII
    if (
      hEn !== undefined &&
      hZh !== undefined &&
      hEn === hZh &&
      /[a-zA-Z]/.test(hZh)
    ) {
      candidates.push({
        itemId,
        issueType: "untranslated_value",
        severity: "warning",
        detail: `Chinese "${hZh}" matches English source — likely untranslated`,
      });
    }
  }

  // ── Cross-key candidates (deterministic format checks) ─────────────
  // 占位符数量/特殊标签/tellraw/唱片名/标点/能量单位/省略号/字幕格式
  // （format-checks.ts，移植自 MTPA FormatChecker）。零 LLM 成本。

  if (headEn !== undefined && headZh !== undefined) {
    for (const key of sortedKeys) {
      const hEn = headEn[key];
      const hZh = headZh[key];
      // Only check when both exist (not undefined)
      if (hEn === undefined || hZh === undefined) continue;

      const itemId = computeItemId(
        scope.repoOwner,
        scope.repoName,
        scope.prNumber,
        scope.headSha,
        path,
        key,
      );

      for (const f of checkEntryFormat(key, hEn, hZh)) {
        candidates.push({
          itemId,
          issueType: f.issueType,
          severity: f.severity,
          detail: f.detail,
        });
      }
    }
  }

  return { items, candidates };
}

// ─── Cross-version merging (2026-08-03) ─────────────────────────────────
// 同 (slug, domain, key, headEn) 的跨版本条目在对齐后合并为一条:
// 多版本 zh 全保留, MoA 一次审覆盖全部版本; 合并条件本身即"版本敏感检测" —
// 版本间 zh 不同(版本敏感术语)不拆开, 而是标记 zhVariant 让模型同时看到差异。

/** 合并后的跨版本条目 = 带 versions/zhVariant 的 LangReviewItem(统一类型贯穿全链路)。 */
export interface MergedAlignedResult {
  items: LangReviewItem[];
  candidates: ProgramCandidate[];
}

/**
 * 合并跨版本同源条目(纯函数)。分组键 (slug, domain, key, headEn):
 * - 同 key 同 head 英文原文 → 合并为一条(多版本 zh 全保留)
 * - headEn undefined 与 "" 区分(前缀标记防撞组)
 * - 程序候选按旧 itemId 重映射到合并 id, 同 (issueType, severity) 去重
 * - scope/changed 取组内或(任一 changed 即 changed)
 * - zhVariant: 组内非空 headZh 去重后多于 1 个
 */
export function mergeAlignedItems(
  results: AlignReviewItemsResult[],
  scope: { repoOwner: string; repoName: string; prNumber: number; headSha: string },
): MergedAlignedResult {
  // 组: key = slug\0domain\0key\0<en-prefix>
  interface Group {
    items: LangReviewItem[];
    candidates: ProgramCandidate[];
  }
  const groups = new Map<string, Group>();
  const oldToNewId = new Map<string, string>();

  for (const res of results) {
    for (const it of res.items) {
      const enKey = it.headEn === undefined ? "\u0001" : it.headEn;
      const gk = `${it.mod.slug}\u0000${it.mod.domain}\u0000${it.key}\u0000${enKey}`;
      let g = groups.get(gk);
      if (!g) {
        g = { items: [], candidates: [] };
        groups.set(gk, g);
      }
      g.items.push(it);
      const newId = computeMergedItemId(
        scope.repoOwner,
        scope.repoName,
        scope.prNumber,
        scope.headSha,
        it.mod.slug,
        it.mod.domain,
        it.key,
      );
      oldToNewId.set(it.itemId, newId);
    }
    for (const c of res.candidates) {
      // 候选按组归位: 找其 itemId 所属组(用原 item 定位组键)
      const owner = res.items.find((it) => it.itemId === c.itemId);
      if (!owner) continue;
      const enKey = owner.headEn === undefined ? "\u0001" : owner.headEn;
      const gk = `${owner.mod.slug}\u0000${owner.mod.domain}\u0000${owner.key}\u0000${enKey}`;
      let g = groups.get(gk);
      if (!g) {
        g = { items: [], candidates: [] };
        groups.set(gk, g);
      }
      g.candidates.push(c);
    }
  }

  const items: LangReviewItem[] = [];
  const candidates: ProgramCandidate[] = [];
  for (const g of groups.values()) {
    const first = g.items[0]!;
    const versions = g.items.map((it) => ({
      gameVersion: it.mod.gameVersion,
      path: it.path,
      ...(it.baseZh !== undefined ? { baseZh: it.baseZh } : {}),
      ...(it.headZh !== undefined ? { headZh: it.headZh } : {}),
    }));
    const zhSet = new Set(g.items.map((it) => it.headZh).filter((z): z is string => z !== undefined && z !== ""));
    items.push({
      itemId: oldToNewId.get(first.itemId)!,
      mod: { slug: first.mod.slug, gameVersion: versions[0]!.gameVersion, domain: first.mod.domain },
      path: versions[0]!.path,
      key: first.key,
      ...(first.headEn !== undefined ? { headEn: first.headEn } : {}),
      versions,
      changed: {
        en: g.items.some((it) => it.changed.en),
        zh: g.items.some((it) => it.changed.zh),
      },
      scope: g.items.some((it) => it.scope === "changed") ? "changed" : "historical",
      ...(zhSet.size > 1 ? { zhVariant: true } : {}),
    });
    // 候选去重 (issueType+severity) 并重映射 itemId
    const seen = new Set<string>();
    for (const c of g.candidates) {
      const dedupKey = `${c.issueType}:${c.severity}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const newId = oldToNewId.get(c.itemId) ?? c.itemId;
      candidates.push({ ...c, itemId: newId });
    }
  }

  items.sort((a, b) => a.key.localeCompare(b.key));
  candidates.sort((a, b) => a.itemId.localeCompare(b.itemId));
  return { items, candidates };
}

/**
 * 合并条目的稳定 itemId: 派生分量去掉版本 path, 跨版本同源条目同 id。
 */
function computeMergedItemId(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  headSha: string,
  slug: string,
  domain: string,
  key: string,
): string {
  const input = `${repoOwner}/${repoName}#${prNumber}@${headSha}:${slug}/${domain}/${key}`;
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}
