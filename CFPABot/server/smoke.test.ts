import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MQM_DIMENSIONS, MQM_TYPES } from "@cfpa/contracts/mqm";
import { entryFindingsWithTerms } from "@cfpa/review-core/domain/entry-findings";
import { loadWorkspaceTexts } from "@cfpa/review-core/domain/workspace-files";
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

  test("工作流挂载译前译后技能", async () => {
    expect(resolveWorkflow(undefined).skills).toEqual(expect.arrayContaining(["prep", "post"]));
    const { skills } = await loadSkillsFromDir({ dir: join(paths.root, "skills"), source: "smoke" });
    for (const name of ["prep", "post", "translate"]) {
      expect(skills.some((skill) => skill.name === name), `缺少技能 ${name}`).toBe(true);
    }
  });

  test("SKILL.md 列全 MQM 词表", async () => {
    const skill = await readFile(join(paths.root, "skills/post/SKILL.md"), "utf8");
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

  test("工作区加载器优先 canonical locale 文件", async () => {
    const workspace = {
      slug: "demo",
      version: "1.20.1",
      namespace: "demo",
      files: [
        "projects/assets/demo/1.20.1/demo/lang/zh_cn.json",
        "projects/assets/demo/1.20.1/demo/lang/zh_CN.json",
        "projects/assets/demo/1.20.1/demo/lang/en_us.json",
      ],
    };
    const files = workspace.files.map((path) => ({ path, status: "modified" }));
    const loaded = await loadWorkspaceTexts(workspace, files, async (path) => {
      if (path.endsWith("zh_cn.json")) return JSON.stringify({ a: "canonical" });
      if (path.endsWith("zh_CN.json")) return JSON.stringify({ a: "upper" });
      if (path.endsWith("en_us.json")) return JSON.stringify({ a: "A" });
      return null;
    });
    expect(loaded?.zhPath).toBe("projects/assets/demo/1.20.1/demo/lang/zh_cn.json");
    expect(loaded?.headZh?.entries.get("a")).toBe("canonical");
  });

  test("未变条目不产生 entry finding", () => {
    const unchanged = entryFindingsWithTerms(
      "a",
      { baseEn: "A", headEn: "A", baseZh: "B", headZh: "B" },
      "1.20.1",
      null,
    );
    const changed = entryFindingsWithTerms(
      "a",
      { baseEn: "A", headEn: "C", baseZh: "B", headZh: "B" },
      "1.20.1",
      null,
    );
    expect(unchanged).toEqual([]);
    expect(changed.map((finding) => finding.code)).toContain("stale_translation");
  });

  test("AddMapping 未授权不会写入", async () => {
    const response = await app.fetch(new Request("http://localhost/api/Utils/AddMapping/1"));
    expect([401, 503]).toContain(response.status);
  });
});
