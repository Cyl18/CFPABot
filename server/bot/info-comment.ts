import { join } from "node:path";
import { z } from "zod";
import type { CheckReport } from "../../shared/api.ts";
import { env } from "../env.ts";
import type { GhComment } from "../github/client.ts";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { readJson, writeJson } from "../store.ts";
import { collectChecks } from "./checks.ts";
import { collectDiffs, collectWarnings, loadPrContext, loadWorkspaceData } from "./collect.ts";
import { collectMods } from "./mods-view.ts";
import { collectPacker } from "./packer.ts";
import {
  assembleComment,
  CRITICAL_FAILURE,
  CYBOT_MARKER,
  DIFF_DROPPED,
  renderChecks,
  renderDiffs,
  renderMods,
  renderPacker,
  type CommentSections,
  type RenderContext,
} from "./render.ts";

const MAX_COMMENT_CHARS = 60000;

const checkItemSchema = z.object({
  level: z.enum(["error", "warn", "info", "ok"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

const checkReportSchema = z.object({
  prNumber: z.number(),
  headSha: z.string(),
  generatedAt: z.string(),
  items: z.array(checkItemSchema),
});

const stateSchema = z.object({
  prNumber: z.number(),
  commentId: z.number().nullable(),
  mods: z.string(),
  packer: z.string(),
  checks: z.string(),
  diffs: z.string(),
  report: checkReportSchema.nullable(),
});

type CommentState = z.infer<typeof stateSchema>;

const log = logger("bot/info-comment");

const running = new Map<number, Promise<void>>();
const dirty = new Set<number>();
const forced = new Set<number>();

function statePath(prNumber: number): string {
  return join(paths.state, "comments", `${prNumber}.json`);
}

function renderContext(prNumber: number): RenderContext {
  return { publicUrl: env.PUBLIC_URL, prNumber };
}

function sectionsOf(state: CommentState): CommentSections {
  return { mods: state.mods, packer: state.packer, checks: state.checks, diffs: state.diffs };
}

function isBotComment(comment: GhComment): boolean {
  if (!comment.body.startsWith(CYBOT_MARKER)) return false;
  return comment.author === env.BOT_LOGIN || comment.author === "Cyl18-Bot";
}

function emptyState(prNumber: number): CommentState {
  return { prNumber, commentId: null, mods: "", packer: "", checks: "", diffs: "", report: null };
}

export async function getCheckReport(prNumber: number): Promise<CheckReport | null> {
  const state = await readJson(statePath(prNumber), stateSchema);
  return state?.report ?? null;
}

export function refreshInfoComment(prNumber: number, opts?: { force?: boolean }): Promise<void> {
  if (opts?.force) forced.add(prNumber);
  dirty.add(prNumber);
  const current = running.get(prNumber);
  if (current) return current;
  const task = runLoop(prNumber);
  running.set(prNumber, task);
  return task;
}

async function runLoop(prNumber: number): Promise<void> {
  for (;;) {
    dirty.delete(prNumber);
    const force = forced.delete(prNumber);
    try {
      await updateOnce(prNumber, force);
    } catch (err) {
      log.error("刷新信息评论失败", { pr: prNumber, error: err });
    }
    if (!dirty.has(prNumber)) break;
  }
  running.delete(prNumber);
  if (dirty.has(prNumber)) void refreshInfoComment(prNumber);
}

async function updateOnce(prNumber: number, force: boolean): Promise<void> {
  const ctx = await loadPrContext(prNumber);
  const state = (await readJson(statePath(prNumber), stateSchema)) ?? emptyState(prNumber);
  const hasProjectFiles = ctx.files.some((file) => file.path.startsWith("projects/"));
  if (!force && state.packer.length === 0 && !hasProjectFiles) return;

  const comments = await gh.listComments(prNumber);
  const botComments = comments.filter(isBotComment);
  if (botComments.length > 1) {
    for (const comment of botComments) await gh.updateComment(comment.id, CRITICAL_FAILURE);
    log.warn("发现多个 Bot 评论，已全部标记", { pr: prNumber, count: botComments.length });
    return;
  }
  const warnings = collectWarnings(ctx.pull);
  let commentId = botComments[0]?.id ?? state.commentId;
  if (commentId !== null) {
    try {
      await gh.updateComment(commentId, assembleComment(sectionsOf(state), { warnings, updating: true }, renderContext(prNumber)));
    } catch (err) {
      log.warn("更新信息评论失败，将重新创建", { pr: prNumber, commentId, error: err });
      commentId = null;
    }
  }
  if (commentId === null) {
    const created = await gh.createComment(prNumber, `${CYBOT_MARKER}\n正在更新数据...`);
    commentId = created.id;
  }

  const data = await loadWorkspaceData(ctx);
  const [modsView, packerView, checks] = await Promise.all([
    collectMods(ctx.workspaces),
    collectPacker(ctx.pull, ctx.files),
    collectChecks(prNumber, ctx, data),
  ]);
  for (const label of checks.extraLabels) await gh.addLabels(prNumber, [label]);

  const next: CommentState = {
    prNumber,
    commentId,
    mods: renderMods(modsView, renderContext(prNumber)),
    packer: renderPacker(packerView),
    checks: renderChecks(checks.report),
    diffs: renderDiffs(collectDiffs(data, ctx.files), renderContext(prNumber)),
    report: checks.report,
  };
  await writeJson(statePath(prNumber), next);

  const final = assembleComment(sectionsOf(next), { warnings, updating: false }, renderContext(prNumber));
  if (final.length > MAX_COMMENT_CHARS) {
    const trimmed = assembleComment({ ...sectionsOf(next), diffs: DIFF_DROPPED }, { warnings, updating: false }, renderContext(prNumber));
    await gh.updateComment(commentId, trimmed.length > MAX_COMMENT_CHARS ? `${trimmed.slice(0, MAX_COMMENT_CHARS)}\n\n…` : trimmed);
    return;
  }
  await gh.updateComment(commentId, final);
}
