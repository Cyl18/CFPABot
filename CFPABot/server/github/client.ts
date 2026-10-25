import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling, type ThrottlingOptions } from "@octokit/plugin-throttling";
import { env, isDev, repo } from "../env.ts";
import { HttpError } from "../errors.ts";
import { logger } from "../log.ts";
import { ttlCache } from "../ttl.ts";
import { asRecord, httpStatus, mapComment, mapFile, mapPull, mapReviewComment, mapRun } from "./mappers.ts";
import type { GhPull, GitHubClient } from "./types.ts";

export type { GhArtifact, GhComment, GhFile, GhIssue, GhPull, GhReviewComment, GhReviewSummary, GhRun, GitHubClient } from "./types.ts";

const log = logger("github");
const USER_AGENT = "CFPAAgent2 (github.com/CFPAOrg)";
const PLUGIN_OCTOKIT = Octokit.plugin(retry, throttling);
const PACKER_WORKFLOW = "pr-packer.yml";
const FILE_PAGE_SIZE = 100;

function readPrivateKey(): string | null {
  try {
    return readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  } catch {
    return null;
  }
}

const appConfig =
  env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID
    ? (() => {
        const privateKey = readPrivateKey();
        if (!privateKey) return null;
        return { appId: env.GITHUB_APP_ID, privateKey, installationId: env.GITHUB_APP_INSTALLATION_ID };
      })()
    : null;

// 开发环境优先用个人 token 拉 GitHub，避免和线上 bot 共用 installation 配额。
const devToken = isDev ? (env.DEV_GITHUB_TOKEN ?? null) : null;

const mode: GitHubClient["mode"] = devToken ? "dev" : appConfig ? "app" : env.GITHUB_PAT ? "pat" : "anonymous";

function throttleOptions(): ThrottlingOptions {
  return {
    onRateLimit: (retryAfter, options, _octokit, retryCount) => {
      log.warn("GitHub 速率限制", { method: options.method, url: options.url, retryAfter, retryCount });
      return retryCount < 2 && retryAfter <= 60;
    },
    onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
      log.warn("GitHub 二级速率限制", {
        method: options.method,
        url: options.url,
        retryAfter,
        retryCount,
      });
      return retryCount < 2 && retryAfter <= 60;
    },
  };
}

const octokit = devToken
  ? new PLUGIN_OCTOKIT({ userAgent: USER_AGENT, throttle: throttleOptions(), auth: devToken })
  : appConfig
    ? new PLUGIN_OCTOKIT({
        userAgent: USER_AGENT,
        throttle: throttleOptions(),
        authStrategy: createAppAuth,
        auth: appConfig,
      })
    : env.GITHUB_PAT
      ? new PLUGIN_OCTOKIT({ userAgent: USER_AGENT, throttle: throttleOptions(), auth: env.GITHUB_PAT })
      : new PLUGIN_OCTOKIT({ userAgent: USER_AGENT, throttle: throttleOptions() });

const patOctokit = env.GITHUB_PAT
  ? new PLUGIN_OCTOKIT({ userAgent: USER_AGENT, throttle: throttleOptions(), auth: env.GITHUB_PAT })
  : null;

export type GhOctokit = InstanceType<typeof PLUGIN_OCTOKIT>;

export const serverGraphql = octokit;

export function userGraphql(token: string): GhOctokit {
  return new PLUGIN_OCTOKIT({ userAgent: USER_AGENT, throttle: throttleOptions(), auth: token });
}

export function isRateLimited(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 429) return true;
  return status === 403 && err instanceof Error && /rate limit/i.test(err.message);
}

/** 只有 App 身份写出来的评论、标签、check run 才属于机器人自己，其他身份一律暂停。 */
export function botWritesEnabled(): boolean {
  return mode === "app";
}

export function assertBotWrites(): void {
  if (!botWritesEnabled()) {
    throw new HttpError(403, "当前 GitHub 身份不是机器人，已暂停评论 / 审查写入。", "bot_writes_disabled");
  }
}

log.info("GitHub 客户端已初始化", { mode, repo: repo.fullName });
if (!botWritesEnabled()) log.info("当前不是机器人身份，评论 / 标签 / check run 写入已暂停", { mode });

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const fileCache = ttlCache<string>(6 * 60 * 60 * 1000, 200);

