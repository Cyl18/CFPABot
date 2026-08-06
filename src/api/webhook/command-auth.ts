// src/api/webhook/command-auth.ts
// Shared admin check for GitHub comment commands.
// "仅管理员" = 仓库协作者/member(write 及以上),与 AGENTS.md isAdmin 语义一致
// (checkCollaborator 走 GitHub GET /repos/{owner}/{repo}/collaborators/{username},
// 包含 write collaborator、repo owner 与 org 内 write 成员)。

import type { GitHubClient } from "@/client/github/index.js";
import type { Logger } from "@/logger.js";

/**
 * Verify the commenter is a repo admin; on failure reply with a rejection
 * comment and return false. Returns true only when the command may proceed.
 */
export async function requireAdminCommenter(
  githubClient: GitHubClient,
  logger: Logger,
  prNumber: number,
  commenterLogin: string,
): Promise<boolean> {
  try {
    const isAdmin = await githubClient.checkCollaborator(commenterLogin);
    if (!isAdmin) {
      logger.warn({ login: commenterLogin }, "命令来自非管理员，拒绝");
      await githubClient.createIssueComment(
        prNumber,
        `抱歉，@${commenterLogin}，只有仓库管理员可以使用此命令。`,
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err: String(err), login: commenterLogin },
      "验证协作者权限失败",
    );
    return false;
  }
}
