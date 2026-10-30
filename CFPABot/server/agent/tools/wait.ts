import type { AgentSession, CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { buildJobResult, undeliveredJobs } from "@oh-my-pi/pi-coding-agent/async/job-control";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type } from "@oh-my-pi/omptype";
import type { ToolContext } from "../context.ts";

const WAIT_PARAMS = type({});

// 一批 job 全收的上限；子代理本身有 10 分钟上限，留一倍余量。
const CAP_MS = 20 * 60_000;

const ABORTED = Symbol("aborted");

function abortSignalOf(signal: AbortSignal | undefined): Promise<typeof ABORTED> {
  const { promise, resolve } = Promise.withResolvers<typeof ABORTED>();
  signal?.addEventListener("abort", () => resolve(ABORTED), { once: true });
  return promise;
}

function runningJobs(manager: AsyncJobManager, ownerId: string | undefined) {
  return ownerId === undefined ? manager.getRunningJobs() : manager.getRunningJobs({ ownerId });
}

function collect(session: AgentSession, manager: AsyncJobManager, ownerId: string | undefined) {
  const settled = undeliveredJobs(manager, ownerId);
  const running = runningJobs(manager, ownerId);
  if (settled.length === 0 && running.length === 0) {
    return {
      content: [{ type: "text" as const, text: "Nothing to wait for: 本会话没有可回收的后台任务。" }],
      details: {},
    };
  }
  return buildJobResult(session as unknown as ToolSession, manager, "wait", [...settled, ...running], []);
}

/** 覆盖内建 wait：等本会话全部后台 job 结束，一次返回全部结果，而不是首个结束的那片。 */
export function waitTool(ctx: ToolContext): CustomTool<typeof WAIT_PARAMS> {
  return {
    name: "wait",
    label: "等待后台任务",
    description:
      "阻塞到本会话派出的后台任务全部结束（全部收完或有 job 卡到 20 分钟上限），一次返回全部结果。派完一批子代理只调一次，不要逐片轮询；用户插话会打断等待。",
    parameters: WAIT_PARAMS,
    execute: async (_toolCallId, _params, onUpdate, _runtime, signal) => {
      const session = ctx.session?.();
      const manager = session?.asyncJobManager;
      if (session === undefined || manager === undefined) {
        return {
          content: [{ type: "text" as const, text: "Nothing to wait for: 本会话没有后台任务管理器。" }],
          details: {},
        };
      }
      const ownerId = session.getAgentId();
      const running = runningJobs(manager, ownerId);
      if (running.length === 0) return collect(session, manager, ownerId);

      const watched = running.map((job) => job.id);
      // 等待期间压住自动投递，否则每片结束都单插一条消息，批量回收就失效了。
      manager.watchJobs(watched);
      try {
        const batch =
          ownerId === undefined
            ? manager.waitForAll().then(() => true)
            : manager.waitForOwnerJobs(ownerId, { timeoutMs: CAP_MS });
        const result = await Promise.race([batch, abortSignalOf(signal)]);
        if (result === ABORTED) onUpdate?.({ content: [{ type: "text", text: "等待被用户打断。" }] });
      } finally {
        manager.unwatchJobs(watched);
      }
      return collect(session, manager, ownerId);
    },
  };
}
