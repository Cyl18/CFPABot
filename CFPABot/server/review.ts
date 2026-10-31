import { patchHunks } from "@cfpa/review-core/domain/diff";
import type { ReviewHunk } from "@cfpa/contracts/api";
import type { GhFile } from "./github/types.ts";

export function commentableHunks(
  file: Pick<GhFile, "patch" | "status">,
  headText?: string | null,
): ReviewHunk[] | null {
  if (file.patch !== undefined) {
    // 纯删除 hunk 的 newLines 是 0，end 会落在 start 前面，夹回 start 避免出现空区间。
    return patchHunks(file.patch).map((hunk) => ({ start: hunk.start, end: Math.max(hunk.start, hunk.end) }));
  }
  if (file.status !== "added") return null;
  if (headText === undefined || headText === null) return [];
  const lines = headText.split("\n");
  const count = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return count === 0 ? [] : [{ start: 1, end: count }];
}
