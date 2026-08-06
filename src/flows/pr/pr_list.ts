// src/flows/pr/pr_list.ts
// Flow: pr_list — list PRs with filtering, pagination, and enriched summary.
// Risk: read | Effects: github_read
//
// Supports two data sources:
//   "index" (default) — reads from PrIndex (single source of truth),
//                       accurate totalCount, client-side filter/sort/paginate.
//   "live"            — fetches from GitHub API via listPullsPage,
//                       best-effort hasMore, supports enrichment.
//
// Frontend convenience:
//   format: "frontend"  → adds flat `frontendItems` (matches `Pr` in web/src/lib/api.ts)
//   refreshIfEmpty: true → when index returns no items, kick off a
//                          fullListAndRefresh in the background (fire-and-forget).
//                          The flow already coalesces concurrent refreshes internally.
//
// When source="index" + format="frontend", this replaces the legacy inline
// `prIndex.list() + toFrontendItem + triggerFullRefresh` in src/api/frontend/prs.ts.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import type { ListPullsPageOptions } from "@/client/github/index.js";
import * as prIndex from "@/engine/pr-index.js";
import type { PrIndexEntry } from "@/engine/pr-index.js";
import { fullListAndRefresh } from "@/client/pr-relations-cache.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const pr_list_input = Type.Object({
  state: Type.Optional(
    Type.Union(
      [Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
      { description: "PR state filter (default: open)" },
    ),
  ),
  labels: Type.Optional(
    Type.Array(Type.String(), { description: "Filter by labels (all must match)" }),
  ),
  createdAfter: Type.Optional(
    Type.String({ description: "ISO date filter: created after" }),
  ),
  createdBefore: Type.Optional(
    Type.String({ description: "ISO date filter: created before" }),
  ),
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal("created"),
        Type.Literal("created_desc"),
        Type.Literal("updated"),
        Type.Literal("updated_desc"),
        Type.Literal("number_desc"),
      ],
      { description: "Sort order (default: updated_desc)" },
    ),
  ),
  cursor: Type.Optional(
    Type.Number({ description: "1-based page cursor" }),
  ),
  pageSize: Type.Optional(
    Type.Number({ description: "Items per page (default 30, max 100)" }),
  ),
  source: Type.Optional(
    Type.Union(
      [Type.Literal("index"), Type.Literal("live")],
      { description: "Data source (default: index — reads from PR index)" },
    ),
  ),
  /** Output format: "flat" (default) or "frontend" (web/src/lib/api.ts Pr shape) */
  format: Type.Optional(
    Type.Union(
      [Type.Literal("flat"), Type.Literal("frontend")],
      { description: "Output format (default: flat)" },
    ),
  ),
  /** When true + source=index + no items: kick off fullListAndRefresh in background */
  refreshIfEmpty: Type.Optional(
    Type.Boolean({ description: "Fire-and-forget full refresh when result is empty (index mode only)" }),
  ),
});

export type PrListInput = Static<typeof pr_list_input>;

// ─── Frontend-compatible PR shape (matches `Pr` in web/src/lib/api.ts) ──

export interface FrontendPrItem {
  number: number;
  title: string;
  /** Login name string. */
  author: string;
  /** "open" | "closed" — frontend prStatus() also checks merged_at for "merged". */
  status: string;
  labels: { name: string }[];
  /** ISO date string, also duplicated into createdDate for legacy frontend code. */
  created_at: string;
  createdDate: string;
  merged_at: string | null;
}

/** Map a PrIndexEntry to the flat frontend Pr[] shape. */
function toFrontendItem(entry: PrIndexEntry): FrontendPrItem {
  return {
    number: entry.number,
    title: entry.title,
    author: entry.author,
    status: entry.state,
    labels: entry.labels,
    created_at: entry.createdAt,
    createdDate: entry.createdAt,
    merged_at: entry.mergedAt ?? null,
  };
}

// ─── Output DTO ────────────────────────────────────────────────────────

