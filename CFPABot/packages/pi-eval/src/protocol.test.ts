import { describe, expect, test } from "bun:test";
import { parseFrame } from "./protocol.ts";

describe("runner 帧协议", () => {
  test("解析 stdout 与 stderr", () => {
    expect(parseFrame('{"type":"stdout","data":"hi"}')).toEqual({ type: "stdout", data: "hi" });
    expect(parseFrame('{"type":"stderr","data":"bad"}')).toEqual({ type: "stderr", data: "bad" });
  });

  test("解析结果帧与取消标记", () => {
    expect(parseFrame('{"type":"result","exitCode":0,"durationMs":12}')).toEqual({
      type: "result",
      exitCode: 0,
      durationMs: 12,
    });
    expect(parseFrame('{"type":"result","exitCode":137,"durationMs":9,"cancelled":true}')).toEqual({
      type: "result",
      exitCode: 137,
      durationMs: 9,
      cancelled: true,
    });
  });

  test("解析错误帧", () => {
    expect(parseFrame('{"type":"error","message":"boom"}')).toEqual({ type: "error", message: "boom" });
  });

  test("坏行与字段类型错误返回 null", () => {
    expect(parseFrame("")).toBeNull();
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame('{"type":"stdout","data":1}')).toBeNull();
    expect(parseFrame('{"type":"result","exitCode":"0","durationMs":1}')).toBeNull();
    expect(parseFrame('{"type":"unknown"}')).toBeNull();
  });
});
