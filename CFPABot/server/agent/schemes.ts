import {
  InternalUrlRouter,
  type InternalResource,
  type InternalWriteResult,
  type ProtocolHandler,
  type SchemeSpec,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { WriteScope } from "@cfpa/contracts/api";
import { logger } from "../log.ts";
import { readGh } from "./resources/gh-read.ts";
import { readHelp } from "./resources/help.ts";
import { readPr } from "./resources/pr-read.ts";
import { writePr } from "./resources/pr-write.ts";
import { readRepo } from "./resources/repo-files.ts";
import { partsOf, prPartsOf } from "./resources/uri.ts";
import { findWriteTarget, unsupportedWrite } from "./resources/write-targets.ts";

const log = logger("schemes");

export interface SessionRef {
  sessionId: string;
  writeScope: WriteScope;
}

export interface SchemeDeps {
  /** 由 omp 会话文件反查本站会话；写 GitHub 时用来带会话标记。 */
  sessionOf(sessionFile: string | undefined): SessionRef | undefined;
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

const HELP_SPEC: SchemeSpec = {
  backing: "virtual",
  selectors: "none",
  immutable: true,
  unbounded: true,
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
    resolve: async (url) => ({
      url: url.href,
      content: textOf(await readPr(prPartsOf(url))),
      contentType: "text/plain",
    }),
    write: async (url, content, context): Promise<InternalWriteResult> => {
      const session = deps.sessionOf(context?.session?.getSessionFile?.() ?? undefined);
      if (session === undefined) throw new Error("无法确定写入会话，请重开会话后重试。");
      const parts = prPartsOf(url);
      const target = findWriteTarget(parts);
      if (target === undefined) throw unsupportedWrite();
      const result = await writePr(parts, target, content, session, context?.toolCall?.id ?? "manual");
      return { content: result.content };
    },
  };

  const help: ProtocolHandler = {
    scheme: "help",
    spec: HELP_SPEC,
    resolve: async (url) => ({
      url: url.href,
      content: textOf(await readHelp(partsOf(url))),
      contentType: "text/markdown",
    }),
  };

  // omp 的 pr:// 是 gh CLI 浏览语义；本站的 pr:// 承载 PR 审查资源与写入，必须接管。
  router.unregister("pr");
  for (const handler of [repo, gh, pr, help]) router.register(handler);
  log.info("已注册资源 scheme", { schemes: [repo.scheme, gh.scheme, pr.scheme, help.scheme] });

  return () => {
    for (const handler of [repo, gh, pr, help]) router.unregister(handler.scheme);
  };
}
