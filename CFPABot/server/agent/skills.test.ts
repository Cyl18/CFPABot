import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent";
import { mqmIds } from "../domain/mqm.ts";
import { paths } from "../paths.ts";

const dir = join(paths.root, "skills");

describe("review skill", () => {
  test("加载 review 技能", async () => {
    const { skills } = await loadSkillsFromDir({ dir, source: "test" });
    const review = skills.find((skill) => skill.name === "review");
    expect(review).toBeDefined();
    expect(review?.description).toContain("审查");
  });

  test("包含全部 MQM 词表", async () => {
    const skill = await readFile(join(dir, "review", "SKILL.md"), "utf8");
    const json: unknown = JSON.parse(await readFile(join(paths.config, "mqm-types.json"), "utf8"));
    for (const id of mqmIds(json)) expect(skill).toContain(id);
  });
});
