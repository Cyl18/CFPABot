import type { WorkflowDefinition } from "./types.ts";

export const generalWorkflow: WorkflowDefinition = {
  id: "general",
  promptFiles: ["pipeline.md"],
  skills: ["prep", "post", "translate"],
  defaults: { writeScope: "off", evalScope: "run", bashScope: "off" },
};
