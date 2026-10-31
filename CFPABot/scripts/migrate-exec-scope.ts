import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../server/paths.ts";
import { readJson, writeJson } from "../server/store.ts";

// 会话 meta 的执行开关曾经写 run，统一成 on（写权限本来就是 on/off）；workflow 字段已随工作流抽象删除。
const FROM = "run";
const TO = "on";
const KEYS = ["evalScope", "bashScope"] as const;

type Meta = Record<string, unknown> & { meta?: Record<string, unknown> };
const entries = await readdir(paths.sessions, { withFileTypes: true }).catch(() => []);
let changed = 0;

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  const file = join(paths.sessions, entry.name);
  const raw = await readJson<Meta>(file);
  const meta = raw?.meta;
  if (raw === null || meta === undefined) continue;
  let touched = "workflow" in meta;
  delete meta.workflow;
  for (const key of KEYS) {
    if (meta[key] !== FROM) continue;
    meta[key] = TO;
    touched = true;
  }
  if (!touched) continue;
  await writeJson(file, raw);
  changed += 1;
}

console.log(`[migrate] ${paths.sessions}：改写 ${changed} 条会话记录（${FROM} → ${TO}，删除 workflow）`);
