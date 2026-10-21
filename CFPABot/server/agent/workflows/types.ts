import type { EvalScope, WriteScope } from "../../../shared/api.ts";

export interface WorkflowContext {
  prNumber?: number;
  message?: string;
}

export interface ArtifactEntry {
  file: string;
  value: unknown;
}

export interface ArtifactPublishContext {
  sessionId: string;
  prNumber?: number;
  by: string;
}

export interface ArtifactAdapter {
  preferredFile: string;
  list(id: string): Promise<ArtifactEntry[]>;
  read(id: string, file: string): Promise<unknown | null>;
  validate(input: unknown): Promise<string[]>;
  save(input: unknown): Promise<unknown>;
  serialize(value: unknown): string;
  publish(value: unknown, ctx: ArtifactPublishContext): Promise<{ url: string; value: unknown }>;
}

export interface WorkflowDefinition {
  id: string;
  title(ctx: WorkflowContext): string;
  firstPrompt(ctx: WorkflowContext): string;
  promptFiles: readonly string[];
  skills: readonly string[];
  defaults: {
    writeScope: WriteScope;
    evalScope: EvalScope;
  };
  requiresPr: boolean;
  artifacts?: ArtifactAdapter;
}
