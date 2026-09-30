import { z } from "zod";
import { agent } from "../agent/index.ts";
import { env, repo } from "../env.ts";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { mirror } from "../mirror.ts";
import { prdata } from "../prdata.ts";
import { runCommands } from "./commands.ts";
import { getCheckReport, refreshInfoComment } from "./info-comment.ts";
import { labelCheck, syncLabels } from "./labels.ts";
import { autoApprovePacker, PACKER_WORKFLOW_NAME } from "./packer.ts";
import { drainPending, track } from "./pending.ts";
import { CYBOT_MARKER } from "./render.ts";

export { getCheckReport, refreshInfoComment };

const log = logger("bot");

const repoSchema = z.object({ repository: z.object({ full_name: z.string() }).nullish() });

const pullRequestSchema = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({ head: z.object({ sha: z.string() }) }),
});

const issueCommentSchema = z.object({
  action: z.string(),
  issue: z.object({ number: z.number(), html_url: z.string(), pull_request: z.unknown().optional() }),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string(), id: z.number(), type: z.string().optional() }),
  }),
});

const workflowRunSchema = z.object({
  workflow: z.object({ name: z.string() }),
  workflow_run: z.object({
    event: z.string(),
    head_branch: z.string(),
    head_repository: z.object({ owner: z.object({ login: z.string() }) }).nullish(),
    pull_requests: z.array(z.object({ number: z.number() })).optional(),
  }),
});

const pushSchema = z.object({ ref: z.string() });

export async function drain(): Promise<void> {
  await drainPending();
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`步骤执行失败: ${name}`, { error: err });
  }
}

async function refreshPull(prNumber: number, staleSha: string | null, refreshPacker: boolean): Promise<void> {
  await step("prdata.refresh", () => prdata.refresh(prNumber));
  if (staleSha) await step("agent.markStale", () => agent.markStale(prNumber, staleSha));
  await step("info-comment", () => refreshInfoComment(prNumber, { refreshPacker }));
  await step("labels", () => syncLabels(prNumber));
  await step("label-check", () => labelCheck(prNumber));
  await step("packer", async () => {
    const { pull, files } = await prdata.files(prNumber);
    await autoApprovePacker(pull, files);
  });
}

async function onPullRequest(payload: unknown): Promise<void> {
  const parsed = pullRequestSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn("pull_request 负载无效", { issues: parsed.error.issues.length });
    return;
  }
  const { action, number, pull_request } = parsed.data;
  if (action === "opened" || action === "reopened" || action === "synchronize") {
    track(
      refreshPull(
        number,
        action === "synchronize" ? pull_request.head.sha : null,
        action !== "opened",
      ),
    );
    return;
  }
  if (action === "edited") {
    track(
      (async () => {
        await step("labels", () => syncLabels(number));
        await step("label-check", () => labelCheck(number));
      })(),
    );
    return;
  }
  if (action === "labeled" || action === "unlabeled") {
    track(step("label-check", () => labelCheck(number)));
    return;
  }
  if (action === "closed") {
    track(step("prdata.refresh", () => prdata.refresh(number)));
  }
}

async function onIssueComment(payload: unknown): Promise<void> {
  const parsed = issueCommentSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn("issue_comment 负载无效", { issues: parsed.error.issues.length });
    return;
  }
  const { action, issue, comment } = parsed.data;
  if (!issue.pull_request && !issue.html_url.includes("pull")) return;
  if (action === "created") {
    if (comment.user.type === "Bot" || comment.user.login === env.BOT_LOGIN) return;
    track(
      runCommands({
        prNumber: issue.number,
        body: comment.body,
        login: comment.user.login,
        userId: comment.user.id,
      }),
    );
    return;
  }
  if (action !== "edited") return;
  if (!comment.body.startsWith(CYBOT_MARKER)) return;
  if (comment.user.login !== env.BOT_LOGIN && comment.user.login !== "Cyl18-Bot") return;
  if (!comment.body.includes("- [x] 🔄") && !comment.body.includes("- [x] 🔃")) return;
  track(refreshInfoComment(issue.number, { force: true, refreshPacker: true }));
}

async function onWorkflowRun(payload: unknown): Promise<void> {
  const parsed = workflowRunSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn("workflow_run 负载无效", { issues: parsed.error.issues.length });
    return;
  }
  const run = parsed.data.workflow_run;
  if (parsed.data.workflow.name !== PACKER_WORKFLOW_NAME || run.event !== "pull_request") return;
  track(
    (async () => {
      try {
        const first = run.pull_requests?.[0];
        const owner = run.head_repository?.owner.login;
        const pull = first
          ? await gh.getPull(first.number)
          : owner
            ? await gh.findPullByHead(`${owner}:${run.head_branch}`)
            : null;
        if (!pull) return;
        const { files } = await prdata.files(pull.number);
        await autoApprovePacker(pull, files);
        await refreshInfoComment(pull.number, { refreshPacker: true });
      } catch (err) {
        log.error("处理 workflow_run 失败", { error: err });
      }
    })(),
  );
}

async function onPush(payload: unknown): Promise<void> {
  const parsed = pushSchema.safeParse(payload);
  if (!parsed.success) return;
  if (parsed.data.ref !== `refs/heads/${repo.defaultBranch}`) return;
  track(
    mirror.sync().then(
      () => undefined,
      (err: unknown) => log.error("同步镜像失败", { error: err }),
    ),
  );
}

export async function handleWebhook(event: string, payload: unknown): Promise<void> {
  try {
    const common = repoSchema.safeParse(payload);
    if (!common.success) return;
    if (common.data.repository?.full_name !== repo.fullName) return;
    switch (event) {
      case "pull_request":
        await onPullRequest(payload);
        return;
      case "issue_comment":
        await onIssueComment(payload);
        return;
      case "workflow_run":
        await onWorkflowRun(payload);
        return;
      case "push":
        await onPush(payload);
        return;
      default:
        return;
    }
  } catch (err) {
    log.error("处理 webhook 失败", { event, error: err });
  }
}
