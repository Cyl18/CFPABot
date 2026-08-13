export {
  parseLangFile,
  dumpLangFile,
  parseTranslationContent,
} from "./lang-file.js";

export { diffCompareMaps } from "./lang-compare.js";

export { diffWorkspaceMaps } from "./diff-workspace-maps.js";
export type {
  CompareWorkspaceRow,
  WorkspaceSummary,
  WorkspaceStatus,
  DiffWorkspaceMapsInput,
  DiffWorkspaceMapsResult,
} from "./diff-workspace-maps.js";
export { diffCrossVersionMaps } from "./diff-cross-version-maps.js";
export type {
  CrossVersionRow,
  CrossVersionSummary,
  DiffCrossVersionMapsInput,
  DiffCrossVersionMapsResult,
} from "./diff-cross-version-maps.js";

export {
  diffLangFiles,
  diffLangEntries,
  computeStats,
  filterChangedRows,
  dominantChangeType,
} from "./lang-differ.js";

export {
  findMissingKeys,
  classifyKey,
  countKeysByConvention,
  findUntranslatedKeys,
  findSuspiciousTranslations,
} from "./key-analyzer.js";

export {
  formatJsonLang,
  formatDotLang,
  formatLanguage,
} from "./format-language.js";

export {
  alignLangReviewItems,
} from "./align-review-items.js";
export type {
  LangReviewItem,
  ProgramCandidate,
  ProgramIssueType,
  AlignReviewItemsInput,
  AlignReviewItemsResult,
} from "./align-review-items.js";

export {
  CHECK_REGISTRY,
  getCheckMeta,
  isCheckEnabled,
  applyCheckIgnores,
} from "./checks.js";
export type {
  CheckMeta,
  CheckCategory,
  CheckIgnoreRule,
} from "./checks.js";
