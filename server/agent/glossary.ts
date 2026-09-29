import { env } from "../env.ts";
import { logger } from "../log.ts";

const log = logger("glossary");
const TIMEOUT_MS = 10_000;

export interface GlossaryHit {
  en: string;
  zh: string;
  modId?: string;
  key?: string;
  source?: string;
}

function pickString(entry: object, names: string[]): string | undefined {
  const values = Object.entries(entry);
  for (const name of names) {
    for (const [key, value] of values) {
      if (key === name && typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

function listOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function toHit(entry: unknown): GlossaryHit | null {
  if (!entry || typeof entry !== "object") return null;
  const en = pickString(entry, ["en", "english", "source", "term"]);
  const zh = pickString(entry, ["zh", "chinese", "target", "translation", "text"]);
  if (!en || !zh) return null;
  const modId = pickString(entry, ["mod_id", "modId", "mod"]);
  const key = pickString(entry, ["key"]);
  const source = pickString(entry, ["source"]);
  return { en, zh, ...(modId ? { modId } : {}), ...(key ? { key } : {}), ...(source ? { source } : {}) };
}

export async function glossaryLookup(query: string, limit: number): Promise<{ items: GlossaryHit[]; note?: string }> {
  if (!env.GLOSSARY_BIN) return { items: [], note: "未配置 GLOSSARY_BIN，仅返回原版术语" };
  try {
    const proc = Bun.spawn([env.GLOSSARY_BIN, "query", "--lang", "zh_cn", query, "--limit", String(limit), "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
    });
    const exited = proc.exited;
    const text = await new Response(proc.stdout).text();
    const code = await exited;
    if (code !== 0) return { items: [], note: `词典查询退出码 ${code}` };
    const body: unknown = JSON.parse(text);
    return { items: listOf(body).map(toHit).filter((hit): hit is GlossaryHit => hit !== null) };
  } catch (err) {
    log.warn("词典查询失败", { query, err });
    return { items: [], note: "词典查询失败" };
  }
}
