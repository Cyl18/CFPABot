import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { readdir } from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";
import { resolveToolPath } from "./fs.ts";

const PATH_HINT = "path 可写 local://、repo:// 或 pr://<n> 资源 URI，省略时用会话 workspace。";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const GREP_PARAMS = type({
  pattern: type("string").describe("正则或字面量"),
  "path?": type("string").describe("搜索目录或资源 URI"),
  "glob?": type("string").describe("文件名 glob，例如 *.json"),
  "ignoreCase?": "boolean",
  "literal?": "boolean",
  "context?": type("number").describe("上下文行数"),
  "limit?": type("number").describe("最大命中数，默认 200"),
});

const FIND_PARAMS = type({
  pattern: type("string").describe("文件名 glob，例如 **/*.json"),
  "path?": type("string").describe("搜索目录或资源 URI"),
  "limit?": type("number").describe("最大结果数，默认 200"),
});

const LS_PARAMS = type({
  "path?": type("string").describe("目录或资源 URI"),
  "limit?": type("number").describe("最大条目数，默认 200"),
});

function limitOf(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function grepTool(ctx: ToolContext): AgentTool<typeof GREP_PARAMS> {
  return {
    name: "grep",
    label: "搜索内容",
    description: `按正则搜索内容。${PATH_HINT}`,
    parameters: GREP_PARAMS,
    execute: async (_toolCallId, params) => {
      const dir = await resolveToolPath(ctx, params.path);
      const limit = limitOf(params.limit);
      const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(limit)];
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.context) args.push("--context", String(Math.max(0, Math.floor(params.context))));
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.pattern, dir);
      const proc = Bun.spawn(["rg", ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0 && exitCode !== 1) throw new Error(stderr.trim() || `rg exited ${exitCode}`);
      return textResult(stdout.trimEnd() || "(no matches)");
    },
  };
}

export function findTool(ctx: ToolContext): AgentTool<typeof FIND_PARAMS> {
  return {
    name: "find",
    label: "查找文件",
    description: `按 glob 查找文件。${PATH_HINT}`,
    parameters: FIND_PARAMS,
    execute: async (_toolCallId, params) => {
      const dir = await resolveToolPath(ctx, params.path);
      const limit = limitOf(params.limit);
      const found: string[] = [];
      for await (const file of new Bun.Glob(params.pattern).scan({ cwd: dir, onlyFiles: true })) {
        found.push(file);
        if (found.length >= limit) break;
      }
      return textResult(found.join("\n") || "(no matches)");
    },
  };
}

export function lsTool(ctx: ToolContext): AgentTool<typeof LS_PARAMS> {
  return {
    name: "ls",
    label: "列出目录",
    description: `列出目录内容。${PATH_HINT}`,
    parameters: LS_PARAMS,
    execute: async (_toolCallId, params) => {
      const dir = await resolveToolPath(ctx, params.path);
      const entries = await readdir(dir, { withFileTypes: true });
      const names = entries
        .slice(0, limitOf(params.limit))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
      return textResult(names.join("\n") || "(empty)");
    },
  };
}
