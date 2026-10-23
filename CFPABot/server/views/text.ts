import { parseLang, guessFormat } from "@cfpa/review-core/domain/langfile";
import { compareTwo } from "@cfpa/review-core/domain/diff";
import type { TextCompareRequest, TextCompareResult } from "@cfpa/contracts/api";

export function textCompare(req: TextCompareRequest): TextCompareResult {
  const left = parseLang(req.left.content, guessFormat(req.left.content));
  const right = parseLang(req.right.content, guessFormat(req.right.content));
  return {
    rows: compareTwo(left.entries, right.entries),
    errors: [...left.errors.map((e) => `${req.left.name}: ${e}`), ...right.errors.map((e) => `${req.right.name}: ${e}`)],
  };
}
