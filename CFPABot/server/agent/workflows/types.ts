import type { EvalScope, WriteScope } from "@cfpa/contracts/api";

export interface WorkflowDefinition {
  id: string;
  promptFiles: readonly string[];
  skills: readonly string[];
  defaults: {
    writeScope: WriteScope;
    evalScope: EvalScope;
  };
}
