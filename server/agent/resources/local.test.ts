import { describe, expect, test } from "bun:test";
import type { LocalEntry, ToolContext } from "../context.ts";
import { editResource, readResource, writeResource } from "./index.ts";

function textOf(result: { content: { type: string; text?: string }[] }): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text" || block.text === undefined) throw new Error("no text result");
  return block.text;
}

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const files = new Map<string, LocalEntry>();
  return {
    sessionId: "test",
    prNumber: null,
    baseSha: null,
    headSha: null,
    writeScope: "off",
    evalScope: "off",
    local: async (name) => files.get(name) ?? null,
    saveLocal: async (name, content) => {
      const entry = { content, updatedAt: "2026-01-01T00:00:00.000Z" };
      files.set(name, entry);
      return entry;
    },
    listLocal: async () =>
      [...files.entries()].map(([name, entry]) => ({
        name,
        size: Buffer.byteLength(entry.content, "utf8"),
        updatedAt: entry.updatedAt,
      })),
    packFor: async () => null,
    savePackFor: async () => {},
    ...overrides,
  };
}

describe("local:// 短名文件", () => {
  test("writeScope=off 也能读写本地文本", async () => {
    const ctx = baseCtx();
    const written = JSON.parse(textOf(await writeResource("local://notes.txt", "hello\nworld", ctx, "t1"))) as {
      ok: boolean;
    };
    expect(written.ok).toBe(true);
    const readBack = JSON.parse(textOf(await readResource("local://notes.txt:2-3", ctx))) as { lines: string[] };
    expect(readBack.lines).toEqual(["2\tworld"]);
  });

  test("根路径按名称列出本地文件", async () => {
    const ctx = baseCtx();
    await writeResource("local://zeta.md", "z", ctx, "t1");
    await writeResource("local://alpha.txt", "a", ctx, "t2");
    const listing = JSON.parse(textOf(await readResource("local://", ctx))) as { files: { name: string }[] };
    expect(listing.files.map((file) => file.name)).toEqual(["alpha.txt", "zeta.md"]);
  });

  test("draft.json 只是普通文件，不做 JSON 校验", async () => {
    const ctx = baseCtx();
    await writeResource("local://draft.json", "{not json", ctx, "t1");
    const readBack = JSON.parse(textOf(await readResource("local://draft.json", ctx))) as { lines: string[] };
    expect(readBack.lines).toEqual(["1\t{not json"]);
  });

  test("edit 替换本地文本，不需要 writeScope", async () => {
    const ctx = baseCtx();
    await writeResource("local://notes.txt", "hello world", ctx, "t1");
    const edited = JSON.parse(textOf(await editResource("local://notes.txt", "world", "酒狐", false, ctx, "t2"))) as {
      ok: boolean;
    };
    expect(edited.ok).toBe(true);
    const readBack = JSON.parse(textOf(await readResource("local://notes.txt", ctx))) as { lines: string[] };
    expect(readBack.lines).toEqual(["1\thello 酒狐"]);
  });

  test("edit 未找到与重复出现分别报错，replace_all 可全部替换", async () => {
    const ctx = baseCtx();
    await writeResource("local://notes.txt", "a b a", ctx, "t1");
    await expect(editResource("local://notes.txt", "zzz", "c", false, ctx, "t2")).rejects.toThrow("未找到");
    await expect(editResource("local://notes.txt", "a", "c", false, ctx, "t3")).rejects.toThrow("出现多次");
    await editResource("local://notes.txt", "a", "c", true, ctx, "t4");
    const readBack = JSON.parse(textOf(await readResource("local://notes.txt", ctx))) as { lines: string[] };
    expect(readBack.lines).toEqual(["1\tc b c"]);
  });

  test("edit 不存在的本地文件报错", async () => {
    await expect(editResource("local://missing.txt", "a", "b", false, baseCtx(), "t1")).rejects.toThrow(
      "本地文件不存在",
    );
  });

  test("拒绝带斜杠或越界的短名", async () => {
    const ctx = baseCtx();
    await expect(writeResource("local://a/b", "x", ctx, "t1")).rejects.toThrow("文件名无效");
    await expect(readResource("local://a/b", ctx)).rejects.toThrow("文件名无效");
  });

  test("读取不存在的本地文件报错", async () => {
    await expect(readResource("local://missing.txt", baseCtx())).rejects.toThrow("本地文件不存在");
  });

  test("不同会话的 local 互不可见", async () => {
    const first = baseCtx();
    const second = baseCtx();
    await writeResource("local://notes.txt", "first", first, "t1");
    await expect(readResource("local://notes.txt", second)).rejects.toThrow("本地文件不存在");
  });
});
