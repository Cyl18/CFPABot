// src/flows/_shared/markdown/render-info-comment.ts
// PURE: Render the main bot info comment from typed state data.
// No I/O, no globals, no side effects.
// This is the single source of truth for the comment layout — collectors
// return typed data, not Markdown.

import type {
  InfoCommentState,
  SectionState,
  ModLinksData,
  ArtifactsData,
  ChecksData,
  TranslationDiffSummary,
} from "../types.js";
import { escapeMarkdown, escapeTableCell } from "./escape.js";

// ──────────────────────────────────────────
// Top-level renderer
// ──────────────────────────────────────────

export interface RenderInfoCommentOptions {
  /** Show "currently updating" header */
  isUpdating?: boolean;
  /** Head SHA to display in updating header */
  updatingHeadSha?: string;
  /** Max chars for translation-diff section before Gist fallback */
  maxDiffSectionChars?: number;
}

/**
 * Render the full info comment from state data.
 * Pure function — returns the Markdown string.
 * Sections follow the fixed order: marker, title, mods, artifacts,
 * checks, translation diff, actions/refresh.
 */
export function renderInfoComment(
  state: InfoCommentState,
  options?: RenderInfoCommentOptions,
): string {
  const parts: string[] = [];

  // 1. Marker
  parts.push("<!--CYBOT-->");
  parts.push("");

  // 2. Title / brand
  if (options?.isUpdating) {
    const sha = options.updatingHeadSha ?? state.headSha;
    parts.push(`> 🔄 正在更新… (head: \`${sha.slice(0, 7)}\`)`);
    parts.push("");
  }
  parts.push("## 🤖 CFPA Bot 信息评论");
  parts.push("");

  // 3. Mod links section
  const modsSection = renderSection(state.sections.mods, renderModLinks);
  if (modsSection) parts.push(modsSection);

  // 4. Artifacts section
  const artifactsSection = renderSection(state.sections.artifacts, renderArtifacts);
  if (artifactsSection) parts.push(artifactsSection);

  // 5. Checks section
  const checksSection = renderSection(state.sections.checks, renderChecks);
  if (checksSection) parts.push(checksSection);

  // 6. Translation diff section
  const diffSection = renderSection(state.sections.translationDiff, (data) =>
    renderTranslationDiff(data, options?.maxDiffSectionChars),
  );
  if (diffSection) parts.push(diffSection);

  // 7. Actions / refresh
  parts.push("---");
  parts.push("");
  parts.push(
    "> 此评论由程序自动维护。勾选下方复选框可强制刷新各部分信息。",
  );
  parts.push("");
  parts.push("- [ ] 强制刷新所有信息");
  parts.push("");

  return parts.join("\n");
}

// ──────────────────────────────────────────
// Section renderer
// ──────────────────────────────────────────

function renderSection<T>(
  section: SectionState<T>,
  renderReady: (data: T) => string,
): string {
  switch (section.status) {
    case "pending":
      return "";
    case "empty":
      return "";
    case "error": {
      const err = section.error;
      const retryHint = err.retryable ? "（可重试）" : "";
      const msg = err.publicMessage
        ? escapeMarkdown(err.publicMessage)
        : "未知错误";
      return [
        `### ⚠️ 部分信息暂时不可用`,
        "",
        `> ${msg}${retryHint}`,
        "",
      ].join("\n");
    }
    case "ready":
      return renderReady(section.data);
  }
}
// ──────────────────────────────────────────
// Mod links
// ──────────────────────────────────────────

