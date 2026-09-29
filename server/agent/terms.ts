import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTermIndex, type TermIndex } from "../domain/terms.ts";
import { paths } from "../paths.ts";

const TERMS_DIR = join(paths.config, "vanilla-terms");

let pending: Promise<TermIndex | null> | null = null;

async function collect(dir: string, prefix: string, files: Record<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collect(join(dir, entry.name), relativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = await readFile(join(dir, entry.name), "utf8").catch(() => null);
    if (text !== null) files[relativePath] = text;
  }
}

export function vanillaTerms(): Promise<TermIndex | null> {
  pending ??= (async () => {
    const files: Record<string, string> = {};
    await collect(TERMS_DIR, "", files);
    return Object.keys(files).length > 0 ? buildTermIndex(files) : null;
  })();
  return pending;
}
