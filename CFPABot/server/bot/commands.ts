import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { PrFile } from "@cfpa/contracts/api";
import { agent } from "../agent/index.ts";
import { editJsonValues, insertJsonKeyAfter, normalizeLang, parseLang, sortLang } from "@cfpa/review-core/domain/langfile";
import { buildLangPath, langFormatFor, modRefOf } from "@cfpa/review-core/domain/path";
import { env, repo } from "../env.ts";
import { withWorkspace, type Workspace } from "../git.ts";
import { botWritesEnabled, gh } from "../github/client.ts";
import { logger } from "../log.ts";
import { mods } from "../mods/index.ts";
import { prdata } from "../prdata.ts";
import {
  COLLABORATOR_ONLY,
  COMMAND_NAMES,
  COMMANDS_NEEDING_REPO,
  OWNER_PERMISSION_DENIED,
  PERMISSION_DENIED,
  parseLines,
  permissionDecision,
  type CommandLine,
} from "./commands-parse.ts";
import { refreshInfoComment } from "./info-comment.ts";
import { track } from "./pending.ts";

const MAX_REPLY_CHARS = 32768;
const MAIN_BRANCH_PROTECTED = "⚠ 保护 main 分支，命令拒绝执行。";
const SECURITY_CHECK_FAILURE = "⚠ 安全检查错误：你所操作的目录不在工作目录下。";
const NO_WORKSPACE = "内部错误：缺少工作区。";

const log = logger("bot/commands");

class CommandError extends Error {}

export interface CommandRunInput {
  prNumber: number;
  body: string;
  login: string;
  userId: number;
}

