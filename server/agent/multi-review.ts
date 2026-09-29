import type { Severity } from "../../shared/api.ts";

export interface ReviewItem {
  id: string;
  key: string;
  en: string;
  zh: string;
  baseEn?: string;
  baseZh?: string;
  notes?: string[];
}

export interface Reviewer {
  id: string;
  complete(system: string, user: string, signal?: AbortSignal): Promise<string>;
}

export interface MultiReviewInput {
  items: ReviewItem[];
  reviewers: Reviewer[];
  guidance: string;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { reviewer: string; batch: number; batches: number; ok: boolean }) => void;
}

export interface MergedFinding {
  itemId: string;
  key: string;
  mqm: string;
  severity: Severity;
  detail: string;
  suggestion?: string;
  reviewers: string[];
}

export interface MultiReviewResult {
  findings: MergedFinding[];
  coverage: { reviewer: string; ok: number; failed: number }[];
  unreviewed: string[];
}

const MAX_BATCH = 30;
const CALL_RETRY_MAX = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const RETRY_JITTER_RATIO = 0.3;
const DEFAULT_CONCURRENCY = 2;
const REPAIR_LIMIT = 4000;

const SEVERITY_RANK: Record<Severity, number> = { neutral: 0, minor: 1, major: 2, critical: 3 };

const SYSTEM_PROMPT = `# 翻译审查评审员

你是 Minecraft 模组翻译审查员。你将收到一批 EN/ZH 对齐条目（含 base/head 变更）。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{"findings":[{"itemId":"<条目的 id>","key":"<条目的 key>","mqm":"<Dim/type>","severity":"critical|major|minor|neutral","detail":"<问题说明>","suggestion":"<可选：替换后的整行译文>"}]}

规则：
- itemId 必须取自输入条目的 [id] 标记；key 一并给出。
- mqm 必须使用受控词表里的全形 Dim/type，不许自编。
- severity 四档：critical 崩溃/反义，major 错义/漏译/关键术语错，minor 体例/标点/风格，neutral 灰区；不确定的标 minor 或 neutral。
- 只报有依据的问题，不要复述程序提示；认为程序提示误报时不必输出。
- 没有问题时输出 {"findings":[]}。`;

interface BatchResult {
  ok: boolean;
  findings: MergedFinding[];
}

function retryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return true;
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  const jitter = base * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(finish, ms);
  function finish(): void {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  }
  signal?.addEventListener("abort", finish, { once: true });
  return promise;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toFindings(parsed: unknown, items: ReviewItem[], reviewer: string): MergedFinding[] | null {
  if (!parsed || typeof parsed !== "object" || !("findings" in parsed)) return null;
  const list = parsed.findings;
  if (!Array.isArray(list)) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const byKey = new Map(items.map((item) => [item.key, item]));
  const findings: MergedFinding[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const rawItemId = "itemId" in raw ? raw.itemId : undefined;
    const rawKey = "key" in raw ? raw.key : undefined;
    let item = typeof rawItemId === "string" ? byId.get(rawItemId) : undefined;
    if (!item && typeof rawItemId === "number") item = items[rawItemId];
    if (!item && typeof rawKey === "string") item = byKey.get(rawKey);
    if (!item) continue;
    const detail = "detail" in raw && typeof raw.detail === "string" ? raw.detail.trim() : "";
    if (!detail) continue;
    const mqm = "mqm" in raw && typeof raw.mqm === "string" ? raw.mqm.trim() : "";
    const rawSeverity = "severity" in raw && typeof raw.severity === "string" ? raw.severity.trim().toLowerCase() : "";
    const severity: Severity =
      rawSeverity === "critical" || rawSeverity === "major" || rawSeverity === "minor" || rawSeverity === "neutral"
        ? rawSeverity
        : "minor";
    const suggestion = "suggestion" in raw && typeof raw.suggestion === "string" ? raw.suggestion : undefined;
    findings.push({
      itemId: item.id,
      key: item.key,
      mqm,
      severity,
      detail,
      ...(suggestion ? { suggestion } : {}),
      reviewers: [reviewer],
    });
  }
  return findings;
}

async function runBatch(reviewer: Reviewer, items: ReviewItem[], system: string, user: string, signal?: AbortSignal): Promise<BatchResult> {
  let repaired = false;
  for (let attempt = 0; attempt < CALL_RETRY_MAX; attempt++) {
    if (signal?.aborted) break;
    try {
      const text = await reviewer.complete(system, user, signal);
      const parsed = extractJson(text);
      const findings = parsed === null ? null : toFindings(parsed, items, reviewer.id);
      if (findings) return { ok: true, findings };
      if (!repaired) {
        repaired = true;
        try {
          const repairPrompt = `${user}\n\n上一次回复不是合法 JSON，请只输出 JSON 对象：\n${text.slice(0, REPAIR_LIMIT)}`;
          const fixed = extractJson(await reviewer.complete(system, repairPrompt, signal));
          const repairedFindings = fixed === null ? null : toFindings(fixed, items, reviewer.id);
          if (repairedFindings) return { ok: true, findings: repairedFindings };
        } catch (err) {
          if (!retryable(err, signal)) return { ok: false, findings: [] };
        }
      }
    } catch (err) {
      if (!retryable(err, signal)) return { ok: false, findings: [] };
    }
    if (attempt + 1 < CALL_RETRY_MAX) await sleep(retryDelayMs(attempt), signal);
  }
  return { ok: false, findings: [] };
}

