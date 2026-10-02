import { parseLang, guessFormat } from "../domain/langfile.ts";
import { compareTwo } from "../domain/diff.ts";
import type { TextCompareRequest, TextCompareResult } from "../../shared/api.ts";

export function textCompare(req: TextCompareRequest): TextCompareResult {
  const left = parseLang(req.left.content, guessFormat(req.left.content));
  const right = parseLang(req.right.content, guessFormat(req.right.content));
  return {
    rows: compareTwo(left.entries, right.entries),
    errors: [...left.errors.map((e) => `${req.left.name}: ${e}`), ...right.errors.map((e) => `${req.right.name}: ${e}`)],
  };
}
