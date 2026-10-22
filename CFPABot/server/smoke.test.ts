import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
});
