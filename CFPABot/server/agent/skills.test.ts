import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("检查器拒绝词表外的 mqm", async () => {
    const work = await mkdtemp(join(tmpdir(), "cfpa-check-"));
    const file = join(work, "draft.json");
    await writeFile(
      file,
      JSON.stringify({
        prNumber: 1,
        headSha: "abc",
        verdict: "changes",
        summary: "s",
        comments: [{ path: "a.lang", line: 2, key: "k", severity: "minor", mqm: "Foo/bar", body: "b", suggestion: "x" }],
      }),
    );
    const proc = Bun.spawn(["bun", join(dir, "review", "scripts", "check-draft.mjs"), file], { stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("不在 SKILL.md 词表中");
  });
});
