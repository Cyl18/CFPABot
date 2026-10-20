import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CheckReport } from "../../shared/api.ts";
import { env } from "../env.ts";
import type { GhComment } from "../github/client.ts";
import { gh } from "../github/client.ts";
import { httpStatus } from "../github/mappers.ts";
import { logger } from "../log.ts";
import { checkReportPath, paths } from "../paths.ts";
import { readJson, writeJson } from "../store.ts";
import { buildCheckComment } from "./check-comment.ts";
import { collectChecks } from "./checks.ts";
import { buildDiffComment, loadPrContext, loadWorkspaceData } from "./collect.ts";
import { collectMods } from "./mods-view.ts";
import { collectPacker } from "./packer.ts";
import {
  assembleComment,
  CRITICAL_FAILURE,
  CYBOT_MARKER,
  DIFF_EXCEPTION,
  messageOf,
  PIC,
  RELOAD_LINE,
  type CommentSections,
} from "./render.ts";

const checkItemSchema = z.object({
  level: z.enum(["error", "warn", "info", "ok"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  unit: z.string().optional(),
});

const modFileSchema = z.object({
  slug: z.string(),
  namespace: z.string(),
  version: z.string(),
  provider: z.enum(["curseforge", "modrinth"]).optional(),
  fileName: z.string().optional(),
  fetchedAt: z.string().optional(),
  status: z.enum(["ok", "mismatch", "extra", "unavailable"]),
  note: z.string().optional(),
  missing: z.array(z.string()).default([]),
  extra: z.array(z.string()).default([]),
  changed: z.array(z.string()).default([]),
});

const checkReportSchema = z.object({
  prNumber: z.number(),
  headSha: z.string(),
  generatedAt: z.string(),
  items: z.array(checkItemSchema),
  modFiles: z.array(modFileSchema).default([]),
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
const packerWanted = new Set<number>();

function statePath(prNumber: number): string {
  return join(paths.state, "comments", `${prNumber}.json`);
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

async function safeSegment(fn: () => Promise<string>, fallback: (err: unknown) => string): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    log.error("段更新失败", { error: err });
    return fallback(err);
  }
}

export async function getCheckReport(prNumber: number): Promise<CheckReport | null> {
  const state = await readJson(statePath(prNumber), stateSchema);
  return state?.report ?? null;
}

export function isRefreshing(prNumber: number): boolean {
  return running.has(prNumber);
}

export function refreshInfoComment(
  prNumber: number,
  opts?: { force?: boolean; refreshPacker?: boolean },
): Promise<void> {
  if (opts?.force) forced.add(prNumber);
  if (opts?.refreshPacker) packerWanted.add(prNumber);
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
    const refreshPacker = packerWanted.delete(prNumber);
    try {
      await updateOnce(prNumber, { force, refreshPacker });
    } catch (err) {
      log.error("刷新信息评论失败", { pr: prNumber, error: err });
    }
    if (!dirty.has(prNumber)) break;
  }
  running.delete(prNumber);
  if (dirty.has(prNumber)) void refreshInfoComment(prNumber);
}

async function updateOnce(prNumber: number, opts: { force: boolean; refreshPacker: boolean }): Promise<void> {
  const ctx = await loadPrContext(prNumber);
  const state = (await readJson(statePath(prNumber), stateSchema)) ?? emptyState(prNumber);
  const hasProjectFiles = ctx.files.some((file) => file.path.startsWith("projects/"));
  if (!opts.force && state.packer === "" && !hasProjectFiles) return;

  if (opts.force) await rm(checkReportPath(prNumber, ctx.pull.headSha), { force: true });

  const comments = await gh.listComments(prNumber);
  const botComments = comments.filter(isBotComment);
  if (botComments.length > 1) {
    for (const comment of botComments) await gh.updateComment(comment.id, CRITICAL_FAILURE);
    log.warn("发现多个 Bot 评论，已全部标记", { pr: prNumber, count: botComments.length });
    return;
  }
  let commentId = botComments[0]?.id ?? state.commentId;
  if (commentId === null) {
    const created = await gh.createComment(prNumber, `${CYBOT_MARKER}\n正在更新数据...`);
    commentId = created.id;
  }
  try {
    await gh.updateComment(commentId, assembleComment(sectionsOf(state), "preview", env.PUBLIC_URL));
  } catch (err) {
    log.warn("更新预览失败", { pr: prNumber, commentId, error: err });
  }

  const data = await loadWorkspaceData(ctx);
  const mods = await safeSegment(
    () => collectMods(ctx.files, prNumber, env.PUBLIC_URL),
    (err) => `⚠ 更新模组列表出错: ${messageOf(err)}`,
  );
  const packer = opts.refreshPacker
    ? await safeSegment(
        async () => collectPacker(await gh.getPull(prNumber), ctx.files),
        (err) => `⚠ 更新编译 artifacts 出错: ${messageOf(err)}`,
      )
    : state.packer;

  let checks: string;
  let report: CheckReport | null;
  const skipChecks = !opts.force && state.checks !== "" && (await Bun.file(checkReportPath(prNumber, ctx.pull.headSha)).exists());
  if (skipChecks) {
    checks = state.checks;
    report = state.report;
  } else {
    const items = await collectChecks(prNumber, ctx, data).catch((err: unknown) => {
      log.error("检查项收集失败", { pr: prNumber, error: err });
      return null;
    });
    if (items !== null) for (const label of items.extraLabels) await gh.addLabels(prNumber, [label]);
    const comment = await safeSegment(
      () => buildCheckComment(ctx, env.PUBLIC_URL),
      (err) => `⚠ 检查出错: ${messageOf(err)}`,
    );
    checks = comment.trim() !== "" ? comment : state.checks;
    report = items?.report ?? state.report;
  }

  const diffs = await safeSegment(
    () => buildDiffComment(ctx.pull, ctx.files, env.PUBLIC_URL),
    () => `${DIFF_EXCEPTION}\n`,
  );

  const next: CommentState = {
    prNumber,
    commentId,
    mods,
    packer,
    checks,
    diffs,
    report,
  };
  await writeJson(statePath(prNumber), next);

  const final = assembleComment(sectionsOf(next), "final", env.PUBLIC_URL);
  try {
    await gh.updateComment(commentId, final);
  } catch (err) {
    if (httpStatus(err) !== 422) throw err;
    const url = await gh.createGist(`pr-${prNumber}-bot`, `pr-${prNumber}-bot.md`, final.slice(`${CYBOT_MARKER}\n`.length));
    await gh.updateComment(commentId, `${CYBOT_MARKER}\n${PIC}嘻嘻，内容过长！已经上传到了 <${url}>\n\n${RELOAD_LINE}`);
  }
}
