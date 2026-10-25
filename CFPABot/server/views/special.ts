import { compareLang } from "@cfpa/review-core/domain/diff";
import { parseFlatten, specialFormat } from "../domain/flatten.ts";
import type { FlattenParsed } from "../domain/flatten.ts";
import { isSpecialPath, planAtHead, planSpecial, resolveDerived, resolveSpecial, specialStatusOf } from "../domain/special.ts";
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

interface SpecialPlanData {
  pull: GhPull;
  files: GhFile[];
  plans: SpecialPlan[];
  existing: ReadonlySet<string>;
  moved: ReadonlySet<string>;
}

const planCache = new Map<string, Promise<SpecialPlanData>>();

async function specialPlanFor(n: number): Promise<SpecialPlanData> {
  const { pull, files } = await prdata.files(n);
  const rev = (await mirror.headSha()) ?? "HEAD";
  const cacheKey = `${n}@${pull.headSha}@${rev}`;
  const cached = planCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<SpecialPlanData> => {
    const special = files.filter((file) => isSpecialPath(file.path));
    const plans = planSpecial(special);
    const moved = new Set(
      special.flatMap((file) => (file.status === "renamed" && file.previousPath !== undefined ? [file.previousPath] : [])),
    );
    const derived: string[] = [];
    for (const plan of plans) {
      if (plan.kind === "single") continue;
      for (const side of [plan.en, plan.zh]) {
        if (side.file !== null) continue;
        derived.push(side.path);
        if (side.alternate !== undefined) derived.push(side.alternate);
      }
    }
    const existing =
      derived.length === 0
        ? new Set<string>()
        : await mirror.existing(rev, derived).catch(() => new Set<string>());
    const resolved = resolveDerived(plans, existing);
    // 两侧都不在 head 的组不产出：删除记录留在文件页。
    return { pull, files, plans: resolved.filter((plan) => planAtHead(plan, existing, moved)), existing, moved };
  })();
  planCache.set(cacheKey, pending);
  void pending.catch(() => planCache.delete(cacheKey));
  if (planCache.size > 8) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  return pending;
}

export async function specialPairs(n: number): Promise<SpecialPair[]> {
  const { plans, existing, moved } = await specialPlanFor(n);
  return resolveSpecial(plans, existing, moved);
}

const AGENT_TEXT_BYTES = 12_000;

function clippedText(text: string | null): string | null {
  if (text === null || Buffer.byteLength(text) <= AGENT_TEXT_BYTES) return text;
  return `${Buffer.from(text).subarray(0, AGENT_TEXT_BYTES).toString("utf8")}\n…[已截断，read 对应文件路径取全文]`;
}

function clipSide(side: SpecialText, base: string | null, head: string | null): SpecialText {
  return {
    ...side,
    base,
    head,
    truncated: side.truncated || base !== side.base || head !== side.head,
    hunks: side.hunks === null ? null : side.hunks.slice(0, 50),
  };
}

/** Web 需要完整文本，agent 读路径按 12 KB/侧截断，避免单条就爆掉读取预算。 */
export function clipSpecialContent(item: SpecialPairContent): SpecialPairContent {
  if (item.kind === "single") {
    return { ...item, file: clipSide(item.file, clippedText(item.file.base), clippedText(item.file.head)) };
  }
  return {
    ...item,
    en: clipSide(item.en, clippedText(item.en.base), clippedText(item.en.head)),
    zh: clipSide(item.zh, clippedText(item.zh.base), clippedText(item.zh.head)),
  };
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

async function contentFrom(
  entry: SpecialPlan,
  pull: GhPull,
  files: GhFile[],
  existing: ReadonlySet<string>,
  moved: ReadonlySet<string>,
  read: FileSource["read"],
): Promise<SpecialPairContent> {
  const textOf = async (side: PlannedSide): Promise<SpecialText> => {
    const file = side.file;
    let baseText: string | null;
    let headText: string | null;
    if (file === null) {
      if (existing.has(side.path)) {
        [baseText, headText] = await Promise.all([read(side.path, pull.baseSha), read(side.path, pull.headSha)]);
      } else {
        baseText = null;
        headText = null;
      }
    } else {
      const paths = sidePaths(file);
      [baseText, headText] = await Promise.all([read(paths.base, pull.baseSha), read(paths.head, pull.headSha)]);
    }
    const base = cap(baseText);
    const head = cap(headText);
    const prFile = files.find((file) => file.path === side.path);
    return {
      path: side.path,
      status: specialStatusOf(side, existing, moved),
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

export async function specialPairContent(n: number, key: string, source: FileSource): Promise<SpecialPairContent | null> {
  const { pull, files, plans, existing, moved } = await specialPlanFor(n);
  const entry = plans.find((plan) => plan.key === key);
  if (entry === undefined) return null;
  return contentFrom(entry, pull, files, existing, moved, source.read);
}

function sidePathsOf(entry: SpecialPlan, existing: ReadonlySet<string>): { base: string[]; head: string[] } {
  const base: string[] = [];
  const head: string[] = [];
  const sides = entry.kind === "single" ? [entry.file] : [entry.en, entry.zh];
  for (const side of sides) {
    if (side.file === null) {
      if (existing.has(side.path)) {
        base.push(side.path);
        head.push(side.path);
      }
      continue;
    }
    const paths = sidePaths(side.file);
    if (paths.base !== null) base.push(paths.base);
    if (paths.head !== null) head.push(paths.head);
  }
  return { base, head };
}

/** 一次读多对特殊文件：先批量取两侧文本，再在内存里组装，避免每对都往返 GitHub。 */
export async function specialContents(
  n: number,
  keys: readonly string[],
  source: FileSource,
): Promise<SpecialPairContent[]> {
  const { pull, files, plans, existing, moved } = await specialPlanFor(n);
  const wanted = new Set(keys);
  const entries = plans.filter((plan) => wanted.has(plan.key));
  if (entries.length === 0) return [];
  const basePaths = new Set<string>();
  const headPaths = new Set<string>();
  for (const entry of entries) {
    const paths = sidePathsOf(entry, existing);
    for (const path of paths.base) basePaths.add(path);
    for (const path of paths.head) headPaths.add(path);
  }
  const [baseTexts, headTexts] = await Promise.all([
    basePaths.size === 0 ? new Map<string, string>() : source.readMany([...basePaths], pull.baseSha),
    headPaths.size === 0 ? new Map<string, string>() : source.readMany([...headPaths], pull.headSha),
  ]);
  const read: FileSource["read"] = (path, ref) => {
    if (path === null) return Promise.resolve(null);
    return ref === pull.baseSha
      ? Promise.resolve(baseTexts.get(path) ?? null)
      : Promise.resolve(headTexts.get(path) ?? null);
  };
  return Promise.all(entries.map((entry) => contentFrom(entry, pull, files, existing, moved, read)));
}