function buildBatchPrompt(items: ReviewItem[], index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`## 待审查条目（第 ${index + 1}/${total} 批，共 ${items.length} 条）`);
  for (const item of items) {
    lines.push(`[${item.id}] ${item.key}`);
    lines.push(`head 原文: ${item.en}`);
    lines.push(`head 译文: ${item.zh}`);
    if (item.baseEn !== undefined && item.baseEn !== item.en) lines.push(`base 原文: ${item.baseEn}`);
    if (item.baseZh !== undefined && item.baseZh !== item.zh) lines.push(`base 译文: ${item.baseZh}`);
    if (item.notes && item.notes.length > 0) lines.push(`程序提示: ${item.notes.join("；")}`);
    lines.push("");
  }
  lines.push('请输出 JSON：{"findings":[...]}');
  return lines.join("\n");
}

async function mapConcurrent<T, R>(list: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (list.length === 0) return [];
  const size = Math.max(1, Math.min(limit, list.length));
  const chunks: number[][] = Array.from({ length: size }, () => []);
  list.forEach((_, index) => chunks[index % size]?.push(index));
  const parts = await Promise.all(
    chunks.map(async (indices) => {
      const out: { index: number; value: R }[] = [];
      for (const index of indices) {
        const item = list[index];
        if (item === undefined) continue;
        out.push({ index, value: await fn(item, index) });
      }
      return out;
    }),
  );
  return parts.flat().sort((a, b) => a.index - b.index).map((entry) => entry.value);
}

export async function multiReview(input: MultiReviewInput): Promise<MultiReviewResult> {
  if (input.reviewers.length === 0) throw new Error("multiReview 需要至少一个评审模型");
  const batchSize = Math.max(1, Math.min(MAX_BATCH, input.batchSize ?? MAX_BATCH));
  const batches: ReviewItem[][] = [];
  for (let index = 0; index < input.items.length; index += batchSize) {
    batches.push(input.items.slice(index, index + batchSize));
  }
  const system = `${SYSTEM_PROMPT}\n\n${input.guidance}`.trim();
  const tasks: { reviewer: Reviewer; batch: number }[] = [];
  for (const reviewer of input.reviewers) {
    for (let batch = 0; batch < batches.length; batch++) tasks.push({ reviewer, batch });
  }
  const results = await mapConcurrent(tasks, input.concurrency ?? DEFAULT_CONCURRENCY, async (task) => {
    const items = batches[task.batch] ?? [];
    const user = buildBatchPrompt(items, task.batch, batches.length);
    const result = await runBatch(task.reviewer, items, system, user, input.signal);
    input.onProgress?.({ reviewer: task.reviewer.id, batch: task.batch + 1, batches: batches.length, ok: result.ok });
    return { reviewer: task.reviewer.id, items, result };
  });
  const merged = new Map<string, MergedFinding>();
  const coverage = new Map<string, { reviewer: string; ok: number; failed: number }>();
  const failedItems = new Set<string>();
  for (const entry of results) {
    const stat = coverage.get(entry.reviewer) ?? { reviewer: entry.reviewer, ok: 0, failed: 0 };
    if (entry.result.ok) {
      stat.ok++;
    } else {
      stat.failed++;
      for (const item of entry.items) failedItems.add(item.id);
    }
    coverage.set(entry.reviewer, stat);
    for (const finding of entry.result.findings) {
      const key = `${finding.itemId}\u0000${finding.mqm}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, finding);
        continue;
      }
      existing.reviewers = [...new Set([...existing.reviewers, ...finding.reviewers])];
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) existing.severity = finding.severity;
      if (!existing.suggestion && finding.suggestion) existing.suggestion = finding.suggestion;
      if (finding.detail.length > existing.detail.length) existing.detail = finding.detail;
    }
  }
  const findings = [...merged.values()];
  const flagged = new Set(findings.map((finding) => finding.itemId));
  return {
    findings,
    coverage: input.reviewers.map((reviewer) => coverage.get(reviewer.id) ?? { reviewer: reviewer.id, ok: 0, failed: 0 }),
    unreviewed: [...failedItems].filter((id) => !flagged.has(id)),
  };
}
