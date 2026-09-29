import type { CheckItem, CheckLevel, CheckReport } from "../../shared/api.ts";

export const CYBOT_MARKER = "<!--CYBOT-->";
export const RELOAD_LINE = "- [ ] 🔄 勾选这个复选框来强制刷新";
export const CRITICAL_FAILURE = `${CYBOT_MARKER}❌ CRITICAL_FAILURE：找到了多个 Bot Comment。 请删除到只保留一个。删除后请点击强制刷新.\n\n---\n\n${RELOAD_LINE}`;
export const BRANCH_NOT_MAIN = "❗ 警告：你所提交的目标分支不是 main 分支，这在 99% 的情况下都是你的问题。请 close 此 PR 并重新提交。";
export const TOO_MANY_FILES = "⚠ 所涉及文件过多，将不进行检查。";
export const TOO_MANY_MODS = "模组数量过多，将不显示模组链接。";
export const NO_MODS = "ℹ 此 PR 没有检测到 CurseForge/Modrinth 模组修改。";
export const MODRINTH_NOTE = "ℹ Modrinth 的 Bot 功能为临时辅助，不代表最终结果。";
export const CHECK_PENDING = "ℹ 检查尚未完成。";
export const CHECK_PASSED = "✅ 检查通过。";
export const DIFF_DROPPED = "ℹ 翻译差异内容过长，已省略，请在面板查看。";

export interface RenderContext {
  publicUrl: string;
  prNumber: number;
}

export interface ModLink {
  name: string;
  url: string;
  provider: "curseforge" | "modrinth";
  iconUrl?: string;
  sourceUrl?: string;
  compareWs?: string;
  dependency?: boolean;
  relatedText?: string;
  repoLinks?: { version: string; url: string }[];
}

export type ModsView =
  | { kind: "list"; mods: ModLink[]; notes: string[] }
  | { kind: "tooMany" }
  | { kind: "empty" };

export interface PackerView {
  lines: string[];
}

export interface DiffRow {
  key: string;
  baseEn?: string;
  headEn?: string;
  baseZh?: string;
  headZh?: string;
}

export interface DiffWorkspace {
  label: string;
  ws: string;
  rows: DiffRow[];
}

export interface DiffsView {
  workspaces: DiffWorkspace[];
  specialLink: boolean;
}

export interface CommentSections {
  mods: string;
  packer: string;
  checks: string;
  diffs: string;
}

const CHECK_ORDER: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2, ok: 3 };
const CHECK_ICON: Record<CheckLevel, string> = { error: "❌", warn: "⚠️", info: "ℹ️", ok: "✅" };
const LEADING_ICON = /^(?:❌|⚠️|⚠|ℹ️|ℹ|✅|✔️|✔|❗)\s*/u;
const MAX_MOD_ROWS = 8;
const MAX_DIFF_ROWS = 40;
const MAX_DIFF_CHARS = 18000;

function mdEscape(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("|", "\\|");
}

function postProcess(value: string): string {
  if (value.includes("$")) {
    return `\`${value.replaceAll("<", "\\<").replaceAll("`", "\\`").replaceAll("\n", "[换行符]")}\``;
  }
  return value
    .replaceAll("<", "\\<")
    .replaceAll("`", "\\`")
    .replaceAll("\n", "<br>")
    .replaceAll("*", "\\*")
    .replaceAll("|", "\\|");
}

function enCell(base: string | undefined, head: string | undefined): string {
  if (!base) return head ? postProcess(head) : "⛔";
  if (base.trim() === (head ?? "").trim()) return postProcess(head ?? "");
  return `${postProcess(base)}<br>🔽<br>${postProcess(head ?? "")}`;
}

function zhCell(base: string | undefined, head: string | undefined): string {
  if (!base) return head ? postProcess(head) : "⛔";
  return `${postProcess(base)}<br>🔽<br>${postProcess(head ?? "")}`;
}

function repoDetails(links: { version: string; url: string }[]): string {
  return `<details> <summary>语言文件链接</summary>${links.map((l) => `[${l.version}](${l.url}) <br/>`).join("")}</details>`;
}

function modRow(mod: ModLink, ctx: RenderContext): string {
  const icon = mod.iconUrl ? `<img src="${mod.iconUrl}" width="32"/>` : "✨";
  const name = mdEscape(mod.name);
  const nameCell = mod.dependency ? `依赖-[*${name}*](${mod.url})` : `[**${name}**](${mod.url})`;
  const source = mod.sourceUrl ? `[:mag: 源代码](${mod.sourceUrl})` : mod.provider === "curseforge" ? ":mag:无源代码" : "";
  const links = [source, `[🟩 MCMOD](https://cn.bing.com/search?q=site:mcmod.cn%20${encodeURIComponent(mod.name)})`].filter(
    (v) => v.length > 0,
  );
  links.push(
    mod.compareWs
      ? `[:file_folder: 对比](${ctx.publicUrl}/pr/${ctx.prNumber}/compare?ws=${encodeURIComponent(mod.compareWs)})`
      : "&nbsp;&nbsp;*",
  );
  const related = mod.relatedText ?? (mod.repoLinks && mod.repoLinks.length > 0 ? repoDetails(mod.repoLinks) : "*");
  return `| ${icon} | ${nameCell} | ${links.join(" \\| ")} | ${related} |`;
}

