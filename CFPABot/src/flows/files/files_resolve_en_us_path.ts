// src/flows/files/files_resolve_en_us_path.ts
// Flow: files_resolve_en_us_path — derive the en_us.json target path from a
// PR's changed zh_cn language file.
//
// Previously this path-selection logic lived in the webhook direct-command
// adapter (api layer). It is business logic, so it now has its own read Flow
// with execution records and Agent discoverability.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";

export const files_resolve_en_us_path_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  slug: Type.String({ description: "Mod slug, e.g. twilightforest" }),
  gameVersion: Type.String({ description: "Requested game version, e.g. 1.16" }),
});

export type FilesResolveEnUsPathInput = Static<typeof files_resolve_en_us_path_input>;

export const files_resolve_en_us_path_output = Type.Object({
  path: Type.Union([Type.String(), Type.Null()], {
    description: "Target en_us.json repository path, or null when no zh_cn candidate exists",
  }),
});

export type FilesResolveEnUsPathOutput = Static<typeof files_resolve_en_us_path_output>;

export const files_resolve_en_us_path: Flow<
  typeof files_resolve_en_us_path_input,
  typeof files_resolve_en_us_path_output
> = {
  name: "files_resolve_en_us_path",
  description:
    "根据 PR 中修改的 zh_cn 语言文件推导对应 en_us.json 的仓库路径。" +
    "优先选择请求版本；没有匹配版本时退回第一个候选路径。找不到候选时返回 null。",
  input: files_resolve_en_us_path_input,
  output: files_resolve_en_us_path_output,
  meta: {
    tags: ["files", "query"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_resolve_en_us_path_input>,
  ): Promise<Static<typeof files_resolve_en_us_path_output>> {
    const { prNumber, slug, gameVersion } = input;
    const files = await ctx.github.getPullRequestFiles(prNumber);
    const slugRe = new RegExp(
      `^projects/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    );
    const candidates = files
      .map((f) => f.filename)
      .filter((f) => slugRe.test(f) && /\/lang\/zh_cn\.(json|lang)$/.test(f));
    if (candidates.length === 0) return { path: null };
    const byVersion = candidates.find((f) => f.split("/")[2] === gameVersion);
    const pick = byVersion ?? candidates[0]!;
    const seg = pick.split("/");
    seg[seg.length - 1] = "en_us.json";
    return { path: seg.join("/") };
  },
};
