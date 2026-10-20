function dimensionsOf(json: unknown): Record<string, unknown>[] {
  if (typeof json !== "object" || json === null) return [];
  const dimensions = (json as Record<string, unknown>).dimensions;
  if (!Array.isArray(dimensions)) return [];
  return dimensions.filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null);
}

function typesOf(dimension: Record<string, unknown>): Record<string, unknown>[] {
  const types = dimension.types;
  if (!Array.isArray(types)) return [];
  return types.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function mqmIds(json: unknown): Set<string> {
  const ids = new Set<string>();
  for (const dimension of dimensionsOf(json)) {
    const dimId = text(dimension.id);
    if (dimId === "") continue;
    for (const type of typesOf(dimension)) {
      const typeId = text(type.id);
      if (typeId !== "") ids.add(`${dimId}/${typeId}`);
    }
  }
  return ids;
}

export function mqmPrompt(json: unknown): string {
  const lines: string[] = [];
  for (const dimension of dimensionsOf(json)) {
    const dimId = text(dimension.id);
    const dimZh = text(dimension.zh);
    const parts: string[] = [];
    for (const type of typesOf(dimension)) {
      const typeId = text(type.id);
      if (typeId === "") continue;
      const zh = text(type.zh);
      const severity = text(type.defaultSeverity);
      parts.push(`${dimId}/${typeId}${zh ? `（${zh}）` : ""}${severity ? `[${severity}]` : ""}`);
    }
    if (parts.length === 0) continue;
    lines.push(`${dimId}${dimZh ? ` ${dimZh}` : ""}: ${parts.join("、")}`);
  }
  return lines.join("\n");
}
