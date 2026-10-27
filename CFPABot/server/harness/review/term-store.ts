import { join } from "node:path";
import type { TermTable } from "@cfpa/contracts/api";
import { paths } from "../../paths.ts";
import { readJson, withLock, writeJson } from "../../store.ts";

/** PR 级产物：按 head 冻结，换 head 自动失效。 */
export async function loadTermTable(n: number, headSha: string): Promise<TermTable | null> {
  const value = await readJson<TermTable>(join(paths.cache, "terms", `${n}-${headSha.slice(0, 12)}.json`));
  return value !== null && value.prNumber === n && value.headSha === headSha ? value : null;
}

export async function saveTermTable(table: TermTable): Promise<void> {
  await withLock(`term-table:${table.prNumber}`, () =>
    writeJson(join(paths.cache, "terms", `${table.prNumber}-${table.headSha.slice(0, 12)}.json`), table),
  );
}
