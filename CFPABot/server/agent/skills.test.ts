import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent";
import { paths } from "../paths.ts";

const dir = join(paths.root, "skills");

describe("review skill", () => {
  test("加载 review 技能", async () => {
    const { skills } = await loadSkillsFromDir({ dir, source: "test" });
    const review = skills.find((skill) => skill.name === "review");
    expect(review).toBeDefined();
    expect(review?.description).toContain("审查");
  });
});
