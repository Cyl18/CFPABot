// src/flows/files/files_fetch_en_us.ts
// Flow: files_fetch_en_us — fetch en_us language file from an external source
//   (CurseForge or Modrinth) and write it into a PR branch.
// Risk: repository_write | Effects: git_commit, git_push, external_write
// Spec: docs/specs/02-flow-catalog.md §7 + docs/specs/06-automation-and-mutations.md §7.6
//
// Note: Modrinth file download is not yet implemented in the client layer.
// Only CurseForge is currently supported for automatic en_us extraction.
// TODO(2026-07-18): Implement Modrinth file download in @/client/modrinth-client.js.

import { Type, type Static } from "typebox";
import type { Flow, FlowContext } from "@/types.js";
import { FlowError } from "@/types.js";
import { withPrWorkspace } from "../_internal/index.js";
import {
  findCurseForgeAddon,
  downloadCurseForgeFile,
} from "@/client/curseforge-client.js";
import { getModrinthMod } from "@/client/modrinth-client.js";
import { extractZipEntry, listZipEntries } from "@/client/local-repo.js";
import { formatLanguage } from "../_shared/language/index.js";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { resolveWorkspacePath } from "../_internal/workspace-path.js";

// ─── Input Schema ──────────────────────────────────────────────────────

export const files_fetch_en_us_input = Type.Object({
  prNumber: Type.Number({ description: "PR number" }),
  headSha: Type.String({ description: "Expected head SHA" }),
  source: Type.Union(
    [Type.Literal("curseforge"), Type.Literal("modrinth")],
    { description: "Provider to fetch from" },
  ),
  slug: Type.String({ description: "Project slug on the provider" }),
  gameVersion: Type.String({ description: "Minecraft version (e.g. 1.21)" }),
  targetPath: Type.String({
    description: "Destination path (relative, e.g. projects/assets/slug/1.21/domain/lang/en_us.json)",
  }),
  commitMessage: Type.Optional(
    Type.String({ description: "Optional custom commit message" }),
  ),
});

export type FilesFetchEnUsInput = Static<typeof files_fetch_en_us_input>;

// ─── Output DTO ────────────────────────────────────────────────────────

export const files_fetch_en_us_output = Type.Object({
  commitSha: Type.String({ description: "SHA of the created commit" }),
  writtenPath: Type.String({ description: "Path where the en_us file was written" }),
  provider: Type.String({ description: "Source provider" }),
  projectName: Type.String({ description: "Project name from the provider" }),
});

export type FilesFetchEnUsOutput = Static<typeof files_fetch_en_us_output>;

// ─── Internal: resolve JAR entry names for en_us files ─────────────────

/** File patterns to look for inside a JAR when searching for en_us. */
const EN_US_PATTERNS = [
  /assets\/[^/]+\/lang\/en_us\.json$/i,
  /lang\/en_us\.json$/i,
  /en_us\.json$/i,
  /assets\/[^/]+\/lang\/en_us\.lang$/i,
  /lang\/en_us\.lang$/i,
  /en_us\.lang$/i,
];

/** Find the first en_us file entry name inside a JAR/ZIP buffer. */
async function findEnUsEntry(
  zipBuffer: Uint8Array,
): Promise<string | null> {
  const entries = await listZipEntries(zipBuffer);
  for (const pattern of EN_US_PATTERNS) {
    const match = entries.find((e) => pattern.test(e.name));
    if (match) return match.name;
  }
  return null;
}

// ─── Flow Definition ───────────────────────────────────────────────────

export const files_fetch_en_us: Flow<
  typeof files_fetch_en_us_input,
  typeof files_fetch_en_us_output
