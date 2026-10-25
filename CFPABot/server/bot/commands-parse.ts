import { COMMANDS } from "@cfpa/contracts/commands";

export interface CommandLine {
  name: string;
  args: string[];
  rest: string;
}

export type Permission = "allow" | "owner-denied" | "denied";

export const PERMISSION_DENIED = "⚠ 你没有执行此命令的权限。";
export const OWNER_PERMISSION_DENIED =
  "⚠ 你是此 PR 的创建者，但是你的 PR 所指向的仓库的所有权并不属于你。由于可能会造成不可预知的错误，拒绝执行此命令。";

export function splitArgs(input: string): string[] {
  const chars = [...input];
  let inSingle = false;
  let inDouble = false;
  const out: string[] = [];
  let current = "";
  for (const char of chars) {
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += "\n";
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += "\n";
      continue;
    }
    if (!inSingle && !inDouble && char === " ") {
      current += "\n";
      continue;
    }
    current += char;
  }
  for (const part of current.split("\n")) {
    if (part.length > 0) out.push(part);
  }
  return out;
}

export function parseLines(body: string): CommandLine[] {
  const out: CommandLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    if (!raw.startsWith("/")) continue;
    const space = raw.indexOf(" ");
    const name = space === -1 ? raw.slice(1) : raw.slice(1, space);
    const rest = space === -1 ? "" : raw.slice(space + 1);
    out.push({ name, args: rest.trim().length > 0 ? splitArgs(rest) : [], rest });
  }
  return out;
}

export function permissionDecision(input: {
  isCollaborator: boolean;
  isPrAuthor: boolean;
  headOwnerIsAuthor: boolean;
}): Permission {
  if (input.isCollaborator) return "allow";
  if (!input.isPrAuthor) return "denied";
  return input.headOwnerIsAuthor ? "allow" : "owner-denied";
}

export const COMMANDS_NEEDING_REPO = Object.fromEntries(
  COMMANDS.filter((command) => command.needsRepo).map((command) => [command.name, true]),
) as Record<string, true>;

export const COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));

export const COLLABORATOR_ONLY = new Set(
  COMMANDS.filter((command) => command.collaboratorOnly).map((command) => command.name),
);
