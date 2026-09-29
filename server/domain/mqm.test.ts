import { expect, test } from "bun:test";
import { join } from "node:path";
import { readJson } from "../store.ts";
import { mqmIds, mqmPrompt } from "./mqm.ts";

const configPath = join(import.meta.dir, "../../config/mqm-types.json");

test("mqmIds returns full Dim/type ids", async () => {
  const json = await readJson(configPath);
  const ids = mqmIds(json);
  expect(ids.has("Terminology/wrong-term")).toBe(true);
  expect(ids.has("Accuracy/mistranslation")).toBe(true);
  expect(ids.has("Locale/format-code")).toBe(true);
  expect(ids.size).toBe(20);
});

test("mqmIds is empty for junk input", () => {
  expect(mqmIds(null).size).toBe(0);
  expect(mqmIds({ dimensions: [{ id: "A", types: [{ id: "b" }, {}] }] }).has("A/b")).toBe(true);
  expect(mqmIds("nope").size).toBe(0);
});

test("mqmPrompt lists ids per dimension", async () => {
  const json = await readJson(configPath);
  const prompt = mqmPrompt(json);
  const lines = prompt.split("\n");
  expect(lines.length).toBe(5);
  expect(lines[0]).toContain("Terminology/wrong-term");
  expect(lines[0]?.startsWith("Terminology 术语: ")).toBe(true);
});
