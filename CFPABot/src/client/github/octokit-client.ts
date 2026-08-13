// src/client/github/octokit-client.ts
// GitHubClient implementation backed by Octokit (bot App JWT auth).
// Created once in bootstrap.ts, injected into FlowContext as `ctx.github`.

import { Octokit } from "@octokit/rest";
import type { Logger } from "@/types.js";
import { REPO, BOT_LOGIN } from "@/config.js";
import type {
  GitHubClient,
  PullRequest,
  PullRequestFile,
  IssueComment,
  WorkflowRun,
  RateLimit,
  PullRequestSummary,
  PullRequestListItem,
  SearchIssueResult,
  GitTreeEntry,
  Artifact,
  CreateCheckRunOptions,
  ListPullsPageOptions,
  ListAllPullsOptions,
  CreateReviewOptions,
  CreateReviewResult,
  ReviewComment,
} from "./types.js";
import {
  mapPullRequest,
  mapPullRequestFile,
  mapIssueComment,
  mapWorkflowRun,
  mapPullRequestSummary,
  mapPullRequestListItem,
  mapSearchIssueItem,
} from "./mappers.js";

const REPO_FULL = `${REPO.OWNER}/${REPO.NAME}`;


export function createGitHubClient(octokit: Octokit, personalOctokit?: Octokit | null, logger?: Logger): GitHubClient {
  // ─── Add request/response logging hooks ──────────────────────────────
  function setupLogging(clientOctokit: Octokit): void {
    if (!logger) return;
    clientOctokit.hook.wrap("request", async (request, options) => {
      const start = Date.now();
      try {
        const response = await request(options);
        const duration = Date.now() - start;
        logger.info({
          method: options.method,
          url: options.url,
          status: response.status,
          duration,
        }, `GitHub API: ${options.method} ${options.url} → ${response.status} (${duration}ms)`);
        return response;
      } catch (error: unknown) {
        const duration = Date.now() - start;
        const err = error as { status?: number };
        logger.warn({
          method: options.method,
          url: options.url,
          status: err.status ?? 0,
          duration,
          error: String(error),
        }, `GitHub API error: ${options.method} ${options.url} (${duration}ms)`);
        throw error;
      }
    });
  }

  setupLogging(octokit);
  if (personalOctokit) setupLogging(personalOctokit);
  const client: GitHubClient = {
    async getPullRequest(prId: number): Promise<PullRequest> {
      const r = await octokit.rest.pulls.get({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        pull_number: prId,
      });
      return mapPullRequest(r.data as Parameters<typeof mapPullRequest>[0]);
    },

    async getPullRequestFiles(prId: number): Promise<PullRequestFile[]> {
      const allData = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: REPO.OWNER,
        repo: REPO.NAME,
        pull_number: prId,
        per_page: 100,
      });
      return allData.map((d) => mapPullRequestFile(d as Parameters<typeof mapPullRequestFile>[0]));
    },

    async getPullRequestDiff(prId: number): Promise<string> {
      const r = await octokit.rest.pulls.get({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        pull_number: prId,
        mediaType: { format: "diff" },
      });
      const diffData = r.data as unknown;
      if (typeof diffData !== "string") {
        throw new Error(`Expected string diff response, got ${typeof diffData}`);
      }
      return diffData;
    },

    async listPullsPage(options: ListPullsPageOptions): Promise<PullRequestListItem[]> {
      const r = await octokit.rest.pulls.list({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        state: options.state ?? "open",
        per_page: options.perPage ?? 30,
        page: options.page,
        sort: options.sort ?? "created",
        direction: options.direction ?? "desc",
      });
      return r.data.map((d) => mapPullRequestListItem(d as Parameters<typeof mapPullRequestListItem>[0]));
    },

    async listAllPulls(options?: ListAllPullsOptions): Promise<PullRequestListItem[]> {
      const allData = await octokit.paginate(octokit.rest.pulls.list, {
        owner: REPO.OWNER,
        repo: REPO.NAME,
        state: options?.state ?? "open",
        per_page: options?.perPage ?? 100,
        sort: options?.sort ?? "created",
        direction: options?.direction ?? "desc",
      });
      return allData.map((d) => mapPullRequestListItem(d as Parameters<typeof mapPullRequestListItem>[0]));
    },

    async getPrComments(prId: number): Promise<IssueComment[]> {
      // Paginate: default per_page is 30 — active PRs exceed that, and the
      // info-comment findBotComment scan depends on seeing all comments
      // (otherwise each refresh posts a duplicate comment).
      const allData = await octokit.paginate(octokit.rest.issues.listComments, {
        owner: REPO.OWNER,
        repo: REPO.NAME,
        issue_number: prId,
        per_page: 100,
      });
      return allData.map((d) => mapIssueComment(d as Parameters<typeof mapIssueComment>[0]));
    },

    async createIssueComment(prId: number, body: string): Promise<IssueComment> {
      // request.retries: 0 — 非幂等 POST,网络错误/5xx 时执行状态未知,
      // 插件重发会造成重复评论(与只读请求的 retries: 5 区分)。
      const r = await octokit.rest.issues.createComment({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        issue_number: prId,
        body,
        request: { retries: 0 },
      });
      return mapIssueComment(r.data as Parameters<typeof mapIssueComment>[0]);
    },

    async updateIssueComment(commentId: number, body: string): Promise<IssueComment> {
      const r = await octokit.rest.issues.updateComment({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        comment_id: commentId,
        body,
        request: { retries: 0 },
      });
      return mapIssueComment(r.data as Parameters<typeof mapIssueComment>[0]);
    },

    async checkCollaborator(username: string): Promise<boolean> {
      try {
        await octokit.rest.repos.checkCollaborator({
          owner: REPO.OWNER,
          repo: REPO.NAME,
          username,
        });
        return true;
      } catch (err: unknown) {
        // 404 = user is not a collaborator.
        if (err instanceof Error && "status" in err && typeof (err as Record<string, unknown>).status === "number") {
          const status = (err as Record<string, unknown>).status as number;
          if (status === 404) {
            return false;
          }
          // 403 with this specific message means the authenticated token lacks push
          // access to check collaborator status — semantically "not a collaborator"
          // since a true push-level collaborator would get 204 even with public_repo scopes.
          // Other 403s (rate-limiting, abuse detection, scope errors) must propagate.
          if (status === 403 && typeof err.message === "string" && err.message.includes("Must have push access")) {
            return false;
          }
        }
        throw err;
      }
    },

    async getRateLimit(): Promise<RateLimit> {
      const r = await octokit.rest.rateLimit.get();
      return r.data as RateLimit;
    },

    async getWorkflowRun(checkSuiteId: number): Promise<WorkflowRun> {
      const r = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        check_suite_id: checkSuiteId,
        event: "pull_request",
      });
      const runs = r.data.workflow_runs;
      const run = runs[0];
      if (!run) throw new Error(`No workflow run found for check_suite_id=${checkSuiteId}`);
      return mapWorkflowRun(run as Parameters<typeof mapWorkflowRun>[0]);
    },

    async findWorkflowRunsByHeadSha(
      headSha: string,
      workflowName?: string,
    ): Promise<WorkflowRun[]> {
      const r = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        head_sha: headSha,
        event: "pull_request",
        per_page: 20,
      });
      let runs = r.data.workflow_runs ?? [];
      if (workflowName) {
        runs = runs.filter((run) => (run.name ?? "").includes(workflowName));
      }
      // Sort newest-first by run_number or created_at
      runs.sort((a, b) => {
        const aTime = a.created_at ?? "";
        const bTime = b.created_at ?? "";
        return bTime.localeCompare(aTime);
      });
      return runs.map((run) => mapWorkflowRun(run as Parameters<typeof mapWorkflowRun>[0]));
    },

    async approveWorkflowRun(runId: number): Promise<void> {
      await octokit.rest.actions.approveWorkflowRun({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        run_id: runId,
        request: { retries: 0 },
      });
    },

    async addLabels(prId: number, labels: string[]): Promise<void> {
      await octokit.rest.issues.addLabels({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        issue_number: prId,
        labels,
        request: { retries: 0 },
      });
    },

    async removeLabels(prId: number, labels: string[]): Promise<void> {
      const BATCH_SIZE = 10;
      for (let i = 0; i < labels.length; i += BATCH_SIZE) {
        const batch = labels.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((label) =>
            octokit.rest.issues.removeLabel({
              owner: REPO.OWNER,
              repo: REPO.NAME,
              issue_number: prId,
              name: label,
              request: { retries: 0 },
            }).catch((err: unknown) => {
              if (err instanceof Error && "status" in err && (err as { status: number }).status === 404) {
                return; // Label already removed — ignore
              }
              throw err;
            }),
          ),
        );
      }
    },

    async createCheckRun(opts: CreateCheckRunOptions): Promise<void> {
      await octokit.rest.checks.create({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        name: opts.name,
        head_sha: opts.sha,
        status: opts.status ?? "completed",
        conclusion: opts.conclusion,
        output: opts.output,
        request: { retries: 0 },
      });
    },

    async searchPulls(query: string): Promise<PullRequestSummary[]> {
      const r = await octokit.rest.search.issuesAndPullRequests({ q: query });
      return r.data.items.map((d) => mapPullRequestSummary(d as Parameters<typeof mapPullRequestSummary>[0]));
    },

    async searchIssues(query: string): Promise<SearchIssueResult> {
      const r = await octokit.rest.search.issuesAndPullRequests({
        q: query,
        per_page: 100,
      });
      return {
        totalCount: r.data.total_count,
        items: r.data.items.map((d) => mapSearchIssueItem(d as Parameters<typeof mapSearchIssueItem>[0])),
      };
    },

    async createGist(content: string, name: string): Promise<{ id: string; html_url: string }> {
      const gistOctokit = personalOctokit ?? octokit;
      const r = await gistOctokit.rest.gists.create({
        files: { [name]: { content } },
        public: false,
        request: { retries: 0 },
      });
      const data = r.data;
      if (!data.id || !data.html_url) throw new Error("Gist creation returned incomplete data");
      return { id: data.id, html_url: data.html_url };
    },

    async getGitTree(ref: string, recursive?: boolean): Promise<GitTreeEntry[]> {
      const r = await octokit.rest.git.getTree({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        tree_sha: ref,
        recursive: recursive ? "1" : undefined,
      });
      return (r.data.tree ?? []).map((entry) => ({
        path: entry.path ?? "",
        mode: entry.mode ?? "",
        type: (entry.type ?? "blob") as GitTreeEntry["type"],
        sha: entry.sha ?? "",
      }));
    },

    async fetchFileContent(path: string, ref: string): Promise<Record<string, string> | null> {
      try {
        const encoded = path.split("/").map((s) => encodeURIComponent(s)).join("/");
        const r = await octokit.rest.repos.getContent({
          owner: REPO.OWNER,
          repo: REPO.NAME,
          path: encoded,
          ref,
        });
        const data = r.data as { content?: string };
        if (data.content) {
          const decoded = Buffer.from(data.content, "base64").toString("utf-8");
          return JSON.parse(decoded) as Record<string, string>;
        }
        return null;
      } catch (err: unknown) {
        if (err instanceof Error && "status" in err) {
          const status = (err as { status: number }).status;
          if (status === 404) return null;
          if (status === 403) throw err;
        }
        throw err;
      }
    },

    async getUser(): Promise<{ login: string; id: number }> {
      const r = await octokit.rest.users.getAuthenticated();
      return { login: r.data.login, id: r.data.id };
    },

    async getUserByLogin(login: string): Promise<{ id: number; login: string }> {
      const r = await octokit.rest.users.getByUsername({ username: login });
      return { id: r.data.id, login: r.data.login };
    },

    getBotComments: async (prId: number, botLogin: string = BOT_LOGIN): Promise<IssueComment[]> => {
      const all = await client.getPrComments(prId);
      return all.filter((c) => c.user?.login === botLogin);
    },

    findBotComment: async (prId: number, botLogin: string = BOT_LOGIN): Promise<IssueComment | null> => {
      const comments = await client.getBotComments(prId, botLogin);
      if (comments.length === 0) return null;
      return comments[comments.length - 1] ?? null;
    },

    syncLabels: async (prId: number, desired: string[], current: string[]): Promise<void> => {
      const desiredSet = new Set(desired);
      const currentSet = new Set(current);

      const toAdd = [...desiredSet].filter((l) => !currentSet.has(l));
      const toRemove = [...currentSet].filter((l) => !desiredSet.has(l));

      const ops: Promise<void>[] = [];
      if (toAdd.length > 0) ops.push(client.addLabels(prId, toAdd));
      if (toRemove.length > 0) ops.push(client.removeLabels(prId, toRemove));

      await Promise.all(ops);
    },

    findPrFromHeadRef: async (headRef: string): Promise<PullRequestSummary> => {
      const query = `type:pr head:${headRef} repo:${REPO.OWNER}/${REPO.NAME}`;
      const results = await client.searchPulls(query);
      if (results.length === 0) {
        throw new Error(`No PR found for head ref: ${headRef}`);
      }
      return results[0]!;
    },

    async getArtifactsFromWorkflow(runId: number): Promise<Artifact[]> {
      const allArtifacts = await octokit.paginate(
        octokit.rest.actions.listWorkflowRunArtifacts,
        {
          owner: REPO.OWNER,
          repo: REPO.NAME,
          run_id: runId,
        },
      );
      return allArtifacts.map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size_in_bytes,
        archive_download_url: a.archive_download_url,
      }));
    },

    async createReview(prNumber: number, opts: CreateReviewOptions): Promise<CreateReviewResult> {
      const r = await octokit.rest.pulls.createReview({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        pull_number: prNumber,
        commit_id: opts.commitId,
        body: opts.body,
        event: opts.event,
        comments: opts.comments.map((c) => ({
          path: c.path,
          ...(c.line != null ? { line: c.line } : {}),
          ...(c.side ? { side: c.side === "LEFT" ? "LEFT" : "RIGHT" } : {}),
          body: c.body,
        })),
        request: { retries: 0 },
      });
      const data = r.data as { id: number; body: string };
      return { id: data.id, body: data.body ?? "" };
    },

    async listReviewComments(prNumber: number, reviewId?: number): Promise<ReviewComment[]> {
      const opts: Record<string, unknown> = {
        owner: REPO.OWNER,
        repo: REPO.NAME,
        pull_number: prNumber,
        per_page: 100,
      };
      if (reviewId != null) opts.review_id = reviewId;
      const r = await octokit.rest.pulls.listReviewComments(opts as Parameters<typeof octokit.rest.pulls.listReviewComments>[0]);
      return r.data.map((c: Record<string, unknown>) => ({
        id: c.id as number,
        body: (c.body as string) ?? "",
        path: (c.path as string) ?? "",
        line: c.line as number | undefined,
        side: (c.side as "LEFT" | "RIGHT" | undefined) ?? undefined,
        user: c.user ? { login: (c.user as Record<string, unknown>).login as string, id: (c.user as Record<string, unknown>).id as number } : null,
        createdAt: (c.created_at as string) ?? "",
        replyTo: c.in_reply_to_id as number | undefined,
        pullRequestReviewId: c.pull_request_review_id as number | undefined,
      }));
    },

    async createReviewCommentReply(prNumber: number, body: string, commentId: number): Promise<ReviewComment> {
      const r = await octokit.rest.pulls.createReplyForReviewComment({
        owner: REPO.OWNER,
        repo: REPO.NAME,
        pull_number: prNumber,
        body,
        comment_id: commentId,
        request: { retries: 0 },
      });
      const c = r.data as Record<string, unknown>;
      return {
        id: c.id as number,
        body: (c.body as string) ?? "",
        path: (c.path as string) ?? "",
        line: c.line as number | undefined,
        side: (c.side as "LEFT" | "RIGHT" | undefined) ?? undefined,
        user: c.user ? { login: (c.user as Record<string, unknown>).login as string, id: (c.user as Record<string, unknown>).id as number } : null,
        createdAt: (c.created_at as string) ?? "",
        replyTo: c.in_reply_to_id as number | undefined,
        pullRequestReviewId: c.pull_request_review_id as number | undefined,
      };
    },
  };

  return client;
}
