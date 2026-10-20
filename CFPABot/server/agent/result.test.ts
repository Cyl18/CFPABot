import { describe, expect, test } from "bun:test";
import { pageOf } from "./result.ts";

describe("pageOf", () => {
  test("正常夹紧", () => {
    expect(pageOf(10, 20, 200, 60)).toEqual({ offset: 10, limit: 20 });
    expect(pageOf(undefined, undefined, 200, 60)).toEqual({ offset: 0, limit: 60 });
    expect(pageOf(-5, 0, 200, 60)).toEqual({ offset: 0, limit: 1 });
    expect(pageOf(0, 999, 200, 60)).toEqual({ offset: 0, limit: 200 });
  });

  test("NaN 回落而不是产生空页", () => {
    expect(pageOf(Number.NaN, Number.NaN, 200, 60)).toEqual({ offset: 0, limit: 60 });
    expect(pageOf(Number.POSITIVE_INFINITY, 10, 200, 60)).toEqual({ offset: 0, limit: 10 });
  });
});