export const pr_list_output = Type.Object({
  items: Type.Array(
    Type.Object({
      number: Type.Number(),
      title: Type.String(),
      state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
      author: Type.Union([
        Type.Null(),
        Type.Object({ login: Type.String(), id: Type.Number() }),
      ]),
      labels: Type.Array(
        Type.Object({ name: Type.String() }),
      ),
      additions: Type.Optional(Type.Number()),
      deletions: Type.Optional(Type.Number()),
      changedFiles: Type.Optional(Type.Number()),
      createdAt: Type.String(),
      updatedAt: Type.String(),
      mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      headSha: Type.String(),
      htmlUrl: Type.String(),
      draft: Type.Optional(Type.Boolean()),

    }),
  ),
  totalCount: Type.Optional(Type.Number()),
  page: Type.Number(),
  pageSize: Type.Number(),
  hasMore: Type.Boolean(),
  /** Present when format: "frontend" */
  frontendItems: Type.Optional(
    Type.Array(
      Type.Object({
        number: Type.Number(),
        title: Type.String(),
        author: Type.String(),
        status: Type.String(),
        labels: Type.Array(Type.Object({ name: Type.String() })),
        created_at: Type.String(),
        createdDate: Type.String(),
        mergedAt: Type.Optional(Type.String()),
      }),
    ),
  ),
  /** Present when refreshIfEmpty triggered a background refresh. */
  refreshTriggered: Type.Optional(Type.Boolean()),
});

export type PrListOutput = Static<typeof pr_list_output>;

// ─── Mapping helpers ────────────────────────────────────────────────────

function mapSort(sort: string | undefined): { sort: NonNullable<ListPullsPageOptions["sort"]>; direction: NonNullable<ListPullsPageOptions["direction"]> } {
  switch (sort) {
    case "created_desc":
      return { sort: "created", direction: "desc" };
    case "number_desc":
      return { sort: "created", direction: "desc" }; // GitHub doesn't support number sort directly
    case "updated_desc":
    default:
      return { sort: "updated", direction: "desc" };
    case "created":
      return { sort: "created", direction: "asc" };
    case "updated":
      return { sort: "updated", direction: "asc" };
  }
}

function mapState(state: string | undefined): ListPullsPageOptions["state"] {
  if (state === "closed" || state === "all") return state;
  return "open";
}

/** Map a PrIndexEntry to the PrListOutput item shape (without enrichment). */
function indexEntryToOutputItem(entry: PrIndexEntry) {
  return {
    number: entry.number,
    title: entry.title,
    state: entry.state,
    author: entry.author ? { login: entry.author, id: 0 } : null,
    labels: entry.labels,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    mergedAt: entry.mergedAt ?? null,
    headSha: entry.headSha,
    htmlUrl: entry.htmlUrl,
    draft: entry.draft,
  };
}

// Flow-level coalescing for refreshIfEmpty. fullListAndRefresh has its own
// internal coalescing (listAndRefreshInFlight), but we add a flow-level guard
// to avoid double-triggering when the API calls executeFlow rapidly.
let flowRefreshInFlight: Promise<void> | null = null;

// ─── Flow Definition ────────────────────────────────────────────────────