function renderModLinks(data: ModLinksData): string {
  const parts: string[] = [];
  parts.push("### 📦 相关 Mod");
  parts.push("");

  if (data.mods.length === 0) {
    parts.push("> 未识别到任何 Mod。");
    parts.push("");
    return parts.join("\n");
  }

  const rows = data.mods.map((mod) => {
    const name = escapeTableCell(mod.name);
    const slug = escapeTableCell(mod.slug);
    const provider = mod.provider === "curseforge" ? "CF" : "MR";
    const link = `[${name}](${escapeTableCell(mod.projectUrl)})`;
    return `| ${link} | \`${slug}\` | ${provider} |`;
  });

  parts.push("| Mod | Slug | 来源 |");
  parts.push("| --- | --- | --- |");
  parts.push(rows.join("\n"));
  parts.push("");

  if (data.truncated) {
    parts.push("> ⚠️ 超过 20 个 Mod，部分信息未完整查询。");
    parts.push("");
  }

  if (data.errors.length > 0) {
    for (const err of data.errors) {
      parts.push(`> ⚠️ ${escapeMarkdown(err.publicMessage)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ──────────────────────────────────────────
// Artifacts
// ──────────────────────────────────────────

const ARTIFACT_LABELS: Record<ArtifactsData["state"], string> = {
  branch_not_supported: "目标分支不是 main，不支持自动打包",
  maintainer_edits_disabled: "Maintainer edits 不可用",
  waiting: "等待 Packer 运行",
  approval_required: "等待批准",
  running: "Packer 正在运行…",
  completed: "打包完成",
  no_artifacts: "打包完成，无构建产物",
  pr_closed: "PR 已关闭",
  failed: "Packer 运行失败",
};

function renderArtifacts(data: ArtifactsData): string {
  const parts: string[] = [];
  parts.push("### 📦 PR Packer");
  parts.push("");

  const stateLabel = ARTIFACT_LABELS[data.state] ?? data.state;
  parts.push(`> 状态：${escapeMarkdown(stateLabel)}`);
  parts.push("");

  if (data.message) {
    parts.push(`${escapeMarkdown(data.message)}`);
    parts.push("");
  }

  const artifactList = data.artifacts;
  if (artifactList && artifactList.length > 0) {
    parts.push("| 构件 | 下载 |");
    for (const a of artifactList) {
      const name = escapeTableCell(a.name);
      const url = a.downloadUrl;
      const expires = a.expiresAt
        ? ` （过期: ${a.expiresAt}）`
        : "";
      parts.push(`| ${name} | [下载](${url})${escapeMarkdown(expires)} |`);
    }
    parts.push("");
  }

  if (data.workflowRunId) {
    parts.push(
      `> Workflow Run: [#${data.workflowRunId}](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/actions/runs/${data.workflowRunId})`,
    );
    parts.push("");
  }

  return parts.join("\n");
}

// ──────────────────────────────────────────
// Checks
// ──────────────────────────────────────────

function renderChecks(data: ChecksData): string {
  const parts: string[] = [];
  parts.push("### ✅ 自动检查");
  parts.push("");

  if (data.findings.length === 0) {
    parts.push("> 未发现检查问题。");
    parts.push("");
    return parts.join("\n");
  }

  parts.push("| 级别 | 检查项 | 信息 |");
  parts.push("| --- | --- | --- |");

  for (const finding of data.findings) {
    const severityIcon =
      finding.severity === "error"
        ? "🔴"
        : finding.severity === "warning"
          ? "🟡"
          : "🔵";
    const code = escapeTableCell(finding.code);
    const message = escapeTableCell(finding.message);
    const pathInfo = finding.path ? ` \`${escapeTableCell(finding.path)}\`` : "";
    parts.push(`| ${severityIcon} ${finding.severity} | \`${code}\` | ${message}${pathInfo} |`);
  }
  parts.push("");

  return parts.join("\n");
}

// ──────────────────────────────────────────
// Translation diff
// ──────────────────────────────────────────

function renderTranslationDiff(
  data: TranslationDiffSummary,
  maxChars?: number,
): string {
  const parts: string[] = [];
  parts.push("### 🌐 翻译变更");
  parts.push("");

  parts.push(
    `| 统计 | 值 |`,
  );
  parts.push(`| --- | --- |`);
  parts.push(`| 文件对数 | ${data.pairCount} |`);
  parts.push(`| 新增条目 | ${data.addedCount} |`);
  parts.push(`| 修改条目 | ${data.modifiedCount} |`);
  parts.push(`| 删除条目 | ${data.removedCount} |`);
  parts.push("");

  if (data.compareUrl) {
    parts.push(`[查看完整对比](${data.compareUrl})`);
    parts.push("");
  }

  return parts.join("\n");
}
