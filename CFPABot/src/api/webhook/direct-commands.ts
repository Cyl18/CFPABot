// src/api/webhook/direct-commands.ts
// 单列命令 — 确定性操作,webhook 直接执行对应 Flow,不经过 Agent Session。
//
// 命令(仅仓库管理员可用,见 command-auth.ts):
//   /add-co-author <user>          → coauthor_add
//   /update-en <slug> <version>    → files_fetch_en_us(自动探测目标路径)
//   /sort-keys <path>              → files_sort_keys
//   /add-mapping <slug> <id>       → mapping_add
//
// 与 /agent* 的分界线:读型/低歧义/固定参数的确定性命令直连 Flow;
// 需要理解、组合或多步的操作交给 Agent Session(agent-command.ts)。

import { randomUUID } from "node:crypto";
import type { GitHubClient } from "@/client/github/index.js";
import type { Logger } from "@/logger.js";
import type { EntryConfig } from "@/config.js";
import type { FlowRegistry } from "@/engine/registry.js";
import type { FileStore, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { buildContext } from "@/context.js";
import { executeFlow } from "@/engine/execute.js";
import { isPrComment } from "./dto.js";
import { requireAdminCommenter } from "./command-auth.js";

export interface DirectCommandDeps {
  githubClient: GitHubClient;
  logger: Logger;
  config: EntryConfig;
  registry: FlowRegistry;
  fileStore: FileStore;
  /** Raw delivery id from x-github-delivery header (may be empty — manual triggers). */
  deliveryId?: string;
}

type DirectCommandMatch =
  | { name: "add-co-author"; args: { login: string } }
  | { name: "update-en"; args: { slug: string; gameVersion: string } }
  | { name: "sort-keys"; args: { path: string } }
  | { name: "add-mapping"; args: { slug: string; projectId: number } };

/** Match a single-line direct command; null when the line is not one. */
function matchDirectCommand(line: string): DirectCommandMatch | null {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^\/add-co-author\s+(@?[\w-]+)$/))) {
    return { name: "add-co-author", args: { login: m[1]!.replace(/^@/, "") } };
  }
  if ((m = line.match(/^\/update-en\s+(\S+)\s+(\S+)$/))) {
    return { name: "update-en", args: { slug: m[1]!, gameVersion: m[2]! } };
  }
  if ((m = line.match(/^\/sort-keys\s+(.+)$/))) {
    return { name: "sort-keys", args: { path: m[1]!.trim() } };
  }
  if ((m = line.match(/^\/add-mapping\s+(\S+)\s+(\d+)$/))) {
    return { name: "add-mapping", args: { slug: m[1]!, projectId: Number(m[2]!) } };
  }
  return null;
}

/**
 * Try to handle a direct command on a PR comment.
 * Returns true if the comment was a recognized direct command (dispatch
 * should be skipped), false otherwise. All error paths reply to the PR
 * and return true — never fall through to dispatch for a command.
 * Only reacts to newly-created comments — edited/deleted comments must not
 * re-trigger mutation commands (each edit would re-execute with a fresh
 * delivery id).
 */
