import { diffChars, diffLines, diffSentences, diffWordsWithSpace, type Change } from "diff";

export type DiffKind = "equal" | "insert" | "delete";

export interface DiffSegment {
  type: DiffKind;
  text: string;
  block?: boolean;
}

function kindOf(change: Change): DiffKind {
  if (change.added) return "insert";
  if (change.removed) return "delete";
  return "equal";
}

function groupRuns(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index];
    if (!segment) break;
    if (segment.type === "equal") {
      out.push(segment);
      index += 1;
      continue;
    }
    const removed: DiffSegment[] = [];
    const added: DiffSegment[] = [];
    while (index < segments.length && segments[index]?.type !== "equal") {
      const current = segments[index];
      if (!current) break;
      (current.type === "delete" ? removed : added).push(current);
      index += 1;
    }
    out.push(...removed, ...added);
  }
  return out;
}

function changeRunCount(segments: DiffSegment[]): number {
  let runs = 0;
  let inside = false;
  for (const segment of segments) {
    if (segment.type === "equal") {
      inside = false;
      continue;
    }
    if (!inside && /\S/.test(segment.text)) {
      runs += 1;
      inside = true;
    }
  }
  return runs;
}

function compact(segments: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.type === segment.type) previous.text += segment.text;
    else merged.push({ type: segment.type, text: segment.text });
  }
  return merged.map((segment) => (segment.type === "equal" ? segment : { ...segment, block: /\S/.test(segment.text) }));
}

function segmentsOf(changes: Change[] | undefined): DiffSegment[] {
  return (changes ?? []).map((change) => ({ type: kindOf(change), text: change.value }));
}

export function inlineDiff(before: string, after: string): DiffSegment[] {
  if (before === after) return before === "" ? [] : [{ type: "equal", text: after }];
  if (before === "") return [{ type: "insert", text: after }];
  if (after === "") return [{ type: "delete", text: before }];

  const combined = before.length + after.length;
  const cjk = (before + after).match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
  const fine = (combined < 50 && !/\s/.test(before + after)) || (combined < 80 && cjk / combined > 0.5);

  let segments = groupRuns(segmentsOf(fine ? diffChars(before, after) : diffWordsWithSpace(before, after)));
  if (changeRunCount(segments) > 1) segments = groupRuns(segmentsOf(diffSentences(before, after)));
  return compact(segments);
}

export interface LineDiffRow {
  type: DiffKind;
  text: string;
  leftLine?: number;
  rightLine?: number;
}

export function lineDiff(left: string, right: string): LineDiffRow[] {
  const rows: LineDiffRow[] = [];
  let leftLine = 1;
  let rightLine = 1;
  for (const change of diffLines(left, right)) {
    const lines = change.value.replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (change.added) rows.push({ type: "insert", text, rightLine: rightLine++ });
      else if (change.removed) rows.push({ type: "delete", text, leftLine: leftLine++ });
      else rows.push({ type: "equal", text, leftLine: leftLine++, rightLine: rightLine++ });
    }
  }
  return rows;
}

export interface SideBySideRow {
  left?: LineDiffRow;
  right?: LineDiffRow;
}

export function toSideBySide(rows: readonly LineDiffRow[]): SideBySideRow[] {
  const paired: SideBySideRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row) break;
    if (row.type === "equal") {
      paired.push({ left: row, right: row });
      index += 1;
      continue;
    }
    const removed: LineDiffRow[] = [];
    const added: LineDiffRow[] = [];
    while (index < rows.length && rows[index]?.type !== "equal") {
      const current = rows[index];
      if (!current) break;
      (current.type === "delete" ? removed : added).push(current);
      index += 1;
    }
    const size = Math.max(removed.length, added.length);
    for (let offset = 0; offset < size; offset += 1) {
      const left = removed[offset];
      const right = added[offset];
      paired.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
  }
  return paired;
}
