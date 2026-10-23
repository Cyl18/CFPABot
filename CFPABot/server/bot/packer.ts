import type { PrFile } from "@cfpa/contracts/api";
import { repo } from "../env.ts";
import type { GhPull } from "../github/client.ts";
import { botWritesEnabled, gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { BRANCH_NOT_MAIN, Lines, MAINTAINER_IMAGE, MAINTAINER_WARNING, messageOf } from "./render.ts";

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
  if (!botWritesEnabled()) return;
  const run = (await gh.listPackerRuns(pull.headSha))[0];
  if (!run || run.conclusion !== "action_required") return;
  if (touchesSource(files)) return;
  await gh.approveRun(run.id);
  log.info("已自动批准打包器", { pr: pull.number, run: run.id });
}

export async function collectPacker(pull: GhPull, files: PrFile[]): Promise<string> {
  const sb = new Lines();
  try {
    if (pull.baseRef !== repo.defaultBranch) {
      sb.line(BRANCH_NOT_MAIN);
      sb.line();
      sb.line("---");
      sb.line();
    }
    if (pull.maintainerCanModify === false && pull.headRepoOwner !== repo.owner && pull.state === "open") {
      sb.line(MAINTAINER_WARNING);
      sb.line(MAINTAINER_IMAGE);
      sb.line();
      sb.line("---");
      sb.line();
    }
    const run = (await gh.listPackerRuns(pull.headSha))[0];
    const open = pull.state === "open";
    if (!run) {
      sb.line(open ? "⚠ 暂时没有检测到 workflow." : PACKER_CLOSED);
      return sb.text();
    }
    if (run.conclusion === "action_required") {
      if (touchesSource(files)) {
        sb.line("ℹ 由于修改了源代码，不能自动批准执行 PR Packer。");
        return sb.text();
      }
      if (botWritesEnabled()) {
        await gh.approveRun(run.id);
        sb.line("ℹ 已经自动批准打包器执行，可能需要等待一段时间。");
      }
      return sb.text();
    }
    if (run.status === "queued" || run.status === "in_progress") {
      sb.line(open ? ":milky_way: 打包器正在执行, 请耐心等待。" : PACKER_CLOSED);
      return sb.text();
    }
    const artifacts = await gh.listArtifacts(run.id);
    if (artifacts.length === 0) {
      sb.line("ℹ 此 PR 没有更改语言文件或者 PR-Packer 出现了问题。");
      return sb.text();
    }
    sb.line(":floppy_disk: 基于此 PR 所打包的资源包：");
    for (const artifact of artifacts) sb.line(`- [${artifact.name}.zip](${artifact.url})`);
    return sb.text();
  } catch (err) {
    log.error("更新编译 artifacts 出错", { error: err });
    sb.line(`⚠ 更新编译 artifacts 出错: ${messageOf(err)}`);
    return sb.text();
  }
}
