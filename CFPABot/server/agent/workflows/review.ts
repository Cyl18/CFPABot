import { z } from "zod";
import type { ReviewDraft } from "../../../shared/api.ts";
import { prdata } from "../../prdata.ts";
import {
  DRAFT_FILE,
  draftInputSchema,
  parseDraftFile,
  serializeDraftFile,
  validateDraft,
  type DraftContext,
} from "../draft.ts";
import { listLocal, readLocal } from "../local-store.ts";
import { mqmTable } from "../mqm.ts";
import { publishDraft } from "../publish.ts";
import type { ArtifactAdapter, ArtifactEntry, ArtifactPublishContext, WorkflowDefinition } from "./types.ts";

const inputSchema = draftInputSchema.omit({ event: true }).extend({ headSha: z.string().min(1) });

async function listArtifacts(id: string): Promise<ArtifactEntry[]> {
  const files = await listLocal(id);
  const json = files
    .filter((file) => file.name.endsWith(".json"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const artifacts: ArtifactEntry[] = [];
  for (const file of json) {
    const draft = parseDraftFile((await readLocal(id, file.name))?.content);
    if (draft !== null) artifacts.push({ file: file.name, value: draft });
  }
  return artifacts;
}

async function readArtifact(id: string, file: string): Promise<unknown | null> {
  return parseDraftFile((await readLocal(id, file))?.content);
}

async function draftContext(prNumber: number): Promise<DraftContext> {
  const table = await mqmTable();
  const data = await prdata.files(prNumber).catch(() => null);
  const patches = new Map<string, string | undefined>((data?.files ?? []).map((file) => [file.path, file.patch]));
  return { mqmIds: table.ids, labels: table.labels, patches };
}

async function validateArtifact(input: unknown): Promise<string[]> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message);
  return validateDraft(parsed.data, await draftContext(parsed.data.prNumber));
}

async function saveArtifact(input: unknown): Promise<unknown> {
  const draft = input as Omit<ReviewDraft, "updatedAt" | "publishedAt" | "publishedUrl">;
  return { ...draft, updatedAt: new Date().toISOString() };
}

function serializeArtifact(value: unknown): string {
  return serializeDraftFile(value as ReviewDraft);
}

async function publishArtifact(
  value: unknown,
  ctx: ArtifactPublishContext,
): Promise<{ url: string; value: unknown }> {
  const draft = value as ReviewDraft;
  if (ctx.prNumber !== undefined && ctx.prNumber !== draft.prNumber) {
    throw Object.assign(new Error("草稿的 PR 与当前会话绑定的 PR 不一致"), { status: 409 });
  }
  const { url } = await publishDraft(draft);
  return { url, value: { ...draft, publishedAt: new Date().toISOString(), publishedUrl: url } };
}

const artifacts: ArtifactAdapter = {
  preferredFile: DRAFT_FILE,
  list: listArtifacts,
  read: readArtifact,
  validate: validateArtifact,
  save: saveArtifact,
  serialize: serializeArtifact,
  publish: publishArtifact,
};

export const reviewWorkflow: WorkflowDefinition = {
  id: "review",
  title: ({ prNumber }) => (prNumber !== undefined ? `审查 PR #${prNumber}` : "审查会话"),
  firstPrompt: ({ prNumber, message }) =>
    [prNumber !== undefined ? `审查 PR #${prNumber}` : "开始审查", "先读 skill://review。", message]
      .filter(Boolean)
      .join("\n\n"),
  promptFiles: ["review-contract.md"],
  skills: ["review"],
  defaults: { writeScope: "off", evalScope: "run" },
  requiresPr: true,
  artifacts,
};
