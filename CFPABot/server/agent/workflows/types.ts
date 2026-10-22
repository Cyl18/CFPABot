import type { EvalScope, WriteScope } from "../../../shared/api.ts";

export interface WorkflowDefinition {
  id: string;
  promptFiles: readonly string[];
  skills: readonly string[];
  defaults: {
    writeScope: WriteScope;
    evalScope: EvalScope;
  };
}