export async function handleDirectCommand(
  body: unknown,
  eventType: string,
  deps: DirectCommandDeps,
): Promise<boolean> {
  if (eventType !== "issue_comment.created") return false;
  if (!isPrComment(body)) return false;

  const payload = body as Record<string, unknown>;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const commentBody = (comment?.body as string | undefined) ?? "";
  const firstLine = commentBody.trim().split("\n")[0]?.trim() ?? "";
  const match = matchDirectCommand(firstLine);
  if (!match) return false;

  const sender = payload.sender as Record<string, unknown> | undefined;
  const commenterLogin = (sender?.login ?? "") as string;
  if (!commenterLogin) {
    deps.logger.warn({}, "单列命令来自未知用户，忽略");
    return true;
  }
  const senderType = (sender?.type ?? "") as string;
  if (senderType === "Bot") {
    deps.logger.info({ login: commenterLogin }, "单列命令来自 bot，忽略");
    return true;
  }
  const issue = payload.issue as Record<string, unknown> | undefined;
  const prNumber = (issue?.number ?? payload.number) as number;
  const commentId = ((comment as Record<string, unknown> | undefined)?.id ?? 0) as number;

  // 仅管理员(协作者/member)
  if (!(await requireAdminCommenter(deps.githubClient, deps.logger, prNumber, commenterLogin))) {
    return true;
  }

  // 契约校验:/sort-keys 接受仓库相对路径,必须 projects/ 开头
  // (ref 语义与 flow schema 均如此定义;参数来自评论,入口即校验)。
  if (match.name === "sort-keys" && !match.args.path.startsWith("projects/")) {
    await deps.githubClient.createIssueComment(
      prNumber,
      `命令 \`${firstLine}\` 参数无效:文件路径必须是仓库相对路径,以 \`projects/\` 开头(如 \`projects/twilightforest/1.16/twilightforest/lang/zh_cn.json\`)。`,
    );
    deps.logger.info({ login: commenterLogin, prNumber, path: match.args.path }, "sort-keys 路径不符合 projects/ 契约");
    return true;
  }

  deps.logger.info(
    { login: commenterLogin, prNumber, command: match.name },
    "单列命令已收到，开始执行",
  );

  // Webhook-originated execution context — actor is the admin commenter,
  // so execution records attribute the operation to a person, not "system".
  const ctx = buildContext(
    { type: "issue_comment.created", source: "webhook", payload: body },
    { github: deps.githubClient, logger: deps.logger, config: deps.config, store: deps.fileStore },
    {
      actor: { kind: "admin", login: commenterLogin },
      scope: { prNumber },
      invocation: {
        // Deterministic per-comment id: GitHub redelivers failed webhook
        // deliveries — the same command comment must not re-execute its
        // mutation flow (idempotency keys embed invocation.id). Without a
        // deliveryId (manual trigger) fall back to random.
        id: deps.deliveryId ? `${deps.deliveryId}:${commentId}` : randomUUID(),
        source: "webhook",
        deliveryId: deps.deliveryId,
      },
      signal: new AbortController().signal,
    },
  );

  try {
    const result = await executeDirectCommand(match, ctx, deps, prNumber);
    await deps.githubClient.createIssueComment(prNumber, formatSuccess(match, result));
    deps.logger.info(
      { login: commenterLogin, prNumber, command: match.name },
      "单列命令执行成功",
    );
  } catch (err) {
    deps.logger.error(
      { err: String(err), prNumber, command: match.name },
      "单列命令执行失败",
    );
    // 只向公开评论暴露可读的 FlowError 消息;内部错误(octokit 堆栈、
    // 网络细节)仅记日志,避免泄露内部信息到 PR 线程。
    const publicMsg =
      err instanceof FlowError ? (err.publicMessage ?? err.message) : "内部错误,详情见日志。";
    await deps.githubClient.createIssueComment(
      prNumber,
      `命令 \`${firstLine}\` 执行失败:${publicMsg}`,
    );
  }
  return true;
}

// ─── Command execution ────────────────────────────────────────────────

async function executeDirectCommand(
  match: DirectCommandMatch,
  ctx: FlowContext,
  deps: DirectCommandDeps,
  prNumber: number,
): Promise<Record<string, unknown>> {
  const pr = await deps.githubClient.getPullRequest(prNumber);
  const headSha = pr.head?.sha ?? "";
  const exec = (flowName: string, input: Record<string, unknown>) =>
    executeFlow(deps.registry.get(flowName), ctx, input);

  switch (match.name) {
    case "add-co-author":
      return (await exec("coauthor_add", {
        prNumber,
        headSha,
        login: match.args.login,
      })) as Record<string, unknown>;
    case "sort-keys":
      return (await exec("files_sort_keys", {
        prNumber,
        headSha,
        paths: [match.args.path],
      })) as Record<string, unknown>;
    case "add-mapping":
      return (await exec("mapping_add", {
        slug: match.args.slug,
        projectId: match.args.projectId,
        provider: "curseforge",
      })) as Record<string, unknown>;
    case "update-en": {
      const resolved = await exec("files_resolve_en_us_path", {
        prNumber,
        slug: match.args.slug,
        gameVersion: match.args.gameVersion,
      }) as { path: string | null };
      const targetPath = resolved.path;
      if (!targetPath) {
        throw new FlowError({
          code: "FAILED",
          message: `找不到 PR 中 ${match.args.slug} 的 zh_cn 语言文件路径`,
          publicMessage: `找不到该 PR 中 ${match.args.slug} 的语言文件路径，无法确定 en_us 的写入位置。`,
          retryable: false,
        });
      }
      return (await exec("files_fetch_en_us", {
        prNumber,
        headSha,
        source: "curseforge",
        slug: match.args.slug,
        gameVersion: match.args.gameVersion,
        targetPath,
      })) as Record<string, unknown>;
    }
  }
}

function formatSuccess(
  match: DirectCommandMatch,
  result: Record<string, unknown>,
): string {
  const sha = (v: unknown) => (typeof v === "string" ? v.slice(0, 7) : "");
  switch (match.name) {
    case "add-co-author":
      return `已为 @${match.args.login} 添加 Co-authored-by 提交（\`${sha(result.commitSha)}\`）。`;
    case "update-en":
      return `已从 CurseForge 拉取 ${match.args.slug} 的英文文件并写入 \`${result.writtenPath}\`（提交 \`${sha(result.commitSha)}\`）。`;
    case "sort-keys":
      return `已重排 \`${match.args.path}\` 的键序（修改 ${result.changedFiles} 个文件）。`;
    case "add-mapping":
      return `已添加映射 ${match.args.slug} → ${match.args.projectId}（共 ${result.revision} 条）。`;
  }
}
