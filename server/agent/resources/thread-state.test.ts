import { describe, expect, test } from "bun:test";
import { parseThreadState } from "./thread-state.ts";

describe("线程状态 body", () => {
  test("接受 true 与 false", () => {
    expect(parseThreadState('{"resolved":true}')).toBe(true);
    expect(parseThreadState('{"resolved":false}')).toBe(false);
  });

  test("缺 body、坏 JSON、错误形状都拒绝", () => {
    expect(() => parseThreadState(undefined)).toThrow("JSON body");
    expect(() => parseThreadState("  ")).toThrow("JSON body");
    expect(() => parseThreadState("{")).toThrow("JSON body");
    expect(() => parseThreadState('{"resolved":"yes"}')).toThrow("resolved");
    expect(() => parseThreadState("{}")).toThrow("resolved");
  });
});
