import { charDiff } from "@/lib/diff.ts";

function charDistance(a: string, b: string): number {
  let distance = 0;
  for (const segment of charDiff(a, b)) {
    if (segment.type !== "equal") distance += Array.from(segment.text).length;
  }
  return distance;
}

// 到其他版本总距离最小的那个版本；并列取靠前的。
function centerOf(texts: readonly string[]): string {
  let best = texts[0] ?? "";
  let bestScore = Infinity;
  for (const text of texts) {
    let score = 0;
    for (const other of texts) score += charDistance(text, other);
    if (score < bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best;
}

// 与中心逐字对齐：slots = 中心每一列上这版是什么（null = 缺），inserts = 中心列与列之间插进去的字。
function alignToCenter(center: string, text: string): { slots: (string | null)[]; inserts: string[][] } {
  const slots = new Array<string | null>(Array.from(center).length).fill(null);
  const inserts: string[][] = Array.from({ length: slots.length + 1 }, () => []);
  let at = 0;
  for (const segment of charDiff(center, text)) {
    const chars = Array.from(segment.text);
    if (segment.type === "equal") {
      for (const char of chars) {
        slots[at] = char;
        at += 1;
      }
    } else if (segment.type === "delete") {
      at += chars.length;
    } else {
      inserts[at]?.push(...chars);
    }
  }
  return { slots, inserts };
}

// 逐列投票：某个字比空位多才进共识，空位不输就删掉这列；平票取中心版本的字。
function voteColumn(tokens: readonly (string | null)[], centerIndex: number): string | null {
  const counts = new Map<string | null, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const top = [...counts.entries()]
    .filter(([token]) => token !== null)
    .sort((a, b) => b[1] - a[1])[0];
  if (top === undefined || top[1] <= (counts.get(null) ?? 0)) return null;
  const tied = [...counts.entries()].filter(([token, count]) => token !== null && count === top[1]);
  if (tied.length === 1) return tied[0]?.[0] ?? null;
  const centerToken = tokens[centerIndex] ?? null;
  if (tied.some(([token]) => token === centerToken)) return centerToken;
  return tied.map(([token]) => token).sort((a, b) => tokens.indexOf(a) - tokens.indexOf(b))[0] ?? null;
}

/** 列投票共识：先挑一个到其他版本总距离最小的「中心版本」，各版本与它逐字对齐成列，再逐列投票。
 *  拼出来的共识可能谁都没写过，也可能正好等于某个版本。没有文本时返回 null。 */
export function consensusOf(texts: readonly string[]): string | null {
  if (texts.length === 0) return null;
  const center = centerOf(texts);
  const centerIndex = texts.indexOf(center);
  const centerChars = Array.from(center);
  const rows = texts.map((text) => alignToCenter(center, text));
  const picked: (string | null)[] = [];
  for (let gap = 0; gap <= centerChars.length; gap += 1) {
    const inserts = rows.map((row) => row.inserts[gap] ?? []);
    const width = Math.max(0, ...inserts.map((chars) => chars.length));
    for (let k = 0; k < width; k += 1) picked.push(voteColumn(inserts.map((chars) => chars[k] ?? null), centerIndex));
    if (gap < centerChars.length) picked.push(voteColumn(rows.map((row) => row.slots[gap] ?? null), centerIndex));
  }
  return picked.filter((token): token is string => token !== null).join("");
}
