import { z } from "zod";

const threadStateSchema = z.object({ resolved: z.boolean() });

export function parseThreadState(content: string | undefined): boolean {
  if (content === undefined || content.trim().length === 0) {
    throw new Error('线程状态需要 JSON body：{"resolved":true|false}。');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('线程状态需要 JSON body：{"resolved":true|false}。');
  }
  const parsed = threadStateSchema.safeParse(value);
  if (!parsed.success) throw new Error('线程状态需要 {"resolved":true|false}。');
  return parsed.data.resolved;
}
