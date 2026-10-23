import type { PrFile } from "@cfpa/contracts/api";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { prdata } from "../prdata.ts";

const SIZE_LABELS: { name: string; min: number; max: number }[] = [
  { name: "1+", min: 0, max: 10 },
  { name: "10+", min: 10, max: 40 },
  { name: "40+", min: 40, max: 100 },
  { name: "100+", min: 100, max: 500 },
  { name: "500+", min: 500, max: 1000 },
  { name: "1000+", min: 1000, max: 2000 },
  { name: "2000+", min: 2000, max: 5000 },
  { name: "5000+", min: 5000, max: Number.MAX_SAFE_INTEGER },
];

const PATH_LABELS: { name: string; prefix: string }[] = [
  { name: "config", prefix: "config" },
  { name: "source", prefix: "src" },
];

export const DENIED_LABELS = ["NO-MERGE", "needs author action", "changes required", "ready to reject", "即将被搁置", "即将拒收"];
export const LABEL_CHECK_NAME = "标签检查器";

const log = logger("bot/labels");

export function sizeLabel(changes: number): string | null {
  for (const label of SIZE_LABELS) {
    if (label.min <= changes && changes < label.max) return label.name;
  }
  return null;
}

export function pathLabels(files: PrFile[]): string[] {
  const out: string[] = [];
  for (const label of PATH_LABELS) {
    if (files.some((file) => file.path.startsWith(label.prefix))) out.push(label.name);
  }
  return out;
}

export async function syncLabels(n: number): Promise<void> {
  const { pull, files } = await prdata.files(n);
  const current = pull.labels;
  const managed = [...SIZE_LABELS.map((l) => l.name), ...PATH_LABELS.map((l) => l.name)];
  const changes = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const size = sizeLabel(changes);
  const expected = [...(size ? [size] : []), ...pathLabels(files)];
  const toAdd = expected.filter((label) => !current.includes(label));
  const toRemove = current.filter((label) => managed.includes(label) && !expected.includes(label));
  if (toAdd.length > 0) await gh.addLabels(n, toAdd);
  for (const label of toRemove) await gh.removeLabel(n, label);
  if (toAdd.length > 0 || toRemove.length > 0) log.debug("标签已同步", { pr: n, added: toAdd, removed: toRemove });
}

export async function labelCheck(n: number): Promise<void> {
  const pull = await gh.getPull(n);
  const hit = pull.labels.filter((label) => DENIED_LABELS.includes(label));
  await gh.createCheckRun({
    name: LABEL_CHECK_NAME,
    headSha: pull.headSha,
    conclusion: hit.length > 0 ? "failure" : "success",
    title: hit.length > 0 ? `检测到不能被 Merge 的标签：${hit.join("")}。` : "标签检查通过。",
    summary: "",
  });
}

