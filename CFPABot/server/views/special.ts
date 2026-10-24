import { compareLang } from "@cfpa/review-core/domain/diff";
import { parseFlatten, specialFormat } from "../domain/flatten.ts";
import type { FlattenParsed } from "../domain/flatten.ts";
import { isSpecialPath, planSpecial, resolveDerived, resolveSpecial } from "../domain/special.ts";
import type { PlannedSide, SpecialPlan } from "../domain/special.ts";
import type { GhFile, GhPull } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import { prdata } from "../prdata.ts";
import { commentableHunks } from "../review.ts";
import { sidePaths, type FileSource } from "../domain/pr.ts";
import type { SpecialKeyRow, SpecialPair, SpecialPairContent, SpecialParsed, SpecialText } from "@cfpa/contracts/api";

const SPECIAL_MAX_BYTES = 200 * 1024;

interface Capped {
  text: string | null;
  truncated: boolean;
}

function cap(text: string | null): Capped {
  if (text === null) return { text: null, truncated: false };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= SPECIAL_MAX_BYTES) return { text, truncated: false };
  return { text: bytes.subarray(0, SPECIAL_MAX_BYTES).toString("utf8"), truncated: true };
}

async function specialPlanFor(n: number): Promise<{ pull: GhPull; files: GhFile[]; plans: SpecialPlan[]; existing: ReadonlySet<string> }> {
  const { pull, files } = await prdata.files(n);
  const plans = planSpecial(files.filter((file) => isSpecialPath(file.path)));
  const derived: string[] = [];
  for (const plan of plans) {
    if (plan.kind === "single") continue;
    for (const side of [plan.en, plan.zh]) {
      if (side.file !== null) continue;
      derived.push(side.path);
      if (side.alternate !== undefined) derived.push(side.alternate);
    }
  }
  const rev = (await mirror.headSha()) ?? "HEAD";
  const existing = derived.length === 0 ? new Set<string>() : await mirror.existing(rev, derived);
  return { pull, files, plans: resolveDerived(plans, existing), existing };
}

export async function specialPairs(n: number): Promise<SpecialPair[]> {
  const { plans, existing } = await specialPlanFor(n);
  return resolveSpecial(plans, existing);
}

const emptyParsed = (): FlattenParsed => ({ entries: new Map(), lines: new Map() });

function specialParsedOf(format: string, en: SpecialText, zh: SpecialText): SpecialParsed | null {
  const read = (text: string | null): FlattenParsed | null => (text === null ? emptyParsed() : parseFlatten(text));
  const baseEn = read(en.base);
  const headEn = read(en.head);
  const baseZh = read(zh.base);
  const headZh = read(zh.head);
  if (baseEn === null || headEn === null || baseZh === null || headZh === null) return null;
  const rows: SpecialKeyRow[] = [];
  for (const row of compareLang({ en: baseEn, zh: baseZh }, { en: headEn, zh: headZh })) {
    const enLine = headEn.lines.get(row.key);
    const zhLine = headZh.lines.get(row.key);
    rows.push({
      ...row,
      ...(enLine === undefined ? {} : { enLine }),
      ...(zhLine === undefined ? {} : { zhLine }),
    });
  }
  return { format, rows };
}

export async function specialPairContent(n: number, key: string, source: FileSource): Promise<SpecialPairContent | null> {
  const { pull, files, plans, existing } = await specialPlanFor(n);
  const entry = plans.find((plan) => plan.key === key);
  if (entry === undefined) return null;
  const read = source.read;
  const textOf = async (side: PlannedSide): Promise<SpecialText> => {
    const file = side.file;
    let baseText: string | null;
    let headText: string | null;
    if (file === null) {
      const text = existing.has(side.path) ? await read(side.path, pull.headSha) : null;
      baseText = text;
      headText = text;
    } else {
      const paths = sidePaths(file);
      [baseText, headText] = await Promise.all([read(paths.base, pull.baseSha), read(paths.head, pull.headSha)]);
    }
    const base = cap(baseText);
    const head = cap(headText);
    const prFile = files.find((entry) => entry.path === side.path);
    return {
      path: side.path,
      status: file === null ? (existing.has(side.path) ? "unchanged" : "missing") : file.status,
      ...(file?.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      base: base.text,
      head: head.text,
      truncated: base.truncated || head.truncated,
      hunks: prFile === undefined || prFile.status === "removed" ? null : commentableHunks(prFile, headText),
    };
  };
  if (entry.kind === "single") return { key: entry.key, kind: "single", file: await textOf(entry.file) };
  const [en, zh] = await Promise.all([textOf(entry.en), textOf(entry.zh)]);
  const format = specialFormat(entry.en.path);
  const parsed =
    format !== null && format === specialFormat(entry.zh.path) && !en.truncated && !zh.truncated
      ? specialParsedOf(format, en, zh)
      : null;
  return { key: entry.key, kind: "pair", en, zh, parsed };
}
