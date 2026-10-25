import type { Finding } from "@cfpa/contracts/api";
import { entryFindings } from "./checks.ts";
import { matchTerms, type TermIndex } from "./terms.ts";

export interface EntryValues {
  baseEn?: string;
  headEn?: string;
  baseZh?: string;
  headZh?: string;
}

/** 未在本 PR 变动的条目不再判 entry/term；Bot 报告与面板 Pack 共用这一条规则。 */
export function entryFindingsWithTerms(
  key: string,
  values: EntryValues,
  version: string,
  terms: TermIndex | null,
): Finding[] {
  if (values.baseEn === values.headEn && values.baseZh === values.headZh) return [];
  const findings = entryFindings(key, values.headEn, values.headZh, { en: values.baseEn, zh: values.baseZh });
  if (!terms || values.headEn === undefined) return findings;
  for (const hit of matchTerms(terms, key, values.headEn, values.headZh ?? "", version)) {
    if (hit.ok) continue;
    findings.push({
      source: "term",
      code: `term:${hit.id ?? hit.en}`,
      severity: "major",
      detail: `${hit.en} → ${hit.zh.join(" / ")}${hit.reason ? `（${hit.reason}）` : ""}`,
      key,
    });
  }
  return findings;
}
