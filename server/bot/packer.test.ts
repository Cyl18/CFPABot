import { expect, test } from "bun:test";
import type { GhArtifact, GhPull, GhRun } from "../github/client.ts";
import { gh } from "../github/client.ts";
import { collectPacker } from "./packer.ts";

const pull: GhPull = {
  number: 1,
  title: "test",
  body: "",
  state: "open",
  merged: false,
  draft: false,
  author: "someone",
  authorId: 1,
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  htmlUrl: "https://example.com/pull/1",
  baseRef: "main",
  baseSha: "base",
  headRef: "patch-1",
  headSha: "head",
  headRepoOwner: "someone",
  headRepoName: "fork",
  maintainerCanModify: null,
};

function run(overrides: Partial<GhRun>): GhRun {
  return {
    id: 7,
    name: "PR Packer",
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    headSha: "head",
    headBranch: "patch-1",
    headOwner: "someone",
    htmlUrl: "https://example.com/run/7",
    createdAt: "2026-01-01T00:00:00Z",
    pullNumbers: [1],
    ...overrides,
  };
}

function artifact(overrides: Partial<GhArtifact>): GhArtifact {
  return { id: 1, name: "pr-packer", expired: false, url: "https://nightly.link/x/y.zip", ...overrides };
}

test("branch and maintainer warnings precede workflow status", async () => {
  const original = gh.listPackerRuns;
  gh.listPackerRuns = async () => [];
  try {
    const text = await collectPacker({ ...pull, baseRef: "dev", maintainerCanModify: false }, []);
    expect(text).toBe(
      "❗ 警告：你所提交的目标分支不是 main 分支，这在 99% 的情况下都是你的问题。请 close 此 PR 并重新提交。\n\n---\n\n" +
        "⚠ 你没有启用“维护者可修改 PR 文件”（Allow edits from maintainers）；这会对维护者造成不便，在此页面右方勾选该选项。\n" +
        "![1](https://docs.github.com/assets/cb-44583/images/help/pull_requests/allow-maintainers-to-make-edits-sidebar-checkbox.png)\n\n---\n\n" +
        "⚠ 暂时没有检测到 workflow.\n",
    );
    const own = await collectPacker({ ...pull, maintainerCanModify: true }, []);
    expect(own).toBe("⚠ 暂时没有检测到 workflow.\n");
    const enabled = await collectPacker({ ...pull, headRepoOwner: "CFPAOrg", maintainerCanModify: false }, []);
    expect(enabled).toBe("⚠ 暂时没有检测到 workflow.\n");
  } finally {
    gh.listPackerRuns = original;
  }
});

test("queued and closed states", async () => {
  const original = gh.listPackerRuns;
  gh.listPackerRuns = async () => [run({ status: "queued", conclusion: null })];
  try {
    expect(await collectPacker(pull, [])).toBe(":milky_way: 打包器正在执行, 请耐心等待。\n");
    expect(await collectPacker({ ...pull, state: "closed" }, [])).toBe(":milky_way: PR 已经关闭。\n");
  } finally {
    gh.listPackerRuns = original;
  }
});

test("artifacts list", async () => {
  const originalRuns = gh.listPackerRuns;
  const originalArtifacts = gh.listArtifacts;
  gh.listPackerRuns = async () => [run({})];
  gh.listArtifacts = async () => [artifact({})];
  try {
    expect(await collectPacker(pull, [])).toBe(
      ":floppy_disk: 基于此 PR 所打包的资源包：\n- [pr-packer.zip](https://nightly.link/x/y.zip)\n",
    );
  } finally {
    gh.listPackerRuns = originalRuns;
    gh.listArtifacts = originalArtifacts;
  }
});
