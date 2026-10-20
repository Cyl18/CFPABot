export function linesResult(
  path: string,
  ref: string,
  text: string,
  selector?: { from: number; to?: number },
): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const start = Math.min(Math.max(selector?.from ?? 1, 1), total);
  const requestedEnd = selector?.to ?? Math.min(total, start + 1999);
  const end = Math.min(Math.max(requestedEnd, start), total);
  const result: Record<string, unknown> = {
    path,
    ref,
    totalLines: total,
    from: start,
    to: end,
    lines: lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`),
  };
  if (selector?.to === undefined && end < total) result.truncated = true;
  return result;
}

export function missingResource(resource: string, children: readonly string[]): never {
  throw new Error(`未知资源 ${resource}。可用子资源：${children.join("、")}。`);
}
