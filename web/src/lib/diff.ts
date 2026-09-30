import { diffArrays, diffChars, diffLines, diffSentences, diffWordsWithSpace, type Change } from "diff";

export type DiffKind = "equal" | "insert" | "delete";

export type DiffMode = "auto" | "char" | "word" | "sentence" | "off";

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

const SENTENCE_TERMINATORS = "。！？!?…";
const SENTENCE_CLOSERS = "\"'”’）)】》」』…";
const SENTENCE_MARKERS = ["<br>", "$(p)"];

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    let end = -1;
    if (SENTENCE_TERMINATORS.includes(char)) end = index + 1;
    else if (char === "." && (next === undefined || /\s/.test(next))) end = index + 1;
    else if (char === "\n") end = index + 1;
    else {
      for (const marker of SENTENCE_MARKERS) {
        if (text.startsWith(marker, index)) {
          end = index + marker.length;
          break;
        }
      }
    }
    if (end === -1) continue;
    while (true) {
      const after = text[end];
      if (after === undefined) break;
      if (after === " " || after === "\t" || SENTENCE_CLOSERS.includes(after) || SENTENCE_TERMINATORS.includes(after)) {
        end += 1;
        continue;
      }
      break;
    }
    out.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

const REFINE_SHARED_RATIO = 0.5;
const AUTO_MIN_RUNS = 10;
const AUTO_CHARS_PER_RUN = 25;
const AUTO_MIN_SHARED_RATIO = 1 / 3;
const AUTO_SHORT_CHARS = 12;

function similarTokens(left: string, right: string): boolean {
  const min = Math.min(left.length, right.length);
  if (min < 3) return false;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
    suffix += 1;
  }
  return prefix + suffix >= Math.ceil(min * REFINE_SHARED_RATIO);
}

function fineDiff(before: string, after: string): DiffSegment[] {
  const changes = diffWordsWithSpace(before, after);
  const out: DiffSegment[] = [];
  let index = 0;
  while (index < changes.length) {
    const change = changes[index];
    if (change === undefined) break;
    if (!change.added && !change.removed) {
      out.push({ type: "equal", text: change.value });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (index < changes.length && (changes[index]?.added === true || changes[index]?.removed === true)) {
      (changes[index]?.added === true ? added : removed).push(changes[index]?.value ?? "");
      index += 1;
    }
    const refine = removed.length === added.length && removed.every((token, at) => similarTokens(token, added[at] ?? ""));
    if (refine) {
      for (let at = 0; at < removed.length; at += 1) out.push(...segmentsOf(diffChars(removed[at] ?? "", added[at] ?? "")));
    } else {
      for (const token of removed) out.push({ type: "delete", text: token });
      for (const token of added) out.push({ type: "insert", text: token });
    }
  }
  return compact(out);
}

function autoDiff(before: string, after: string): DiffSegment[] {
  const beforeParts = splitSentences(before);
  const afterParts = splitSentences(after);
  const changes = diffArrays(beforeParts, afterParts);
  const out: DiffSegment[] = [];
  let index = 0;
  while (index < changes.length) {
    const change = changes[index];
    if (change === undefined) break;
    if (!change.added && !change.removed) {
      out.push({ type: "equal", text: change.value.join("") });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (index < changes.length && (changes[index]?.added === true || changes[index]?.removed === true)) {
      for (const sentence of changes[index]?.value ?? []) {
        (changes[index]?.added === true ? added : removed).push(sentence);
      }
      index += 1;
    }
    const paired = Math.min(removed.length, added.length);
    for (let at = 0; at < paired; at += 1) {
      const sentenceBefore = removed[at] ?? "";
      const sentenceAfter = added[at] ?? "";
      const segments = fineDiff(sentenceBefore, sentenceAfter);
      const limit = Math.max(AUTO_MIN_RUNS, (sentenceBefore.length + sentenceAfter.length) / 2 / AUTO_CHARS_PER_RUN);
      const shared = segments
        .filter((segment) => segment.type === "equal")
        .map((segment) => segment.text)
        .join("")
        .replace(/\s/g, "").length;
      const base = Math.min(sentenceBefore.replace(/\s/g, "").length, sentenceAfter.replace(/\s/g, "").length);
      const worthSplitting = base < AUTO_SHORT_CHARS || shared / base >= AUTO_MIN_SHARED_RATIO;
      if (worthSplitting && changeRunCount(segments) <= limit) out.push(...segments);
      else out.push({ type: "delete", text: sentenceBefore }, { type: "insert", text: sentenceAfter });
    }
    for (let at = paired; at < removed.length; at += 1) out.push({ type: "delete", text: removed[at] ?? "" });
    for (let at = paired; at < added.length; at += 1) out.push({ type: "insert", text: added[at] ?? "" });
  }
  return compact(out);
}

export function inlineDiff(before: string, after: string, mode: DiffMode = "auto"): DiffSegment[] {
  if (mode === "off") {
    const text = after === "" ? before : after;
    return text === "" ? [] : [{ type: "equal", text }];
  }
  if (before === after) return before === "" ? [] : [{ type: "equal", text: after }];
  if (before === "") return [{ type: "insert", text: after }];
  if (after === "") return [{ type: "delete", text: before }];
  if (mode === "auto") return autoDiff(before, after);
  if (mode === "char") return compact(groupRuns(segmentsOf(diffChars(before, after))));
  if (mode === "word") return compact(groupRuns(segmentsOf(diffWordsWithSpace(before, after))));
  return compact(groupRuns(segmentsOf(diffSentences(before, after))));
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
