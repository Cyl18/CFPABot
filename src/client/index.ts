// src/client/index.ts
// Barrel exports for all external service clients.

export {
  createGitHubClient,
  createUserTokenGitHubClient,
  exchangeOAuthCode,
  buildRawUrl,
  fetchRawContent,
  checkRawExists,
} from "./github/index.js";
export type { GitHubClient } from "./github/index.js";

export {
  findCurseForgeAddon,
  getCurseForgeEnFile,
  downloadCurseForgeFile,
} from "./curseforge-client.js";
export type {
  CFAddon,
  CFAuthor,
  CFCategory,
  CFLink,
  CFFile,
  CFDependency,
  CFModule,
  CFPagination,
  CFSearchResult,
  ReleaseType,
  FileStatus,
  DependencyRelation,
} from "./curseforge-client.js";

export { getModrinthMod } from "./modrinth-client.js";
export type {
  ModrinthProject,
  ModrinthProjectType,
  ModrinthSide,
  ModrinthProjectStatus,
  ModrinthLicense,
  ModrinthVersion,
  ModrinthVersionType,
  ModrinthVersionStatus,
  ModrinthDependency,
  ModrinthDependencyType,
  ModrinthVersionFile,
  ModrinthFileType,
  ModrinthSearchResult,
  ModrinthSearchHit,
} from "./modrinth-client.js";

export { commit, push, revert, moveFile, getHeadSha, ensureRepo } from "./git.js";
export type { RepoHandle } from "./git.js";

export {
  initRelation,
  refreshRelation,
  removeCachedPR,
  getRelation,
  getRelationsForPR,
} from "./pr-relations-cache.js";
export type { PRRelationEntry } from "./pr-relations-cache.js";

export {
  getRepoPath,
  repoExists,
  readRepoFile,
  readModSlugs,
  readModVersions,
  probeModLangFiles,
} from "./local-repo.js";
export {
  readModlistCache,
  readCurseforgeMapping,
  writeModlistCache,
  writeCurseforgeMapping,
} from "./cache.js";

export {
  fetchProviderModels,
  buildModelsUrl,
  normalizeLlmBaseUrl,
  inferProtocolFromUrl,
  parseModelsResponse,
  assertHttpBaseUrl,
  ModelsProbeValidationError,
  ModelsProbeUpstreamError,
} from "./llm-models.js";
