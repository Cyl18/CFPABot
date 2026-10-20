import { patchHunks } from "./domain/diff.ts";
import type { ReviewHunk } from "../shared/api.ts";
import type { GhFile } from "./github/types.ts";

export function commentableHunks(
  file: Pick<GhFile, "patch" | "status">,
  headText?: string | null,
): ReviewHunk[] {
  if (file.patch !== undefined) return patchHunks(file.patch);
  if (file.status !== "added" || headText === undefined || headText === null) return [];
  const lines = headText.split("\n");
  const count = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return count === 0 ? [] : [{ start: 1, end: count }];
}
