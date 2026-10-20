import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSkillsFromDir, resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent";
import { paths } from "../../paths.ts";
import { readSkill } from "./skill-read.ts";

const dir = join(paths.root, "skills");

beforeAll(async () => {
  const { skills } = await loadSkillsFromDir({ dir, source: "test" });
  setActiveSkills(skills);
});

afterAll(() => resetActiveSkillsForTests());

describe("readSkill", () => {
  test("读取 SKILL.md", async () => {
    const result = await readSkill({ scheme: "skill", path: "review", query: new URLSearchParams() });
    const text = result.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
    const parsed = JSON.parse(text) as { path: string; lines: string[] };
    expect(parsed.path).toBe("skill://review");
    expect(parsed.lines.join("\n")).toContain("MQM 受控词表");
  });

  test("拒绝越界子路径", async () => {
    await expect(
      readSkill({ scheme: "skill", path: "review/../../secret", query: new URLSearchParams() }),
    ).rejects.toThrow("越界");
  });

  test("未知技能报错", async () => {
    await expect(
      readSkill({ scheme: "skill", path: "missing", query: new URLSearchParams() }),
    ).rejects.toThrow("技能不存在");
  });
});
