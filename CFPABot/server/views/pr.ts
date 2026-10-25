import { workspacesOf } from "@cfpa/review-core/domain/path";
import { langEntriesOf, summarizePr } from "../domain/pr.ts";
import { isSpecialPath } from "../domain/special.ts";
import { specialPairs } from "./special.ts";
import { prdata } from "../prdata.ts";
import type { PrDetail } from "@cfpa/contracts/api";

export async function prDetail(n: number): Promise<PrDetail> {
  const { pull, files } = await prdata.files(n);
  const { slugs } = langEntriesOf(files);
  return {
    ...summarizePr(pull, slugs),
    htmlUrl: pull.htmlUrl,
    baseRef: pull.baseRef,
    baseSha: pull.baseSha,
    headRef: pull.headRef,
    headRepo: pull.headRepoOwner && pull.headRepoName ? `${pull.headRepoOwner}/${pull.headRepoName}` : "",
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    })),
    workspaces: workspacesOf(files),
    specialFiles: files.filter((file) => isSpecialPath(file.path)).map((file) => file.path),
    specialGroups: (await specialPairs(n)).length,
    related: prdata.related(n),
  };
}
