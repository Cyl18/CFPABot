export type RunnerFrame =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "result"; exitCode: number; durationMs: number; cancelled?: boolean }
  | { type: "error"; message: string };

export function parseFrame(line: string): RunnerFrame | null {
  const text = line.trim();
  if (text.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type === "stdout" || record.type === "stderr") {
    return typeof record.data === "string" ? { type: record.type, data: record.data } : null;
  }
  if (record.type === "result") {
    if (typeof record.exitCode !== "number" || typeof record.durationMs !== "number") return null;
    return {
      type: "result",
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      ...(record.cancelled === true ? { cancelled: true } : {}),
    };
  }
  if (record.type === "error") {
    return typeof record.message === "string" ? { type: "error", message: record.message } : null;
  }
  return null;
}
