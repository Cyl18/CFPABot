import { expect, test } from "bun:test";
import { assembleComment, collapseBlankRuns, urlEncodeDotNet } from "./render.ts";
import { commentVersionDir, standardVersionOf } from "../domain/path.ts";

const PIC_BYTES = `  <br/>
  <div align="center">
  <a href="https://github.com/Cyl18/CFPABot">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Cyl18/CFPABot/refs/heads/dev/docs/2.svg?">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Cyl18/CFPABot/refs/heads/dev/docs/1.svg?">
      <img src="https://raw.githubusercontent.com/Cyl18/CFPABot/refs/heads/dev/docs/1.svg?" width="600">
    </picture>
  </a>
  </div>
  
  ---
`;

test("final layout matches ref junction bytes", () => {
  const text = assembleComment({ mods: "M", packer: "P", checks: "C", diffs: "D" }, "final", "https://x");
  expect(text).toBe(
    `<!--CYBOT-->\n${PIC_BYTES}\nM\n---\nP\n---\nC\n---\nD\n---\n` +
      `🐖 [命令列表](https://x/commands) | [问题反馈](https://github.com/Cyl18/CFPABot/issues/new)\n` +
      `- [ ] 🔄 勾选这个复选框来强制刷新\n`,
  );
});

test("final keeps empty check section as bare separator", () => {
  const text = assembleComment({ mods: "M", packer: "", checks: "", diffs: "D" }, "final", "https://x");
  expect(text).toContain("\nM\n---\n\n---\n\n---\nD\n---\n");
});

test("preview drops empty checks and always shows updating", () => {
  const text = assembleComment({ mods: "M", packer: "", checks: "", diffs: "D" }, "preview", "https://x");
  expect(text.endsWith("---\n**:construction: 正在更新内容...**\n")).toBe(true);
  expect(text).toContain("\nM\n---\n\n---\nD\n---\n");
  const withChecks = assembleComment({ mods: "M", packer: "", checks: "C", diffs: "D" }, "preview", "https://x");
  expect(withChecks).toContain("\n---\nC\n---\nD\n---\n");
});

test("collapseBlankRuns keeps single blanks, trims runs, spares fences", () => {
  expect(collapseBlankRuns("a\n\n\n\nb\n")).toBe("a\n\nb\n");
  expect(collapseBlankRuns("a\n\nb")).toBe("a\n\nb");
  expect(collapseBlankRuns("```\na\n\n\nb\n```\n\n\nc")).toBe("```\na\n\n\nb\n```\n\nc");
});

test("urlEncodeDotNet follows HttpUtility.UrlEncode", () => {
  expect(urlEncodeDotNet("Xaero's World Map")).toBe("Xaero%27s+World+Map");
  expect(urlEncodeDotNet("Productive Bees")).toBe("Productive+Bees");
  expect(urlEncodeDotNet("Ice and Fire: Dragons")).toBe("Ice+and+Fire%3a+Dragons");
  expect(urlEncodeDotNet("a-b_c.d!e*f(g)h~i")).toBe("a-b_c.d!e*f(g)h%7ei");
});

test("commentVersionDir accepts only grandma version directories", () => {
  expect(commentVersionDir("1.12.2")?.label).toBe("1.12");
  expect(commentVersionDir("1.16-fabric")?.label).toBe("1.16-fabric");
  expect(commentVersionDir("26.1-fabric")?.label).toBe("26.1-fabric");
  expect(commentVersionDir("1.19-fabric")).toBeNull();
  expect(commentVersionDir("1.12")).toBeNull();
  expect(commentVersionDir("1.17")).toBeNull();
  expect(commentVersionDir("1.19.2")).toBeNull();
  expect(standardVersionOf("1.12.2")).toBe("1.12.2");
  expect(standardVersionOf("1.16-fabric")).toBe("1.16");
});
