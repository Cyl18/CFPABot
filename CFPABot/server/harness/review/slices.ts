/** 单片行数上限：再多就该换一片，子代理一次读不完。 */
export const SLICE_MAX_ROWS = 300;

export interface SliceEntry {
  /** 同一个 run 的条目才可能进同一片；片不跨 run。 */
  run: string;
  bytes: number;
}

export interface SliceBounds {
  start: number;
  end: number;
  bytes: number;
}

/** 把条目切成连续的片：不跨 run、不超预算、不超行数；超预算的单条独占一片。 */
export function sliceRuns(entries: readonly SliceEntry[], budget: number, maxRows = SLICE_MAX_ROWS): SliceBounds[] {
  const bounds: SliceBounds[] = [];
  let start = 0;
  while (start < entries.length) {
    const run = entries[start]!.run;
    let end = start + 1;
    while (end < entries.length && entries[end]!.run === run) end += 1;
    bounds.push(...fill(entries, start, end, budget, maxRows));
    start = end;
  }
  return bounds;
}

function fill(
  entries: readonly SliceEntry[],
  from: number,
  to: number,
  budget: number,
  maxRows: number,
): SliceBounds[] {
  const cap = Math.max(1, budget);
  const rowCap = Math.max(1, maxRows);
  const bounds: SliceBounds[] = [];
  let start = from;
  let bytes = 0;
  for (let index = from; index < to; index += 1) {
    const size = entries[index]!.bytes;
    if (index > start && (bytes + size > cap || index - start >= rowCap)) {
      bounds.push({ start, end: index, bytes });
      start = index;
      bytes = 0;
    }
    bytes += size;
  }
  bounds.push({ start, end: to, bytes });
  return balanceTail(bounds, entries, cap, rowCap);
}

/** 尾片不足半片时与前片均分，免得为只判几行的子代理派一次单。 */
function balanceTail(
  bounds: SliceBounds[],
  entries: readonly SliceEntry[],
  cap: number,
  rowCap: number,
): SliceBounds[] {
  const prev = bounds[bounds.length - 2];
  const last = bounds[bounds.length - 1];
  if (prev === undefined || last === undefined || last.bytes * 2 >= cap) return bounds;
  const total = prev.bytes + last.bytes;
  const target = Math.min(total / 2, cap);
  let cut = prev.start;
  let bytes = 0;
  // 单条就直接超半片时不动，宁可留一条小尾片也不把片撑爆。
  while (cut < last.end - 1 && bytes + entries[cut]!.bytes <= target && cut - prev.start < rowCap - 1) {
    bytes += entries[cut]!.bytes;
    cut += 1;
  }
  if (cut === prev.start) return bounds;
  prev.end = cut;
  prev.bytes = bytes;
  last.start = cut;
  last.bytes = total - bytes;
  return bounds;
}