export const pr_list: Flow<typeof pr_list_input, typeof pr_list_output> = {
  name: "pr_list",
  description:
    "List PRs with state, label, date filters and cursor-based pagination. " +
    "Supports index/live sources. Optional frontend format maps to web/src/lib/api.ts shape. " +
    "Optional refreshIfEmpty kicks off a coalesced fullListAndRefresh on empty index.",
  input: pr_list_input,
  output: pr_list_output,
  meta: {
    tags: ["pr", "query"],
    risk: "read",
    effects: ["github_read"],
    agent_callable: true,
  },

  async execute(ctx: FlowContext, input: Static<typeof pr_list_input>): Promise<Static<typeof pr_list_output>> {
    const {
      state,
      labels: filterLabels,
      createdAfter,
      createdBefore,
      sort,
      cursor = 1,
      pageSize = 30,
      source = "index",
      format = "flat",
      refreshIfEmpty = false,
    } = input;
    const cappedPageSize = Math.min(pageSize, 500);
    let refreshTriggered = false;

    // ── Backend live mode: fetch from GitHub API ──────────────────────
    if (source === "live") {
      const { sort: ghSort, direction } = mapSort(sort);

      const ghOptions: ListPullsPageOptions = {
        state: mapState(state),
        perPage: cappedPageSize,
        page: cursor,
        sort: ghSort,
        direction,
      };
      const items = await ctx.github.listPullsPage(ghOptions);

      // Client-side label filter (AND)
      let filtered = items;
      if (filterLabels && filterLabels.length > 0) {
        filtered = items.filter((pr) =>
          filterLabels.every((lbl) => pr.labels.some((l) => l.name === lbl)),
        );
      }

      // Client-side date filter
      if (createdAfter) {
        const after = new Date(createdAfter).getTime();
        filtered = filtered.filter((pr) => new Date(pr.created_at).getTime() >= after);
      }
      if (createdBefore) {
        const before = new Date(createdBefore).getTime();
        filtered = filtered.filter((pr) => new Date(pr.created_at).getTime() <= before);
      }

      const enriched = filtered.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user ? { login: pr.user.login, id: pr.user.id } : null,
        labels: pr.labels.map((l) => ({ name: l.name })),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at,
        headSha: pr.head?.sha ?? "",
        htmlUrl: pr.html_url,
      }));

      const hasMore = items.length === cappedPageSize;

      const result: Static<typeof pr_list_output> = {
        items: enriched,
        page: cursor,
        pageSize: cappedPageSize,
        hasMore,
        refreshTriggered,
      };
      if (format === "frontend") {
        // Frontend format from live items uses the same fields
        result.frontendItems = enriched.map((pr) => ({
          number: pr.number,
          title: pr.title,
          author: pr.author?.login ?? "",
          status: pr.state,
          labels: pr.labels,
          created_at: pr.createdAt,
          createdDate: pr.createdAt,
          merged_at: pr.mergedAt ?? null,
        }));
      }
      return result;
    }

    // ── Index mode: read from PrIndex ─────────────────────────────────
    const indexState = state ?? "open";
    const prState = indexState === "all" ? "all" : indexState;

    let filtered: PrIndexEntry[];

    if (prState === "all") {
      filtered = prIndex.list({ sort: sort ?? "updated_desc" });
    } else {
      filtered = prIndex.list({ state: prState as "open" | "closed", sort: sort ?? "updated_desc" });
    }

    // Client-side label filter (AND)
    if (filterLabels && filterLabels.length > 0) {
      filtered = filtered.filter((pr) =>
        filterLabels.every((lbl) => pr.labels.some((l) => l.name === lbl)),
      );
    }

    // Client-side date filter
    if (createdAfter) {
      const after = new Date(createdAfter).getTime();
      filtered = filtered.filter((pr) => new Date(pr.createdAt).getTime() >= after);
    }
    if (createdBefore) {
      const before = new Date(createdBefore).getTime();
      filtered = filtered.filter((pr) => new Date(pr.createdAt).getTime() <= before);
    }

    const totalCount = filtered.length;
    const start = (cursor - 1) * cappedPageSize;
    const pageItems = filtered.slice(start, start + cappedPageSize);
    const hasMore = start + cappedPageSize < totalCount;

    // Fire-and-forget full refresh if index is empty and caller requested it
    if (refreshIfEmpty && pageItems.length === 0 && !flowRefreshInFlight) {
      flowRefreshInFlight = fullListAndRefresh(ctx.github)
        .then(() => {
          ctx.logger?.info?.({}, "[prs] 索引 + relation 全量刷新完成");
        })
        .catch((err: unknown) => {
          ctx.logger?.error?.({ err: String(err) }, "[prs] 全量刷新失败");
        })
        .finally(() => {
          flowRefreshInFlight = null;
        });
      refreshTriggered = true;
    }

    const result: Static<typeof pr_list_output> = {
      items: pageItems.map((entry) => indexEntryToOutputItem(entry)),
      totalCount,
      page: cursor,
      pageSize: cappedPageSize,
      hasMore,
      refreshTriggered,
    };

    if (format === "frontend") {
      result.frontendItems = pageItems.map(toFrontendItem);
    }

    return result;
  },
};
