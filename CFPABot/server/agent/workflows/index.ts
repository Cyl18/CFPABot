import { generalWorkflow } from "./general.ts";
import type { WorkflowDefinition } from "./types.ts";

export const workflows: Record<string, WorkflowDefinition> = {
  [generalWorkflow.id]: generalWorkflow,
};

export const DEFAULT_WORKFLOW = generalWorkflow.id;

export function resolveWorkflow(id: string | undefined): WorkflowDefinition {
  return workflows[id ?? DEFAULT_WORKFLOW] ?? generalWorkflow;
}
