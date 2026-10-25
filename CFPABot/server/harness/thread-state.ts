import { z } from "zod";

const booleanish = z.union([z.boolean(), z.enum(["true", "false"])]).transform((value) => value === true || value === "true");

export function parseThreadState(content: string | undefined): boolean {
  if (content === undefined || content.trim() === "") throw new Error("线程状态需要布尔值正文：true 或 false。");
  return booleanish.parse(JSON.parse(content) as unknown);
}