function isRepoCommand(line: CommandLine): boolean {
  return COMMANDS_NEEDING_REPO[line.name] === true;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

async function moveTree(from: string, to: string): Promise<void> {
  const stage = await mkdtemp(join(dirname(from), ".cfpa-mv-"));
  try {
    for (const file of await walkFiles(from)) {
      const target = join(stage, relative(from, file));
      await mkdir(dirname(target), { recursive: true });
      await rename(file, target);
    }
    for (const file of await walkFiles(stage)) {
      const target = join(to, relative(stage, file));
      await mkdir(dirname(target), { recursive: true });
      await rename(file, target);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function zhFiles(files: PrFile[]): PrFile[] {
  return files.filter((file) => file.status !== "removed" && basename(file.path).includes("zh_"));
}

async function postReply(prNumber: number, login: string, lines: string[]): Promise<void> {
  if (!botWritesEnabled()) return;
  let body = lines.join("\n").trim();
  if (body.length === 0) return;
  if (body.length > MAX_REPLY_CHARS) {
    try {
      const url = await gh.createGist(`pr-${prNumber}-diff`, `pr-${prNumber}-diff.md`, body);
      body = `回复内容过长，已经上传至 <${url}>。`;
    } catch (err) {
      log.warn("上传 Gist 失败，改为截断回复", { error: err });
      body = `${body.slice(0, MAX_REPLY_CHARS)}\n\n…`;
    }
  }
  await gh.createComment(prNumber, `@${login} ${body}`);
}

export async function runCommands(input: CommandRunInput): Promise<void> {
  const lines = parseLines(input.body);
  if (lines.length === 0) return;
  const replies: string[] = [];
  let committed = false;
  const author = { login: input.login, id: input.userId };
  try {
    const pull = await gh.getPull(input.prNumber);
    const { files } = await prdata.files(input.prNumber);
    const isCollaborator = await gh.isCollaborator(input.login);
    const permission = permissionDecision({
      isCollaborator,
      isPrAuthor: pull.author === input.login,
      headOwnerIsAuthor: pull.headRepoOwner === input.login,
    });
    const needsRepo = lines.some(isRepoCommand);
    const depth = lines.some((line) => line.name === "revert" && line.args.length > 0) ? 0 : 3;

    const execute = async (ws: Workspace | null): Promise<void> => {
      for (const line of lines) {
        if (!COMMAND_NAMES.has(line.name)) continue;
        if (permission !== "allow") {
          replies.push(permission === "owner-denied" ? OWNER_PERMISSION_DENIED : PERMISSION_DENIED);
          continue;
        }
        if (COLLABORATOR_ONLY.has(line.name) && !isCollaborator) {
          replies.push(PERMISSION_DENIED);
          continue;
        }
        switch (line.name) {
          case "rename": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            if (line.args.some((arg) => arg.includes(".."))) throw new CommandError("¿");
            const from = line.args[0];
            const to = line.args[1];
            if (from === undefined || to === undefined) throw new CommandError("应该有两个参数。");
            const fromPath = ws.resolve(from);
            if (!(await Bun.file(fromPath).exists())) throw new CommandError("文件不存在。");
            const toPath = ws.resolve(to);
            await mkdir(dirname(toPath), { recursive: true });
            await rename(fromPath, toPath);
            committed ||= (await ws.commit(`mv ${line.rest.replaceAll('"', '\\"')}`, author)) !== null;
            break;
          }
          case "mv": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            if (line.args.some((arg) => arg.includes(".."))) throw new CommandError("¿");
            if (line.args.length !== 2) throw new CommandError("应该有两个参数。");
            const from = line.args[0];
            const to = line.args[1];
            if (from === undefined || to === undefined) throw new CommandError("应该有两个参数。");
            let fromDir: string;
            let toDir: string;
            try {
              fromDir = ws.resolve(from);
              toDir = ws.resolve(to);
            } catch {
              throw new CommandError(SECURITY_CHECK_FAILURE);
            }
            await mkdir(toDir, { recursive: true });
            await moveTree(fromDir, toDir);
            committed ||= (await ws.commit(`mv ${line.rest.replaceAll('"', '\\"')}`, author)) !== null;
            break;
          }
          case "update-en": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            const slug = line.args[0];
            const version = line.args[1];
            if (slug === undefined || version === undefined) throw new CommandError("应该有两个参数。");
            const format = langFormatFor(version);
            const info = await mods.resolve(slug);
            const modFile = info ? await mods.pickFile(info, version) : null;
            if (!info || !modFile) throw new CommandError(`⚠ 找不到模组: ${slug}-${version}。`);
            const jar = await mods.readJar(modFile);
            if (!jar) throw new CommandError(`ℹ 获取 ${slug} 模组语言文件失败。`);
            const candidates = jar.lang.filter((entry) => entry.locale === "en_us" && entry.format === format);
            if (candidates.length === 0) {
              replies.push("⚠ 更新失败：未找到对应的英文语言文件。");
              break;
            }
            if (candidates.length > 1) {
              replies.push("⚠ 更新失败：找到了多个语言文件。");
              break;
            }
            const source = candidates[0];
            if (!source) break;
            const targetPath = ws.resolve(buildLangPath(slug, version, source.domain, "en_us", format));
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, normalizeLang(source.content, format), "utf8");
            replies.push(`ℹ 更新语言文件完成；使用 ${modFile.fileName} 中的语言文件。`);
            committed ||= (await ws.commit(`Update en_us file for ${slug.replaceAll('"', '\\"')}`, author)) !== null;
            break;
          }
          case "replace": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            const from = line.args[0];
            const to = line.args[1];
            if (from === undefined || to === undefined) throw new CommandError("应该有两个参数。");
            for (const file of zhFiles(files)) {
              const path = ws.resolve(file.path);
              const content = await readFile(path, "utf8");
              if (file.path.endsWith("json")) {
                await writeFile(path, editJsonValues(content, (_key, value) => value.replaceAll(from, to)).content, "utf8");
              } else {
                await writeFile(path, content.replaceAll(from, to), "utf8");
              }
            }
            committed ||= (await ws.commit(`Replace '${from}' with '${to}'`, author)) !== null;
            break;
          }
          case "add-comment": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            const key = line.args[0];
            if (key === undefined || line.args.length < 2) throw new CommandError("应该大于2个参数。");
            const text = line.args.slice(1).join(" ");
            const newKey = `__comment.cpfa.${input.login.toLowerCase()}.${key}`;
            let hit = false;
            for (const file of zhFiles(files)) {
              if (!file.path.endsWith("json")) continue;
              const path = ws.resolve(file.path);
              const next = insertJsonKeyAfter(await readFile(path, "utf8"), key, newKey, text);
              if (next === null) continue;
              await writeFile(path, next, "utf8");
              hit = true;
            }
            if (!hit) throw new CommandError("没有找到对应的 key");
            committed ||= (await ws.commit("Add comment", author)) !== null;
            break;
          }
          case "add-co-author": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            const login = (line.args[0] ?? "").replace(/^@+/, "").trim();
            if (login.length === 0) throw new CommandError("应该有一个参数。");
            const user = await gh.getUser(login);
            if (!user) {
              replies.push("无法获取到指定用户。");
              break;
            }
            await ws.run([
              "commit",
              "--allow-empty",
              "-m",
              `别看我，我只是个协作\n\nCo-authored-by: ${user.login} <${user.id}+${user.login}@users.noreply.github.com>`,
            ]);
            committed = true;
            break;
          }
          case "revert": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            const hash = line.args[0]?.replaceAll('"', "") ?? "HEAD";
            await ws.run(["revert", "--no-edit", hash]);
            committed = true;
            break;
          }
          case "sort-keys": {
            if (!ws) throw new CommandError(NO_WORKSPACE);
            const file = line.args[0];
            if (file === undefined) throw new CommandError("应该有一个参数。");
            const path = ws.resolve(file);
            if (!(await Bun.file(path).exists())) {
              replies.push("⚠ 指定的文件不存在。");
              break;
            }
            const content = await readFile(path, "utf8");
            const format = file.endsWith(".json") ? "json" : file.endsWith(".lang") ? "lang" : null;
            if (format === null) {
              replies.push("⚠ 无法识别的文件。");
              break;
            }
            const parsed = parseLang(content, format);
            if (format === "json" && parsed.errors.length > 0) {
              replies.push(`⚠ 文件不是合法 JSON，未做改动：${parsed.errors[0]}`);
              break;
            }
            await writeFile(path, sortLang(content, format), "utf8");
            committed ||= (await ws.commit(`Reorder file for ${file.replaceAll('"', '\\"')}`, author)) !== null;
            break;
          }
          case "add-mapping": {
            const slug = line.args[0];
            const raw = line.args[1];
            if (slug === undefined || raw === undefined) throw new CommandError("应该有两个参数。");
            const id = Number.parseInt(raw, 10);
            if (!Number.isFinite(id)) throw new CommandError("CurseForge 项目 ID 无效。");
            await mods.mappings.set(slug, id);
            mods.invalidate(slug);
            const info = await mods.resolve(slug).catch(() => null);
            if (!info) {
              replies.push(`已经保存映射，但是在获取 Addon 时出现了问题：无法找到 ${slug}。`);
              break;
            }
            const expected = modRefOf(slug).slug;
            if (info.slug !== expected) {
              replies.push(`你添加的指定的 curseForgeProjectID 不正确，API 返回 Slug 结果为 ${info.slug}`);
              break;
            }
            replies.push(`ℹ 添加重定向 ${slug} -> ${id} 成功。正在进行强制刷新。`);
            track(`refresh:${input.prNumber}`, () =>
              refreshInfoComment(input.prNumber, { force: true, refreshPacker: true }),
            );
            break;
          }
          case "agent":
          case "agent-review": {
            const note = line.rest.trim();
            const message =
              line.name === "agent-review"
                ? `审查 PR #${input.prNumber}${note ? `\n\n${note}` : ""}`
                : note || `查看 PR #${input.prNumber}`;
            const session = await agent.create({
              message,
              prNumber: input.prNumber,
              createdBy: input.login,
              source: "github",
            });
            replies.push(`ℹ 已创建会话：${env.PUBLIC_URL}/agent/${session.id}`);
            break;
          }
          default:
            replies.push(`⚠ 未实现的命令：/${line.name}`);
            break;
        }
      }
    };

    if (!needsRepo) {
      await execute(null);
    } else if (pull.headRepoOwner === repo.owner && pull.headRepoName === repo.name && pull.headRef === repo.defaultBranch) {
      throw new CommandError(MAIN_BRANCH_PROTECTED);
    } else {
      await withWorkspace(
        {
          owner: pull.headRepoOwner ?? repo.owner,
          name: pull.headRepoName ?? repo.name,
          branch: pull.headRef,
          depth,
        },
        async (ws) => {
          await execute(ws);
          if (committed) await ws.push();
        },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    replies.push(`⚠ 在执行命令时遇到了问题：${message}`);
    log.warn("命令执行失败", { pr: input.prNumber, error: err });
  }
  await postReply(input.prNumber, input.login, replies);
}
