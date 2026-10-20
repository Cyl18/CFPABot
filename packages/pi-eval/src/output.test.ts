import { describe, expect, test } from "bun:test";
import { OutputSink } from "./output.ts";

describe("OutputSink", () => {
  test("小输出原样保留", () => {
    const sink = new OutputSink(100);
    sink.push("hello ");
    sink.push("world");
    expect(sink.dump()).toEqual({ text: "hello world", truncated: false, totalBytes: 11 });
  });

  test("大输出保留头尾并标记省略", () => {
    const sink = new OutputSink(100);
    sink.push("A".repeat(60));
    sink.push("B".repeat(60));
    const dump = sink.dump();
    expect(dump.truncated).toBe(true);
    expect(dump.totalBytes).toBe(120);
    expect(sink.totalBytes).toBe(120);
    expect(dump.text.startsWith("A")).toBe(true);
    expect(dump.text.endsWith("B")).toBe(true);
    expect(dump.text).toContain("字符已省略");
  });
});
