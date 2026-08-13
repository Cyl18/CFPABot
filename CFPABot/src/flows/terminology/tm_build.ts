// src/flows/terminology/tm_build.ts
// Flow: tm_build — 构建指定 mod slug 的翻译记忆(TM)索引并落盘。
// Risk: read | Effects: github_read, storage_write
//
// 读取指定 ref(base/head)下该 slug 的全部语言文件(新布局 projects/assets/{slug}/...
// 与旧布局 projects/{version}/{slug}/... 下的 zh_cn.json / en_us.json, 含所有
// version 与 namespace, 不分), 按 key 配对 (en, zh) 语料, 构建 BM25 索引后
// 原子写入 runtime/cache/tm/{slug}.json(writeJsonLocked)。
//
// 配对的 path 取 en_us 文件路径; 同 en 不同 zh 的语料全部保留(多译法候选是审查重点),
// 去重仅发生在同 en 且同 zh 时(合并计数)。

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { writeJsonLocked } from "@/_shared/fs-utils.js";
import { tmIndexPath } from "@/runtime-paths.js";
import { parseProjectPath } from "../_shared/project-path/index.js";
import { buildTmIndex, type TmEntry, type TmIndexFile } from "../_shared/terminology/index.js";

const LANG_FILE_RE = /^(zh_cn|en_us)\.json$/;
const EN_US_SUFFIX = "/en_us.json";

// ─── Input Schema ──────────────────────────────────────────────────────

export const tm_build_input = Type.Object({
  prNumber: Type.Number({ description: "PR 编号, 用于解析 base ref 的提交 SHA" }),
  headSha: Type.String({ description: "PR head 提交 SHA(40 位 hex); ref=head 时校验与 PR 当前 head 一致" }),
  ref: Type.Optional(
    Type.Union(
      [Type.Literal("base"), Type.Literal("head")],
      { description: "语料来源 ref, 默认 head" },
    ),
  ),
  slug: Type.String({ description: "Mod slug, 例如 twilightforest" }),
});

export type TmBuildInput = Static<typeof tm_build_input>;

// ─── Output Schema ─────────────────────────────────────────────────────

export const tm_build_output = Type.Object({
  ok: Type.Boolean({ description: "是否成功" }),
  slug: Type.String({ description: "构建的 slug" }),
  ref: Type.Union([Type.Literal("base"), Type.Literal("head")], { description: "实际使用的 ref" }),
  sha: Type.String({ description: "实际读取语料的提交 SHA" }),
  files: Type.Number({ description: "匹配到的语言文件数" }),
  entries: Type.Number({ description: "收集的 (en,zh) 语料对数(去重前)" }),
  docs: Type.Number({ description: "去重后索引文档数(同 en 同 zh 合并)" }),
  indexBytes: Type.Number({ description: "落盘索引 JSON 字节数" }),
  errors: Type.Array(
    Type.Object({ path: Type.String(), error: Type.String() }),
    { description: "读取失败的文件列表(不阻断其余文件)" },
  ),
});

export type TmBuildOutput = Static<typeof tm_build_output>;

// ─── Flow Definition ───────────────────────────────────────────────────

export const tm_build: Flow<typeof tm_build_input, typeof tm_build_output> = {
  name: "tm_build",
  description:
    "构建翻译记忆(TM)索引: 读取指定 slug 在 base/head ref 下的全部 en_us/zh_cn 语言文件" +
    "(含所有 version/namespace), 按 key 配对语料并构建 BM25 索引, 写入 runtime/cache/tm/{slug}.json。" +
    "构建后可用 tm_query 工具检索。",
  input: tm_build_input,
  output: tm_build_output,
  meta: {
    tags: ["terminology", "tm", "cache"],
    risk: "read",
    effects: ["github_read", "storage_write"],
    agent_callable: true,
    timeoutMs: 60_000,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof tm_build_input>,
  ): Promise<Static<typeof tm_build_output>> {
    const ref = input.ref ?? "head";
    const { slug, headSha } = input;
    ctx.logger.info({ prNumber: input.prNumber, slug, ref }, "tm_build started");

    // ── 解析目标 SHA ──
    let pr;
    try {
      pr = await ctx.github.getPullRequest(input.prNumber);
    } catch (err: unknown) {
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `Failed to fetch PR #${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (ref === "head" && pr.head.sha !== headSha) {
      throw new FlowError({
        code: "STALE_HEAD",
        message: `PR head is ${pr.head.sha}, expected ${headSha}`,
        publicMessage: "PR head 已变更, 请重新获取 headSha 后再构建",
        retryable: false,
      });
    }
    const sha = ref === "head" ? pr.head.sha : pr.base.sha;
    if (!sha) {
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `PR #${input.prNumber} has no ${ref} SHA`,
      });
    }

    // ── 定位该 slug 的全部语言文件 ──
    const tree = await ctx.github.getGitTree(sha, true);
    if (!tree) {
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `Failed to fetch git tree for ${sha.slice(0, 7)}`,
      });
    }
    const langFiles = tree
      .filter((e) => e.type === "blob")
      .map((e) => e.path)
      .filter((path) => {
        const parsed = parseProjectPath(path);
        return parsed !== null && parsed.slug === slug && LANG_FILE_RE.test(parsed.fileName);
      });

    // ── 拉取文件内容(单文件失败不阻断其余) ──
    const contents = new Map<string, Record<string, string>>();
    const errors: { path: string; error: string }[] = [];
    for (const path of langFiles) {
      try {
        const content = await ctx.github.fetchFileContent(path, sha);
        if (content) contents.set(path, content);
      } catch (err: unknown) {
        errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── 按 key 配对 en/zh 语料 ──
    const entries: TmEntry[] = [];
    for (const [enPath, enContent] of contents) {
      if (!enPath.endsWith(EN_US_SUFFIX)) continue;
      const zhPath = enPath.slice(0, -EN_US_SUFFIX.length) + "/zh_cn.json";
      const zhContent = contents.get(zhPath);
      if (!zhContent) continue;
      for (const key of Object.keys(enContent)) {
        const en = enContent[key];
        const zh = zhContent[key];
        if (typeof en !== "string" || typeof zh !== "string") continue;
        if (en.trim() === "" || zh.trim() === "") continue; // 空语料不建索引
        entries.push({ en, zh, path: enPath, key });
      }
    }

    // ── 构建索引并落盘 ──
    const index = buildTmIndex(entries);
    const payload: TmIndexFile = {
      slug,
      ref,
      sha,
      builtAt: new Date().toISOString(),
      index,
    };
    await writeJsonLocked(tmIndexPath(slug), payload);
    const indexBytes = Buffer.byteLength(JSON.stringify(payload, null, 2), "utf-8");

    ctx.logger.info(
      { slug, ref, sha: sha.slice(0, 7), files: langFiles.length, entries: entries.length, docs: index.totalDocs },
      "tm_build completed",
    );
    return {
      ok: true,
      slug,
      ref,
      sha,
      files: langFiles.length,
      entries: entries.length,
      docs: index.totalDocs,
      indexBytes,
      errors,
    };
  },
};
