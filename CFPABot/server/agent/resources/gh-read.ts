import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { env, repo } from "../../env.ts";
import { gh } from "../../github/client.ts";
import { mirror } from "../../mirror.ts";
import { prdata } from "../../prdata.ts";
import { crossVersionKeys } from "../../views/cross-version.ts";
import { jsonResult } from "../result.ts";
import { missingResource } from "./format.ts";
import type { GhUri } from "./uri.ts";

const BODY_LIMIT = 2000;

function trimBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > BODY_LIMIT ? `${trimmed.slice(0, BODY_LIMIT)}…[已截断]` : trimmed;
}

function isMainBot(author: string, body: string): boolean {
  return body.startsWith("<!--CYBOT-->") && (author === env.BOT_LOGIN || author === "Cyl18-Bot");
}

function isAgentBody(body: string): boolean {
  return body.includes("<!--CFPA-AGENT:");
}

function visibleIssueComment(comment: { author: string; body: string; isBot: boolean }): boolean {
  return !isMainBot(comment.author, comment.body) && (!comment.isBot || isAgentBody(comment.body));
}

const CHILDREN = ["meta", "pulls", "issues", "search", "mods", "versions"] as const;

export async function readGh(uri: GhUri): Promise<AgentToolResult<Record<string, unknown>>> {
  const seg = uri.path.split("/").filter(Boolean);
  const head = seg[0];
  if (head === undefined) return missingResource("gh://", CHILDREN);

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
    return missingResource(`gh://issues/${n}`, ["<issue>", "comments"]);
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
    return jsonResult(
      await crossVersionKeys(slug, {
        namespace: uri.query.get("namespace") ?? undefined,
        ...(pr === undefined ? {} : { pr }),
        ...(versions === undefined || versions.length === 0 ? {} : { versions }),
      }),
    );
  }

  return missingResource(`gh://${uri.path}`, CHILDREN);
}
