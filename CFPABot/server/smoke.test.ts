import { describe, expect, test } from "bun:test";
import { app } from "./http/app.ts";

describe("冒烟", () => {
  test("AddMapping 未授权不会写入", async () => {
    const response = await app.fetch(new Request("http://localhost/api/Utils/AddMapping/1"));
    expect([401, 503]).toContain(response.status);
  });
});
