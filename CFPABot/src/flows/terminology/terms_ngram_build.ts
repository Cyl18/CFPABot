// src/flows/terminology/terms_ngram_build.ts
// Flow: terms_ngram_build — 从指定 ref(base/head)下某 slug 的全部语言文件
// (en_us/zh_cn, json/lang)中提取跨条目重复出现的 n-gram 术语候选。
// 只读,不写 ctx — 结果由 agent 工具落库。
// Risk: read | Effects: github_read

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import {
  loadPrSnapshot,
  loadFileAtRef,
  wrapClientError,
} from "../_internal/index.js";
import { parseProjectPath } from "../_shared/project-path/index.js";
import { parseTranslationContent } from "../_shared/language/index.js";
import {
  extractNgramTerms,
  type NgramLangEntry,
} from "../_shared/terminology/index.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const terms_ngram_build_input = Type.Object({
  prNumber: Type.Number({
    description: "PR 编号,用于解析 base/head 的提交 SHA 与校验 head 未变更",
  }),
  headSha: Type.String({
    description: "PR head 提交 SHA,与 PR 当前 head 不一致时报 STALE_HEAD(防止过期审查)",
  }),
  ref: Type.Optional(
    Type.Union(
      [Type.Literal("base"), Type.Literal("head")],
      { description: "读取哪个 ref 的语言文件,默认 head" },
    ),
  ),
  slug: Type.String({
    minLength: 1,
    description: "模组 slug(如 twilightforest),匹配路径 projects/assets/{slug}/…",
  }),
  versionFilter: Type.Optional(
    Type.String({
      description: "可选: 游戏版本过滤(如 1.20.1),精确匹配路径中的版本段",
    }),
  ),
  namespaceFilter: Type.Optional(
    Type.String({
      description: "可选: 模组命名空间/domain 过滤,精确匹配路径中的 modDomain 段",
    }),
  ),
  n: Type.Optional(
    Type.Union(
      [Type.Literal(1), Type.Literal(2), Type.Literal(3)],
      { description: "n-gram 大小,默认 2(bigram)" },
    ),
  ),
  minFreq: Type.Optional(
    Type.Number({ description: "最小跨条目频次(出现在多少个不同条目中),默认 2" }),
  ),
  minLen: Type.Optional(
    Type.Number({ description: "每个 token 的最小字符数(过滤短词),默认 2" }),
  ),
  maxTerms: Type.Optional(
    Type.Number({ description: "最多返回候选术语数,默认 200" }),
  ),
});

export type TermsNgramBuildInput = Static<typeof terms_ngram_build_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const terms_ngram_build_output = Type.Object({
  ok: Type.Literal(true, { description: "执行成功标记" }),
  ref: Type.String({ description: "读取的 ref 标签(base/head)" }),
  refSha: Type.String({ description: "实际读取的提交 SHA" }),
  slug: Type.String({ description: "本次提取的模组 slug" }),
  terms: Type.Array(
    Type.Object({
      word: Type.String({ description: "n-gram 词(保留出现最多的原始大小写形式)" }),
      text: Type.String({ description: "出现该 n-gram 的条目中占比最高的中文翻译" }),
      freq: Type.Number({ description: "出现该 n-gram 的不同条目数(跨条目频次)" }),
      note: Type.String({ description: "备注(频次标注)" }),
    }),
    { description: "候选术语,按 freq 降序排列" },
  ),
});

export type TermsNgramBuildOutput = Static<typeof terms_ngram_build_output>;

// ─── Internal helpers ──────────────────────────────────────────────────

/** 语言文件名匹配: en_us/zh_cn + json/lang。 */
const LANG_FILE_RE = /^(en_us|zh_cn)\.(json|lang)$/;

interface LangFilePair {
  version: string;
  domain: string;
  enPath?: string;
  zhPath?: string;
}

// ─── Flow Definition ────────────────────────────────────────────────────

export const terms_ngram_build: Flow<
  typeof terms_ngram_build_input,
  typeof terms_ngram_build_output
