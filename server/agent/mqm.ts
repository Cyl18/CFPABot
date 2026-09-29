import { join } from "node:path";
import { paths } from "../paths.ts";
import { readJson } from "../store.ts";
import { mqmIds, mqmPrompt } from "../domain/mqm.ts";

export interface MqmLabel {
  dimZh: string;
  typeZh: string;
}

export interface MqmTable {
  ids: Set<string>;
  prompt: string;
  labels: Map<string, MqmLabel>;
}

const MQM_PATH = join(paths.config, "mqm-types.json");

let pending: Promise<MqmTable> | null = null;

function labelsOf(json: unknown): Map<string, MqmLabel> {
  const labels = new Map<string, MqmLabel>();
  if (!json || typeof json !== "object" || !("dimensions" in json)) return labels;
  const dimensions = json.dimensions;
  if (!Array.isArray(dimensions)) return labels;
  for (const dimension of dimensions) {
    if (!dimension || typeof dimension !== "object") continue;
    const dimId = "id" in dimension && typeof dimension.id === "string" ? dimension.id : undefined;
    const dimZh = "zh" in dimension && typeof dimension.zh === "string" ? dimension.zh : dimId;
    const types = "types" in dimension ? dimension.types : undefined;
    if (!dimId || !dimZh || !Array.isArray(types)) continue;
    for (const type of types) {
      if (!type || typeof type !== "object") continue;
      const typeId = "id" in type && typeof type.id === "string" ? type.id : undefined;
      if (!typeId) continue;
      const typeZh = "zh" in type && typeof type.zh === "string" ? type.zh : typeId;
      labels.set(`${dimId}/${typeId}`, { dimZh, typeZh });
    }
  }
  return labels;
}

export function mqmTable(): Promise<MqmTable> {
  pending ??= (async () => {
    const json = await readJson<unknown>(MQM_PATH);
    if (!json) return { ids: new Set<string>(), prompt: "", labels: new Map<string, MqmLabel>() };
    return { ids: mqmIds(json), prompt: mqmPrompt(json), labels: labelsOf(json) };
  })();
  return pending;
}
