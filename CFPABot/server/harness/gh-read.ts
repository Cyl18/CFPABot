import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { repo } from "../env.ts";
import { gh } from "../github/client.ts";
import { mirror } from "../mirror.ts";
import { prdata } from "../prdata.ts";
import { crossVersionKeys } from "../views/cross-version.ts";
import { jsonResult, numberParam, pageOf } from "./result.ts";
import { isAgentBody, trimBody, visibleIssueComment } from "./format.ts";
import { GH_CHILDREN, missingResource } from "./catalog.ts";
import { nextPageUri } from "./uri.ts";
import type { ResourceParts } from "./uri.ts";

export async function readGh(uri: ResourceParts): Promise<AgentToolResult<Record<string, unknown>>> {
  const seg = uri.path.split("/").filter(Boolean);
  const head = seg[0];
  if (head === undefined) return missingResource("gh://", GH_CHILDREN);

  if (head === "meta") {
    return jsonResult({ owner: repo.owner, name: repo.name, fullName: repo.fullName, defaultBranch: repo.defaultBranch });
  }

  if (head === "pulls") {
    const state = uri.query.get("state") ?? "open";
    if (state !== "open" && state !== "closed" && state !== "merged" && state !== "all") {
      throw new Error("state 只能是 open/closed/merged/all。");
    }
    return jsonResult(await prdata.list(state));
  }

  if (head === "issues") {
    const n = Number(seg[1]);
    if (!Number.isInteger(n) || n <= 0) throw new Error("issue 编号无效。");
    if (seg.length === 2) return jsonResult(await gh.getIssue(n));
    if (seg.length === 3 && seg[2] === "comments") {
      const comments = await gh.listComments(n);
      return jsonResult(
        comments
          .filter(visibleIssueComment)
          .map((comment) => ({
            author: comment.author,
            body: trimBody(comment.body),
            at: comment.createdAt,
            isAgent: isAgentBody(comment.body),
          })),
      );
    }
    return missingResource(`gh://issues/${n}`, ["issues/<n>", "issues/<n>/comments"]);
  }

  if (head === "search") {
    const q = uri.query.get("q");
    if (!q) throw new Error("gh://search 需要 ?q=");
    const type = uri.query.get("type") === "pr" ? "pr" : "issue";
    return jsonResult(await gh.search(q, type));
  }

  if (head === "mods") {
    const list = await mirror.modList();
    const q = uri.query.get("q")?.trim().toLowerCase();
    if (!q) return jsonResult(list);
    return jsonResult({
      ...list,
      mods: list.mods.filter((mod) => mod.slug.toLowerCase().includes(q) || (mod.name ?? "").toLowerCase().includes(q)),
    });
  }

  if (head === "versions") {
    const slug = seg[1];
    if (!slug || seg[2] !== "keys") throw new Error("gh://versions/<slug>/keys 需要 slug。");
    const prRaw = uri.query.get("pr");
    const pr = prRaw === null || prRaw.trim() === "" ? undefined : Number(prRaw);
    if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) throw new Error("pr 参数无效。");
    const versions = uri.query.get("versions")?.split(",").filter(Boolean);
    const result = await crossVersionKeys(
      slug,
      {
        namespace: uri.query.get("namespace") ?? undefined,
        ...(pr === undefined ? {} : { pr }),
        ...(versions === undefined || versions.length === 0 ? {} : { versions }),
      },
      prdata.fileSource(pr),
    );
    const prefix = uri.query.get("prefix");
    const rows = prefix === null ? result.rows : result.rows.filter((row) => row.key.startsWith(prefix));
    const page = pageOf(numberParam(uri.query.get("offset")), numberParam(uri.query.get("limit")), 200, 40);
    const shown: typeof rows = [];
    let bytes = 0;
    for (const row of rows.slice(page.offset, page.offset + page.limit)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (shown.length > 0 && bytes + size > 30_000) break;
      shown.push(row);
      bytes += size;
    }
    const nextOffset = page.offset + shown.length < rows.length ? page.offset + shown.length : null;
    return jsonResult({
      ...result,
      rows: shown,
      total: rows.length,
      offset: page.offset,
      limit: page.limit,
      next: nextPageUri(`gh://versions/${slug}/keys`, uri.query, nextOffset),
    });
  }

  return missingResource(`gh://${uri.path}`, GH_CHILDREN);
}
