export const CYBOT_MARKER = "<!--CYBOT-->";
export const RELOAD_LINE = "- [ ] 🔄 勾选这个复选框来强制刷新";
export const UPDATING_LINE = "**:construction: 正在更新内容...**";
export const CRITICAL_FAILURE = `${CYBOT_MARKER}❌ CRITICAL_FAILURE：找到了多个 Bot Comment。 请删除到只保留一个。删除后请点击强制刷新.\n\n---\n\n${RELOAD_LINE}`;

export const BRANCH_NOT_MAIN =
  "❗ 警告：你所提交的目标分支不是 main 分支，这在 99% 的情况下都是你的问题。请 close 此 PR 并重新提交。";
export const MAINTAINER_WARNING =
  "⚠ 你没有启用“维护者可修改 PR 文件”（Allow edits from maintainers）；这会对维护者造成不便，在此页面右方勾选该选项。";
export const MAINTAINER_IMAGE =
  "![1](https://docs.github.com/assets/cb-44583/images/help/pull_requests/allow-maintainers-to-make-edits-sidebar-checkbox.png)";

export const TOO_MANY_FILES = "⚠ 所涉及文件过多，将不进行检查。";
export const TOO_MANY_MODS = "模组数量过多，将不显示模组链接。";
export const NO_MODS = "ℹ 此 PR 没有检测到 CurseForge/Modrinth 模组修改。";
export const MODRINTH_NOTE = "ℹ Modrinth 的 Bot 功能为临时辅助，不代表最终结果。";
export const CHECK_TRANSLATE_HINT = "译名检测仅供参考，可能并没有错误。**请在修改前仔细斟酌！**";
export const DIFF_EXCEPTION = "ℹ 发生异常，最大可能是此 PR 包含组合文件。请使用网页 Diff。";

export const PIC = `${[
  "  <br/>",
  '  <div align="center">',
  '  <a href="https://github.com/Cyl18/CFPABot">',
  "    <picture>",
  '      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Cyl18/CFPABot/refs/heads/dev/docs/2.svg?">',
  '      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Cyl18/CFPABot/refs/heads/dev/docs/1.svg?">',
  '      <img src="https://raw.githubusercontent.com/Cyl18/CFPABot/refs/heads/dev/docs/1.svg?" width="600">',
  "    </picture>",
  "  </a>",
  "  </div>",
  "  ",
  "  ---",
].join("\n")}\n`;

export class Lines {
  private readonly parts: string[] = [];

  line(value = ""): void {
    this.parts.push(value, "\n");
  }

  raw(value: string): void {
    this.parts.push(value);
  }

  text(): string {
    return this.parts.join("");
  }
}

export interface CommentSections {
  mods: string;
  packer: string;
  checks: string;
  diffs: string;
}

export function assembleComment(sections: CommentSections, mode: "preview" | "final", publicUrl: string): string {
  const out: string[] = [`${CYBOT_MARKER}\n`];
  const push = (value: string): void => {
    out.push(value, "\n");
  };
  push(PIC);
  push(sections.mods);
  push("---");
  push(sections.packer);
  if (mode === "preview") {
    if (sections.checks !== "") {
      push("---");
      push(sections.checks);
    }
  } else {
    push("---");
    push(sections.checks);
  }
  push("---");
  push(sections.diffs);
  push("---");
  push(`🐖 [命令列表](${publicUrl}/commands) | [问题反馈](https://github.com/Cyl18/CFPABot/issues/new)`);
  push(RELOAD_LINE);
  if (mode === "preview") {
    push("---");
    push(UPDATING_LINE);
  }
  return collapseBlankRuns(out.join(""));
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function collapseBlankRuns(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let blank = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line === "") {
      if (blank) continue;
      blank = true;
    } else {
      blank = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function urlEncodeDotNet(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0x20) {
      out += "+";
      continue;
    }
    const ch = String.fromCharCode(byte);
    const alnum = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    if (alnum || "-_.!*()".includes(ch)) {
      out += ch;
      continue;
    }
    out += `%${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}
