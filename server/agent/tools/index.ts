import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../context.ts";
import { draftSaveTool } from "./draft.ts";
import { glossaryTool } from "./glossary.ts";
import { multiReviewTool } from "./multi.ts";
import { prDiscussionTool, prOverviewTool, prReadTool } from "./pr.ts";
import { reviewLoadTool, reviewRowsTool } from "./review.ts";

export function buildTools(ctx: ToolContext): AgentTool[] {
  return [
    prOverviewTool(ctx),
    prDiscussionTool(ctx),
    prReadTool(ctx),
    reviewLoadTool(ctx),
    reviewRowsTool(ctx),
    glossaryTool(),
    multiReviewTool(ctx),
    draftSaveTool(ctx),
  ];
}
