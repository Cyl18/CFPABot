import { buildPack, findingHistogram, workspaceKey, type Pack } from "@cfpa/review-core/pack";
import type { PackSummary } from "@cfpa/contracts/api";
import { glossaryTerms } from "../domain/glossary.ts";
import { gh } from "../github/client.ts";
import { prdata } from "../prdata.ts";
import { ttlCache } from "../ttl.ts";

export * from "@cfpa/review-core/pack";

const packs = ttlCache<Pack>(6 * 60 * 60 * 1000, 8);

/** 机械预审结果按 PR + head SHA 缓存，Web 与 Agent 共用同一份。 */
export async function loadPack(n: number, rebuild = false): Promise<Pack> {
  const { pull, files } = await prdata.files(n);
  const key = `${n}@${pull.headSha}`;
  if (rebuild) packs.delete(key);
  const terms = await glossaryTerms();
  const build = () =>
    buildPack({
      prNumber: n,
      baseSha: pull.baseSha,
      headSha: pull.headSha,
      files,
      read: (path, ref) => gh.getFile(path, ref === "base" ? pull.baseSha : pull.headSha),
      terms,
    });
  return terms === null ? build() : packs.wrap(key, build);
}

export function peekPack(n: number, headSha: string): Pack | null {
  return packs.get(`${n}@${headSha}`) ?? null;
}

export function packSummary(pack: Pack): PackSummary {
  let truncated = pack.workspacesTruncated === true;
  const workspaces = pack.workspaces.map((workspace) => {
    if (workspace.duplicates.length > 5 || workspace.fileFindings.length > 5) truncated = true;
    return {
      workspace: workspaceKey(workspace),
      format: workspace.format,
      enPath: workspace.enPath,
      zhPath: workspace.zhPath,
      counts: workspace.counts,
      histogram: findingHistogram(workspace),
      duplicates: workspace.duplicates.slice(0, 5),
      files: workspace.fileFindings.slice(0, 5),
    };
  });
  return {
    prNumber: pack.prNumber,
    headSha: pack.headSha,
    generatedAt: pack.generatedAt,
    counts: pack.counts,
    workspaces,
    ...(truncated ? { truncated: true } : {}),
  };
}
