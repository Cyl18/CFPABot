import {
  InternalUrlRouter,
  type InternalResource,
  type InternalWriteResult,
  type ProtocolHandler,
  type SchemeSpec,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ReviewDraft } from "@cfpa/contracts/api";
import { logger } from "../log.ts";
import { readGh } from "../harness/gh-read.ts";
import { readPr } from "../harness/pr-read.ts";
import { type HarnessSession } from "../harness/types.ts";
import { writePr } from "../harness/pr-write.ts";
import { readRepo } from "../harness/repo-read.ts";
import { partsOf, prPartsOf } from "../harness/uri.ts";
import { findWriteTarget, unsupportedWrite } from "../harness/write-targets.ts";

const log = logger("schemes");

export interface SchemeDeps {
  /** 由 omp 会话文件或本站会话 ID 反查；读草稿与写 GitHub 都要用。 */
  sessionOf(ref: string | undefined): HarnessSession | undefined;
  /** 草稿落盘后把面板与列表一起刷新。 */
  onDraftSaved?(sessionId: string, draft: ReviewDraft): void | Promise<void>;
}

function textOf(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const REPO_SPEC: SchemeSpec = {
  backing: "virtual",
  selectors: "lines",
  pathAuthority: true,
  immutable: true,
};

const GH_SPEC: SchemeSpec = {
  backing: "remote",
  selectors: "none",
  immutable: true,
};

const PR_SPEC: SchemeSpec = {
  backing: "remote",
  selectors: "lines",
  immutable: false,
  write: {
    via: "handler",
    payload: "verbatim",
    scope: "coordination",
    tier: () => "write",
    contentOptional: () => true,
  },
};

export function registerSchemes(deps: SchemeDeps): () => void {
  const router = InternalUrlRouter.instance();

  const repo: ProtocolHandler = {
    scheme: "repo",
    spec: REPO_SPEC,
    resolve: async (url): Promise<InternalResource> => {
      const { text, isDirectory } = await readRepo(partsOf(url));
      return { url: url.href, content: text, contentType: "text/plain", ...(isDirectory ? { isDirectory } : {}) };
    },
  };

  const gh: ProtocolHandler = {
    scheme: "gh",
    spec: GH_SPEC,
    resolve: async (url) => ({
      url: url.href,
      content: textOf(await readGh(partsOf(url))),
      contentType: "text/plain",
    }),
  };

  const pr: ProtocolHandler = {
    scheme: "pr",
    spec: PR_SPEC,
    resolve: async (url, context) => {
      const session = deps.sessionOf(context?.sessionFile) ?? deps.sessionOf(context?.sessionId);
      return {
        url: url.href,
        content: textOf(await readPr(prPartsOf(url), session)),
        contentType: "text/plain",
      };
    },
    write: async (url, content, context): Promise<InternalWriteResult> => {
      const ref = context?.session?.getSessionFile?.() ?? context?.session?.getSessionId?.() ?? undefined;
      const session = deps.sessionOf(ref);
      if (session === undefined) throw new Error("无法确定写入会话，请重开会话后重试。");
      const parts = prPartsOf(url);
      const target = findWriteTarget(parts);
      if (target === undefined) throw unsupportedWrite();
      const result = await writePr(
        parts,
        target,
        content,
        {
          ...session,
          onDraftSaved: (draft: ReviewDraft) => deps.onDraftSaved?.(session.sessionId, draft),
        },
        context?.toolCall?.id ?? "manual",
      );
      return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
    },
  };

  // omp 的 pr:// 是 gh CLI 浏览语义；本站的 pr:// 承载 PR 审查资源与写入，必须接管。
  router.unregister("pr");
  for (const handler of [repo, gh, pr]) router.register(handler);
  log.info("已注册资源 scheme", { schemes: [repo.scheme, gh.scheme, pr.scheme] });

  return () => {
    for (const handler of [repo, gh, pr]) router.unregister(handler.scheme);
  };
}
