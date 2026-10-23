import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MQM_DIMENSIONS, MQM_TYPES } from "@cfpa/contracts/mqm";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent";
import { resolveWorkflow } from "./agent/workflows/index.ts";
import { app } from "./http/app.ts";
import { paths } from "./paths.ts";

describe("冒烟", () => {
  test("健康检查可响应", async () => {
    const response = await app.fetch(new Request("http://localhost/healthz"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  test("工作流挂载 review 技能", async () => {
    expect(resolveWorkflow(undefined).skills).toContain("review");
    const { skills } = await loadSkillsFromDir({ dir: join(paths.root, "skills"), source: "smoke" });
    expect(skills.some((skill) => skill.name === "review")).toBe(true);
  });

  test("SKILL.md 列全 MQM 词表", async () => {
    const skill = await readFile(join(paths.root, "skills/review/SKILL.md"), "utf8");
    const rows = new Map(
      skill
        .split("\n")
        .filter((line) => line.startsWith("- `"))
        .map((line) => [line.slice(3, line.indexOf("`", 3)), line]),
    );
    for (const dim of MQM_DIMENSIONS) expect(rows.has(dim.id), `缺少维度 ${dim.id}`).toBe(true);
    for (const type of MQM_TYPES) {
      const row = rows.get(type.dim);
      expect(row, `缺少维度 ${type.dim} 的说明行`).toBeDefined();
      expect(row?.includes(`\`${type.id.slice(type.dim.length + 1)}\``), `缺少 ${type.id}`).toBe(true);
    }
  });
});