async function fetchFileText(path: string, ref: string): Promise<string | null> {
  let data: unknown;
  try {
    const r = await octokit.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.name,
      path: path.split("/").map((segment) => encodeURIComponent(segment)).join("/"),
      ref,
    });
    data = r.data;
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw err;
  }
  const record = asRecord(data);
  if (!record) return null;
  if (typeof record.content === "string" && record.content.length > 0) {
    const text = Buffer.from(record.content, "base64").toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
  const downloadUrl = record.download_url;
  if (typeof downloadUrl !== "string" || !downloadUrl) return null;
  const res = await fetch(downloadUrl, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) return null;
  const text = await res.text();
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export const gh: GitHubClient = {
  mode,

  async getPull(n) {
    const r = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.name, pull_number: n });
    return mapPull(r.data);
  },

  async listPulls(state, opts) {
    const maxPages = opts?.maxPages ?? (state === "open" ? Number.POSITIVE_INFINITY : 1);
    const pulls: GhPull[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.name,
        state,
        sort: state === "closed" ? "updated" : "created",
        direction: "desc",
        per_page: FILE_PAGE_SIZE,
        page,
      });
      for (const item of r.data) pulls.push(mapPull(item));
      if (r.data.length < FILE_PAGE_SIZE) break;
    }
    return pulls;
  },

  async findPullByHead(ownerColonBranch) {
    const r = await octokit.rest.search.issuesAndPullRequests({
      q: `type:pr head:${ownerColonBranch} repo:${repo.fullName}`,
      per_page: 5,
    });
    const hit = r.data.items.find((item) => "pull_request" in item && item.pull_request != null);
    if (!hit) return null;
    return gh.getPull(hit.number);
  },

  async listPullFiles(n) {
    const all = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: repo.owner,
      repo: repo.name,
      pull_number: n,
      per_page: FILE_PAGE_SIZE,
    });
    return all.slice(0, 3000).map(mapFile);
  },

  async getFile(path, ref) {
    const key = `${ref}\u0000${path}`;
    const cached = fileCache.get(key);
    if (cached !== undefined) return cached;
    const text = await fetchFileText(path, ref);
    // 分支名会移动，只有 SHA 指向的内容可以长期缓存。
    if (text !== null && SHA_PATTERN.test(ref)) fileCache.set(key, text);
    return text;
  },

  async getFiles(paths, ref) {
    const texts = new Map<string, string>();
    const load = async (path: string) => {
      try {
        const encoded = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
        const res = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${encoded}`, {
          headers: { "user-agent": USER_AGENT },
        });
        if (res.status === 404) return;
        if (!res.ok) throw new Error(`raw.githubusercontent ${res.status}`);
        const text = await res.text();
        texts.set(path, text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch {
        const text = await gh.getFile(path, ref);
        if (text !== null) texts.set(path, text);
      }
    };
    await Promise.all(paths.map(load));
    return texts;
  },

  async listComments(n) {
    const all = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: repo.owner,
      repo: repo.name,
      issue_number: n,
      per_page: FILE_PAGE_SIZE,
    });
    return all.map(mapComment);
  },

  async createComment(n, body) {
    const r = await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: n,
      body,
      request: { retries: 0 },
    });
    return mapComment(r.data);
  },

  async updateComment(id, body) {
    await octokit.rest.issues.updateComment({
      owner: repo.owner,
      repo: repo.name,
      comment_id: id,
      body,
      request: { retries: 0 },
    });
  },

  async getIssue(n) {
    const r = await octokit.rest.issues.get({ owner: repo.owner, repo: repo.name, issue_number: n });
    const data = r.data;
    return {
      number: data.number,
      title: data.title,
      state: data.state === "open" ? ("open" as const) : ("closed" as const),
      author: data.user?.login ?? "ghost",
      labels: data.labels
        .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
        .filter((label) => label.length > 0),
      body: data.body ?? "",
      htmlUrl: data.html_url,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  },

  async search(q, type) {
    const r = await octokit.rest.search.issuesAndPullRequests({
      q: `${q} repo:${repo.fullName} type:${type === "pr" ? "pr" : "issue"}`,
      per_page: 30,
    });
    return r.data.items.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      author: item.user?.login ?? "ghost",
      updatedAt: item.updated_at,
      htmlUrl: item.html_url,
    }));
  },

  async listReviews(n) {
    const all = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: repo.owner,
      repo: repo.name,
      pull_number: n,
      per_page: FILE_PAGE_SIZE,
    });
    return all.map((review) => ({
      id: review.id,
      author: review.user?.login ?? "ghost",
      body: review.body ?? "",
      state: review.state,
      htmlUrl: review.html_url,
    }));
  },

  async updateReviewComment(id, body) {
    await octokit.rest.pulls.updateReviewComment({
      owner: repo.owner,
      repo: repo.name,
      comment_id: id,
      body,
      request: { retries: 0 },
    });
  },

  async listReviewComments(n) {
    const all = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: repo.owner,
      repo: repo.name,
      pull_number: n,
      per_page: FILE_PAGE_SIZE,
    });
    return all.map(mapReviewComment);
  },

  async createReview(n, input) {
    const r = await octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.name,
      pull_number: n,
      commit_id: input.commitId,
      body: input.body,
      event: input.event,
      comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      request: { retries: 0 },
    });
    return { id: r.data.id, htmlUrl: r.data.html_url };
  },

  async addLabels(n, labels) {
    await octokit.rest.issues.addLabels({
      owner: repo.owner,
      repo: repo.name,
      issue_number: n,
      labels,
      request: { retries: 0 },
    });
  },

  async removeLabel(n, label) {
    try {
      await octokit.rest.issues.removeLabel({
        owner: repo.owner,
        repo: repo.name,
        issue_number: n,
        name: label,
        request: { retries: 0 },
      });
    } catch (err) {
      if (httpStatus(err) !== 404) throw err;
    }
  },

  async createCheckRun(input) {
    await octokit.rest.checks.create({
      owner: repo.owner,
      repo: repo.name,
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      output: { title: input.title, summary: input.summary },
      request: { retries: 0 },
    });
  },

  async listPackerRuns(headSha) {
    const r = await octokit.rest.actions.listWorkflowRuns({
      owner: repo.owner,
      repo: repo.name,
      workflow_id: PACKER_WORKFLOW,
      head_sha: headSha,
      event: "pull_request",
      per_page: 20,
    });
    return (r.data.workflow_runs ?? [])
      .map(mapRun)
      .filter((run) => run.name.includes("PR Packer"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async listArtifacts(runId) {
    const all = await octokit.paginate(octokit.rest.actions.listWorkflowRunArtifacts, {
      owner: repo.owner,
      repo: repo.name,
      run_id: runId,
      per_page: FILE_PAGE_SIZE,
    });
    return all.map((a) => ({
      id: a.id,
      name: a.name,
      expired: a.expired,
      url: a.archive_download_url.replace("/zip", ".zip").replace("api.github.com/repos", "nightly.link"),
    }));
  },

  async approveRun(runId) {
    await octokit.rest.actions.approveWorkflowRun({
      owner: repo.owner,
      repo: repo.name,
      run_id: runId,
      request: { retries: 0 },
    });
  },

  async isCollaborator(login) {
    try {
      await octokit.rest.repos.checkCollaborator({ owner: repo.owner, repo: repo.name, username: login });
      return true;
    } catch (err) {
      const status = httpStatus(err);
      if (status === 404) return false;
      if (status === 403 && err instanceof Error && err.message.includes("Must have push access")) return false;
      throw err;
    }
  },

  async getUser(login) {
    try {
      const r = await octokit.rest.users.getByUsername({ username: login });
      return { login: r.data.login, id: r.data.id };
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      throw err;
    }
  },

  async createGist(description, fileName, content) {
    if (!patOctokit) throw new Error("未配置 GITHUB_PAT");
    const r = await patOctokit.rest.gists.create({
      description,
      files: { [fileName]: { content } },
      public: false,
      request: { retries: 0 },
    });
    if (!r.data.html_url) throw new Error("创建 Gist 失败：响应缺少 html_url");
    return r.data.html_url;
  },

  async rateLimit() {
    const r = await octokit.rest.rateLimit.get();
    const core = r.data.rate;
    return { remaining: core.remaining, limit: core.limit, resetAt: new Date(core.reset * 1000).toISOString() };
  },

  async gitToken() {
    if (devToken) return devToken;
    if (appConfig) {
      const auth = await createAppAuth(appConfig)({ type: "installation" });
      return auth.token;
    }
    return env.GITHUB_PAT ?? null;
  },
};
