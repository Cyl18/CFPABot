const DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return DATE_TIME.format(date);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "-";
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return iso.slice(0, 10);
}

export function formatJson(value: unknown): string {
  if (value === undefined) return "(无)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatDelta(value: number, sign: "+" | "-"): string {
  return value === 0 ? "0" : `${sign}${value}`;
}

export function expandNewlines(value: string): string {
  return value.replaceAll("\\n", "\\n\n");
}