export function renderMods(view: ModsView, ctx: RenderContext): string {
  if (view.kind === "tooMany") return TOO_MANY_MODS;
  if (view.kind === "empty") return NO_MODS;
  const notes = view.notes.length > 0 ? `${view.notes.join("\n")}\n\n` : "";
  if (view.mods.length === 0) return `${notes}${NO_MODS}`;
  const table = [
    "|     | 模组 | 🔗 链接 | :art: 相关文件 |",
    "| --- | --- | --- | --- |",
    ...view.mods.map((m) => modRow(m, ctx)),
  ].join("\n");
  return view.mods.length > MAX_MOD_ROWS ? `${notes}<details> <summary>模组列表</summary>\n\n${table}\n\n</details>` : `${notes}${table}`;
}

export function renderPacker(view: PackerView): string {
  return view.lines.join("\n");
}

export function renderChecks(report: CheckReport | null): string {
  if (!report) return CHECK_PENDING;
  const sorted = [...report.items].sort((a, b) => CHECK_ORDER[a.level] - CHECK_ORDER[b.level]);
  if (sorted.length === 0) return CHECK_PASSED;
  const format = (item: CheckItem) => `${CHECK_ICON[item.level]} ${item.message.replace(LEADING_ICON, "")}`;
  if (sorted.length <= 12) return sorted.map(format).join("\n");
  return [
    ...sorted.slice(0, 8).map(format),
    "",
    "<details>",
    `<summary>其余 ${sorted.length - 8} 项检查</summary>`,
    "",
    ...sorted.slice(8).map(format),
    "",
    "</details>",
  ].join("\n");
}

function diffCounts(rows: DiffRow[]): { added: number; modified: number; removed: number } {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const row of rows) {
    if (row.baseEn === undefined && row.baseZh === undefined) added++;
    else if (row.headEn === undefined && row.headZh === undefined) removed++;
    else modified++;
  }
  return { added, modified, removed };
}

function renderDiffWorkspace(ws: DiffWorkspace, ctx: RenderContext): string {
  const shown = ws.rows.slice(0, MAX_DIFF_ROWS);
  const counts = diffCounts(ws.rows);
  const table = [
    "| Key | 英文 | 中文 |",
    "| - | - | - |",
    ...shown.map(
      (row) => `| \`${row.key.replaceAll("`", "\\`").replaceAll("|", "\\|")}\` | ${enCell(row.baseEn, row.headEn)} | ${zhCell(row.baseZh, row.headZh)} |`,
    ),
  ].join("\n");
  const overflow =
    ws.rows.length > shown.length
      ? `\n\n… 还有 ${ws.rows.length - shown.length} 行，[在面板查看](${ctx.publicUrl}/pr/${ctx.prNumber}/compare?ws=${encodeURIComponent(ws.ws)})`
      : "";
  return `<details>\n<summary>${ws.label} · +${counts.added} ~${counts.modified} -${counts.removed}</summary>\n\n${table}${overflow}\n\n</details>`;
}

export function renderDiffs(view: DiffsView, ctx: RenderContext): string {
  const parts: string[] = [];
  if (view.specialLink) parts.push(`🔛 [转到复杂文件 Diff](${ctx.publicUrl}/pr/${ctx.prNumber}/special)`);
  let chars = 0;
  let dropped = 0;
  for (const ws of view.workspaces) {
    const block = renderDiffWorkspace(ws, ctx);
    if (chars + block.length > MAX_DIFF_CHARS) {
      dropped++;
      continue;
    }
    chars += block.length;
    parts.push(block);
  }
  if (dropped > 0) parts.push(`ℹ 另有 ${dropped} 个文件的差异过长，请在[面板](${ctx.publicUrl}/pr/${ctx.prNumber}/compare)查看。`);
  return parts.join("\n\n");
}

export function assembleComment(
  sections: CommentSections,
  opts: { warnings: string[]; updating: boolean },
  ctx: RenderContext,
): string {
  const blocks: string[] = [CYBOT_MARKER];
  if (opts.warnings.length > 0) blocks.push(opts.warnings.join("\n"));
  blocks.push(`### 📦 模组\n\n${sections.mods.trim()}`);
  blocks.push(`### 🧰 打包\n\n${sections.packer.trim()}`);
  blocks.push(`### 🔍 检查\n\n${sections.checks.trim()}`);
  blocks.push(`### 🔛 翻译差异\n\n${sections.diffs.trim()}`);
  blocks.push(`---\n[命令列表](${ctx.publicUrl}/commands) · [在面板查看](${ctx.publicUrl}/pr/${ctx.prNumber})\n${RELOAD_LINE}`);
  if (opts.updating) blocks.push("---\n**⏳ 正在更新…**");
  return blocks.join("\n\n");
}
