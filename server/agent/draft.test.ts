import { describe, expect, test } from "bun:test";
import type { ReviewDraft } from "../../shared/api.ts";
import { DRAFT_FILE, parseDraftFile, serializeDraftFile } from "./draft.ts";

const draft: ReviewDraft = {
  prNumber: 1,
  headSha: "abc",
  verdict: "approve",
  summary: "ok",
  comments: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("草稿文件", () => {
  test("约定文件名为 draft.json", () => {
    expect(DRAFT_FILE).toBe("draft.json");
  });

  test("序列化后可解析", () => {
    expect(parseDraftFile(serializeDraftFile(draft))).toEqual(draft);
  });

  test("缺 updatedAt 与 comment id 时补齐", () => {
    const parsed = parseDraftFile(
      JSON.stringify({
        prNumber: 1,
        headSha: "abc",
        verdict: "approve",
        summary: "ok",
        comments: [{ path: "a", line: 1, key: "k", severity: "minor", mqm: "Accuracy/mistranslation", body: "b" }],
      }),
    );
    expect(typeof parsed?.updatedAt).toBe("string");
    expect(parsed?.comments[0]?.id).toBe("c1");
  });

  test("坏 JSON 或缺关键字段返回 null", () => {
    expect(parseDraftFile("{")).toBeNull();
    expect(parseDraftFile(JSON.stringify({ ...draft, headSha: undefined }))).toBeNull();
    expect(parseDraftFile(undefined)).toBeNull();
  });
});
