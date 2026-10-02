import { parseLangPath, workspacesOf } from "../domain/path.ts";
import { isSpecialPath } from "../domain/special.ts";
import type { GhFile, GhPull } from "../github/client.ts";
import { prdata } from "../prdata.ts";
import type { PrDetail, PrState, PrSummary } from "../../shared/api.ts";

function prStateOf(pull: GhPull): PrState {
  if (pull.state === "open") return "open";
  return pull.merged ? "merged" : "closed";
}

function slugsOf(files: GhFile[]): string[] {
  const slugs = new Set<string>();
  for (const file of files) {
    if (file.status === "removed") continue;
    const parsed = parseLangPath(file.path);
    if (parsed) slugs.add(parsed.slug);
  }
  return [...slugs].sort();
}

function summaryOf(pull: GhPull, files: GhFile[]): PrSummary {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.author,
    state: prStateOf(pull),
    draft: pull.draft,
    labels: pull.labels,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    headSha: pull.headSha,
    slugs: slugsOf(files),
  };
}

export async function prDetail(n: number): Promise<PrDetail> {
  const { pull, files } = await prdata.files(n);
  return {
    ...summaryOf(pull, files),
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
    related: prdata.related(n),
  };
}
