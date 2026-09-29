import type { PrFile } from "../../shared/api.ts";
import type { GhPull } from "../github/client.ts";
import { gh } from "../github/client.ts";
import { logger } from "../log.ts";

export const PACKER_WORKFLOW_NAME = "PR Packer";
export const PACKER_CLOSED = ":milky_way: PR 已经关闭。";

const log = logger("bot/packer");

export function isSourcePath(path: string): boolean {
  return path.startsWith(".github") || path.startsWith("src");
}

export function touchesSource(files: PrFile[]): boolean {
  return files.some((file) => isSourcePath(file.path) || (file.previousPath !== undefined && isSourcePath(file.previousPath)));
}

export async function autoApprovePacker(pull: GhPull, files: PrFile[]): Promise<void> {
  const run = (await gh.listPackerRuns(pull.headSha))[0];
  if (!run || run.conclusion !== "action_required") return;
  if (touchesSource(files)) return;
  await gh.approveRun(run.id);
  log.info("已自动批准打包器", { pr: pull.number, run: run.id });
}

export async function collectPacker(pull: GhPull, files: PrFile[]): Promise<{ lines: string[] }> {
  const run = (await gh.listPackerRuns(pull.headSha))[0];
  const open = pull.state === "open";
  if (!run) return { lines: [open ? "⚠ 暂时没有检测到 workflow." : PACKER_CLOSED] };
  if (run.conclusion === "action_required") {
    if (touchesSource(files)) {
      return { lines: ["ℹ 由于修改了源代码，不能自动批准执行 PR Packer."] };
    }
    await gh.approveRun(run.id);
    return { lines: ["ℹ 已经自动批准打包器执行，可能需要等待一段时间。"] };
  }
  if (run.status === "queued" || run.status === "in_progress") {
    return { lines: [open ? ":milky_way: 打包器正在执行, 请耐心等待。" : PACKER_CLOSED] };
  }
  const artifacts = await gh.listArtifacts(run.id);
  if (artifacts.length === 0) return { lines: ["ℹ 此 PR 没有更改语言文件或者 PR-Packer 出现了问题。"] };
  return { lines: [":floppy_disk: 基于此 PR 所打包的资源包：", ...artifacts.map((a) => `- [${a.name}.zip](${a.url})`)] };
}
