import type { ReviewThread } from "@cfpa/contracts/api";
import { serverGraphql } from "../../github/client.ts";
import { anonymousReviewState } from "../../github/review.ts";
import { logger } from "../../log.ts";
import { ttlCache } from "../../ttl.ts";

const log = logger("harness-threads");
const cache = ttlCache<ThreadsView>(20_000, 8);

export interface ThreadsView {
  available: boolean;
  headSha: string | null;
  pendingReviewId: string | null;
  threads: ReviewThread[];
  error?: string;
}

/** 线程状态来自 GitHub GraphQL；拿不到时明确说不可用，不把空数组伪装成“没有讨论”。 */
export async function threadsOf(n: number, headSha?: string | null, fresh = false): Promise<ThreadsView> {
  const key = String(n);
  if (fresh) cache.delete(key);
  const cached = cache.get(key);
  if (cached !== undefined && (headSha === undefined || headSha === null || cached.headSha === headSha)) {
    return cached;
  }
  cache.delete(key);
  return cache.wrap(key, async () => {
    try {
      const state = await anonymousReviewState(serverGraphql, n);
      if (state === null) return { available: false, headSha: null, pendingReviewId: null, threads: [], error: "PR 无法读取。" };
      return {
        available: true,
        headSha: state.headSha,
        pendingReviewId: state.pendingReviewId,
        threads: state.threads,
      };
    } catch (err) {
      log.warn("读取 review 线程失败", { pr: n, err });
      return {
        available: false,
        headSha: null,
        pendingReviewId: null,
        threads: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function invalidateThreads(n: number): void {
  cache.delete(String(n));
}
