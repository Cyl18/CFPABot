import type { WorkflowDefinition } from "./types.ts";

export const generalWorkflow: WorkflowDefinition = {
  id: "general",
  promptFiles: [],
  skills: ["review"],
  defaults: { writeScope: "off", evalScope: "run" },
};