> = {
  name: "terms_ngram_build",
  description:
    "从指定 ref(base/head)下某模组 slug 的全部语言文件中提取跨条目重复出现的 n-gram 术语候选(自动术语表). 支持版本/命名空间过滤与频次/长度/数量参数. 只读,不写会话上下文.",
  input: terms_ngram_build_input,
  output: terms_ngram_build_output,
  meta: {
    tags: ["terminology", "pr", "query", "review"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof terms_ngram_build_input>,
  ): Promise<Static<typeof terms_ngram_build_output>> {
    const {
      prNumber,
      headSha,
      ref = "head",
      slug,
      versionFilter,
      namespaceFilter,
      n,
      minFreq,
      minLen,
      maxTerms,
    } = input;

    // 解析 PR 快照: 校验 head 未变更(STALE_HEAD 防护),并取 base/head SHA
    const snapshot = await loadPrSnapshot(ctx, {
      prNumber,
      expectedHeadSha: headSha,
    });

    let refSha: string;
    if (ref === "head") {
      refSha = snapshot.head.sha;
    } else {
      if (!snapshot.base.sha) {
        throw new FlowError({
          code: "INVALID_INPUT",
          message: `PR #${prNumber} has no base commit SHA`,
          publicMessage: `无法解析 PR #${prNumber} 的 base 提交 SHA`,
          retryable: false,
        });
      }
      refSha = snapshot.base.sha;
    }

    // 递归文件树,筛选该 slug 下匹配的语言文件配对(en_us + zh_cn)
    let tree;
    try {
      tree = await ctx.github.getGitTree(refSha, true);
    } catch (err: unknown) {
      throw wrapClientError(
        err,
        `Failed to fetch git tree at ${refSha.slice(0, 7)}`,
      );
    }

    const pairs = new Map<string, LangFilePair>();
    for (const entry of tree) {
      if (entry.type !== "blob") continue;
      const parsed = parseProjectPath(entry.path);
      if (!parsed || parsed.slug !== slug) continue;
      if (versionFilter && parsed.gameVersion !== versionFilter) continue;
      if (namespaceFilter && parsed.modDomain !== namespaceFilter) continue;
      const m = LANG_FILE_RE.exec(parsed.fileName);
      if (!m) continue;

      const pairKey = `${parsed.gameVersion}\u0000${parsed.modDomain}`;
      let pair = pairs.get(pairKey);
      if (!pair) {
        pair = { version: parsed.gameVersion, domain: parsed.modDomain };
        pairs.set(pairKey, pair);
      }
      if (m[1] === "en_us") pair.enPath = entry.path;
      else pair.zhPath = entry.path;
    }

    // 逐配对加载并解析 en/zh 文件,按 key 对齐生成语料条目
    // 单文件失败只跳过该配对,不丢弃其余语料
    const langEntries: NgramLangEntry[] = [];
    for (const pair of pairs.values()) {
      if (!pair.enPath || !pair.zhPath) continue;

      let enContent: string | null;
      let zhContent: string | null;
      try {
        const enFile = await loadFileAtRef(ctx, { path: pair.enPath, ref: refSha });
        enContent = enFile.content;
      } catch (err: unknown) {
        ctx.logger.warn(
          { err: String(err), path: pair.enPath },
          "terms_ngram_build: 读取 en_us 文件失败,跳过该配对",
        );
        continue;
      }
      try {
        const zhFile = await loadFileAtRef(ctx, { path: pair.zhPath, ref: refSha });
        zhContent = zhFile.content;
      } catch (err: unknown) {
        ctx.logger.warn(
          { err: String(err), path: pair.zhPath },
          "terms_ngram_build: 读取 zh_cn 文件失败,跳过该配对",
        );
        continue;
      }
      if (enContent === null || zhContent === null) continue;

      const enMap = parseTranslationContent(enContent);
      const zhMap = parseTranslationContent(zhContent);
      for (const key of Object.keys(enMap)) {
        if (!(key in zhMap)) continue;
        langEntries.push({
          en: enMap[key] ?? "",
          zh: zhMap[key] ?? "",
          path: pair.zhPath,
          version: pair.version,
          domain: pair.domain,
        });
      }
    }

    const terms = extractNgramTerms(langEntries, { n, minFreq, minLen, maxTerms });

    return {
      ok: true,
      ref,
      refSha,
      slug,
      terms,
    };
  },
};
