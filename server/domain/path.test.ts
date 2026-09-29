import { expect, test } from "bun:test";
import {
  buildLangPath,
  compareMc,
  langFormatFor,
  mcMatches,
  modRefOf,
  parseLangPath,
  parseVersionDir,
  workspacesOf,
} from "./path.ts";

test("parseLangPath modern layout", () => {
  expect(parseLangPath("projects/assets/twilightforest/1.21.1/twilightforest/lang/zh_cn.json")).toEqual({
    path: "projects/assets/twilightforest/1.21.1/twilightforest/lang/zh_cn.json",
    slug: "twilightforest",
    version: "1.21.1",
    namespace: "twilightforest",
    fileName: "zh_cn.json",
    locale: "zh_cn",
    format: "json",
    legacy: false,
  });
});

test("parseLangPath legacy layout", () => {
  const parsed = parseLangPath("projects/1.12.2/assets/actuallyadditions/actuallyadditions/lang/zh_CN.lang");
  expect(parsed?.legacy).toBe(true);
  expect(parsed?.version).toBe("1.12.2");
  expect(parsed?.slug).toBe("actuallyadditions");
  expect(parsed?.locale).toBe("zh_cn");
  expect(parsed?.format).toBe("lang");
});

test("parseLangPath rejects malformed and unknown locale", () => {
  expect(parseLangPath("projects/assets/a/1.20/b/lang/zh_cn.json/extra")).toBeNull();
  expect(parseLangPath("projects/assets/a/1.20/b/zh_cn.json")).toBeNull();
  expect(parseLangPath("projects/1.20/assets/a/b/lang/zh_cn.txt")).toBeNull();
  expect(parseLangPath("projects/assets/a/1.20/b/lang/README.md")).toBeNull();
  expect(parseLangPath("projects/assets/a/1.20/b/lang/zh_tw.json")?.locale).toBeNull();
});

test("buildLangPath always modern", () => {
  expect(buildLangPath("foo", "1.20", "bar", "zh_cn")).toBe("projects/assets/foo/1.20/bar/lang/zh_cn.json");
  expect(buildLangPath("foo", "1.12.2", "bar", "en_us")).toBe("projects/assets/foo/1.12.2/bar/lang/en_us.lang");
  expect(buildLangPath("foo", "1.20", "bar", "zh_cn", "lang")).toBe(
    "projects/assets/foo/1.20/bar/lang/zh_cn.lang",
  );
});

test("parseVersionDir and langFormatFor", () => {
  expect(parseVersionDir("1.12.2")).toEqual({ dir: "1.12.2", mc: "1.12.2", loader: "forge" });
  expect(parseVersionDir("1.20-fabric")).toEqual({ dir: "1.20-fabric", mc: "1.20", loader: "fabric" });
  expect(parseVersionDir("1.20.1")).toEqual({ dir: "1.20.1", mc: "1.20.1", loader: "forge" });
  expect(parseVersionDir("26.1")).toEqual({ dir: "26.1", mc: "26.1", loader: "forge" });
  expect(parseVersionDir("1.20.1.4")).toBeNull();
  expect(parseVersionDir("main")).toBeNull();
  expect(langFormatFor("1.12.2")).toBe("lang");
  expect(langFormatFor("1.20")).toBe("json");
});

test("mcMatches", () => {
  expect(mcMatches("1.20", "1.20")).toBe(true);
  expect(mcMatches("1.20", "1.20.4")).toBe(true);
  expect(mcMatches("1.20", "1.201")).toBe(false);
  expect(mcMatches("1.20", "1.19.2")).toBe(false);
  expect(mcMatches("1.12.2", "1.12.2")).toBe(true);
  expect(mcMatches("1.12.2", "1.12.3")).toBe(false);
  expect(mcMatches("26.1", "26.1.4")).toBe(true);
  expect(mcMatches("1.20-fabric", "1.20.1")).toBe(true);
});

test("compareMc", () => {
  expect(compareMc("1.20", "1.20.4")).toBeLessThan(0);
  expect(compareMc("1.19", "1.20")).toBeLessThan(0);
  expect(compareMc("1.20.4", "1.20")).toBeGreaterThan(0);
  expect(compareMc("1.12.2", "1.12.2")).toBe(0);
  expect(compareMc("1.9", "1.19")).toBeLessThan(0);
});

test("workspacesOf groups lang files in encounter order", () => {
  const workspaces = workspacesOf([
    "projects/assets/b/1.20/x/lang/zh_cn.json",
    "projects/assets/a/1.20/y/lang/en_us.json",
    "projects/assets/b/1.20/x/lang/en_us.json",
    "projects/assets/b/1.20/x/lang/zh_tw.json",
    "projects/assets/b/1.20/x/packer-policy.json",
  ]);
  expect(workspaces).toEqual([
    { slug: "b", version: "1.20", namespace: "x", files: ["projects/assets/b/1.20/x/lang/zh_cn.json", "projects/assets/b/1.20/x/lang/en_us.json"] },
    { slug: "a", version: "1.20", namespace: "y", files: ["projects/assets/a/1.20/y/lang/en_us.json"] },
  ]);
});

test("modRefOf", () => {
  expect(modRefOf("modrinth-sodium")).toEqual({ provider: "modrinth", slug: "sodium" });
  expect(modRefOf("1UNKNOWN")).toEqual({ provider: "none", slug: "1UNKNOWN" });
  expect(modRefOf("0-modrinth-mod")).toEqual({ provider: "none", slug: "0-modrinth-mod" });
  expect(modRefOf("jei")).toEqual({ provider: "curseforge", slug: "jei" });
});