> = {
  name: "files_fetch_en_us",
  description:
    "Fetch the en_us language file from an external mod distribution source " +
    "(CurseForge or Modrinth) and write it to the specified path in a PR branch. " +
    "Downloads the JAR, extracts the en_us file, formats it to project conventions, " +
    "then commits via withPrWorkspace. " +
    "Currently only CurseForge is fully supported; Modrinth client lacks file download.",
  input: files_fetch_en_us_input,
  output: files_fetch_en_us_output,
  meta: {
    tags: ["files", "mutation", "repository_write", "external"],
    risk: "repository_write",
    effects: ["git_commit", "git_push", "external_write", "github_read"],
    timeoutMs: 180_000,
    idempotencyKey: (invocation, input) =>
      `${invocation.id}:${input.prNumber}:${input.headSha}:fetch_en_us:${input.source}:${input.slug}:${input.gameVersion}`,
    agent_callable: true,
  },

  async execute(
    ctx: FlowContext,
    input: Static<typeof files_fetch_en_us_input>,
  ): Promise<Static<typeof files_fetch_en_us_output>> {
    const { prNumber, headSha, source, slug, gameVersion, targetPath } = input;

    // ── Step 1: Validate provider and fetch project metadata ────────────
    let enUsContent: string;
    let projectName: string;

    if (source === "curseforge") {
      const addon = await findCurseForgeAddon(slug, { timeoutMs: 60_000 });
      projectName = addon.name;

      ctx.logger.info(
        { slug, projectName, gameVersion },
        "Fetching en_us from CurseForge",
      );

      // Get the download URL for the matching version
      const matchingFile = addon.latestFiles.find(
        (f) => f.gameVersions.includes(gameVersion) && f.isAvailable,
      );
      if (!matchingFile || !matchingFile.downloadUrl) {
        throw new FlowError({
          code: "UPSTREAM_UNAVAILABLE",
          message: `No available file for ${slug} on version ${gameVersion}`,
          publicMessage: `No file found for "${slug}" on Minecraft ${gameVersion}.`,
          retryable: true,
        });
      }

      // Download the JAR
      const response = await downloadCurseForgeFile(matchingFile.downloadUrl);
      const zipBuffer = new Uint8Array(await response.arrayBuffer());

      // Find en_us entry inside the JAR
      const entryName = await findEnUsEntry(zipBuffer);
      if (!entryName) {
        throw new FlowError({
          code: "FAILED",
          message: `en_us file not found in JAR for ${slug} (${gameVersion})`,
          publicMessage: `Could not locate en_us inside the downloaded file for "${slug}".`,
          retryable: false,
        });
      }

      enUsContent = await extractZipEntry(zipBuffer, entryName);
    } else if (source === "modrinth") {
      // Modrinth: fetch project metadata
      const project = await getModrinthMod(slug, { timeoutMs: 60_000 });
      projectName = project.title;
      throw new FlowError({
        code: "UPSTREAM_UNAVAILABLE",
        message: `Modrinth file download is not yet implemented in the client layer`,
        publicMessage:
          `Modrinth source is not yet supported for en_us extraction. ` +
          `The project "${projectName}" was found, but downloading its files is not implemented. ` +
          `Use CurseForge as the source instead.`,
        retryable: false,
      });
    } else {
      throw new FlowError({
        code: "INVALID_INPUT",
        message: `Unknown source provider: ${source}`,
        publicMessage: `Source must be "curseforge" or "modrinth".`,
        retryable: false,
      });
    }

    // ── Step 2: Format and prepare for workspace ────────────────────────
    const format = targetPath.endsWith(".lang") ? "lang" as const : "json" as const;
    const formatted = formatLanguage(enUsContent, format);
    if (formatted.error) {
      throw new FlowError({
        code: "FAILED",
        message: `Failed to format en_us content: ${formatted.error}`,
        publicMessage: "The extracted en_us file could not be formatted to project conventions.",
        retryable: false,
      });
    }

    const commitMessage =
      input.commitMessage ?? `Fetch en_us for ${slug} (${gameVersion}) from ${source}`;

    let writtenPath = targetPath;

    // ── Step 3: Write to workspace and commit ───────────────────────────
    const result = await withPrWorkspace(
      ctx,
      {
        prNumber,
        expectedHeadSha: headSha,
        operationName: "files_fetch_en_us",
        commitMessage,
      },
      async (handle) => {
        // 路径净化:拒绝 .. / 绝对路径(workspace-path.ts)
        const absPath = resolveWorkspacePath(handle.dir, targetPath);

        // Ensure parent directory exists
        const parent = absPath.replace(/[/\\][^/\\]+$/, "");
        try {
          await stat(parent);
        } catch {
          await mkdir(parent, { recursive: true });
        }

        await writeFile(absPath, formatted.formatted, "utf-8");
        writtenPath = targetPath;
      },
    );

    if (result.skipped) {
      return { commitSha: "", writtenPath, provider: source, projectName };
    }

    return {
      commitSha: result.commitSha,
      writtenPath,
      provider: source,
      projectName,
    };
  },
};
