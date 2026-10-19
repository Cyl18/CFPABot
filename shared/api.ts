export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ApiError {
  error: string;
  code?: string;
}

export interface Me {
  login: string;
  id: number;
  avatarUrl: string;
  isAdmin: boolean;
}

export type PrState = "open" | "closed" | "merged";

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  state: PrState;
  draft: boolean;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  headSha: string;
  slugs: string[];
}

export interface PrFile {
  path: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  previousPath?: string;
}

export interface Workspace {
  slug: string;
  version: string;
  namespace: string;
  files: string[];
}

export interface RelatedPr {
  number: number;
  title: string;
  slug: string;
  versions: string[];
}

export interface PrDetail extends PrSummary {
  htmlUrl: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headRepo: string;
  files: PrFile[];
  workspaces: Workspace[];
  specialFiles: string[];
  related: RelatedPr[];
}

export type CheckLevel = "error" | "warn" | "info" | "ok";

export interface CheckItem {
  level: CheckLevel;
  code: string;
  message: string;
  path?: string;
  unit?: string;
}

export type ModFileStatus = "ok" | "mismatch" | "extra" | "unavailable";

export interface ModFileCheck {
  slug: string;
  namespace: string;
  version: string;
  provider?: "curseforge" | "modrinth";
  fileName?: string;
  fetchedAt?: string;
  status: ModFileStatus;
  note?: string;
  missing: string[];
  extra: string[];
  changed: string[];
}

export interface CheckReport {
  prNumber: number;
  headSha: string;
  generatedAt: string;
  items: CheckItem[];
  modFiles: ModFileCheck[];
}

export type RowStatus = "add" | "remove" | "modify" | "same";

export interface CompareRow {
  key: string;
  baseEn?: string;
  headEn?: string;
  baseZh?: string;
  headZh?: string;
  enStatus: RowStatus;
  zhStatus: RowStatus;
}

export interface CompareResult {
  workspace: Omit<Workspace, "files">;
  baseSha: string;
  headSha: string;
  format: "json" | "lang";
  rows: CompareRow[];
  missing: string[];
  review: CompareReview | null;
}

export interface ReviewHunk {
  start: number;
  end: number;
}

export interface CompareReview {
  path: string;
  keys: Record<string, { line: number; raw: string }>;
}

export type SpecialStatus = PrFile["status"] | "unchanged" | "missing";

export interface SpecialSide {
  path: string;
  status: SpecialStatus;
  previousPath?: string;
}

export type SpecialPair =
  | { key: string; kind: "pair"; parsedFormat: string | null; en: SpecialSide; zh: SpecialSide }
  | { key: string; kind: "single"; parsedFormat: string | null; file: SpecialSide };

export interface SpecialKeyRow {
  key: string;
  baseEn?: string;
  headEn?: string;
  baseZh?: string;
  headZh?: string;
  enStatus: RowStatus;
  zhStatus: RowStatus;
  enLine?: number;
  zhLine?: number;
}

export interface SpecialParsed {
  format: string;
  rows: SpecialKeyRow[];
}

export interface SpecialText extends SpecialSide {
  base: string | null;
  head: string | null;
  truncated: boolean;
  hunks: ReviewHunk[] | null;
}

export type SpecialPairContent =
  | { key: string; kind: "pair"; en: SpecialText; zh: SpecialText; parsed: SpecialParsed | null }
  | { key: string; kind: "single"; file: SpecialText };

export interface CrossVersionKeyCell {
  version: string;
  en: string;
  zh: string | null;
}

export interface CrossVersionKeyRow {
  key: string;
  touched: boolean;
  cells: CrossVersionKeyCell[];
}

export interface CrossVersionKeysResult {
  slug: string;
  namespace: string;
  namespaces: string[];
  versions: string[];
  activeVersions: string[];
  prVersions: string[];
  zhVersions: string[];
  rows: CrossVersionKeyRow[];
}

export interface TextCompareRequest {
  left: { name: string; content: string };
  right: { name: string; content: string };
}

export interface TextCompareResult {
  rows: { key: string; left?: string; right?: string; status: RowStatus }[];
  errors: string[];
}

export interface ModEntry {
  slug: string;
  name?: string;
  cfUrl?: string;
  cfSlug?: string;
  curseforgeId?: number;
  versions: { version: string; namespaces: string[]; zhDomains?: string[] }[];
}

export interface ModList {
  updatedAt: string | null;
  headSha: string | null;
  mods: ModEntry[];
}

export type SessionStatus = "idle" | "running";

export type WriteScope = "off" | "bound" | "any";

export type EvalScope = "off" | "run";

export interface SessionSummary {
  id: string;
  title: string;
  prNumber?: number;
  status: SessionStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  model: string;
  hasDraft: boolean;
  writeScope: WriteScope;
  evalScope: EvalScope;
  lastError?: string;
}

export interface ToolCallView {
  name: string;
  args: unknown;
  state: "pending" | "running" | "done" | "error";
  progress?: string;
  result?: string;
}

export type ChatItem =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "assistant"; text: string; thinking?: string; at: string; streaming?: boolean }
  | { id: string; kind: "tool"; tool: ToolCallView; at: string };

export type Severity = "critical" | "major" | "minor" | "neutral";
export type Verdict = "approve" | "changes" | "reject";

export interface DraftComment {
  id: string;
  path: string;
  line: number;
  key: string;
  severity: Severity;
  mqm: string;
  en?: string;
  zh?: string;
  body: string;
  suggestion?: string;
  covers?: string[];
  suspected?: boolean;
}

export interface ReviewDraft {
  prNumber: number;
  headSha: string;
  verdict: Verdict;
  summary: string;
  comments: DraftComment[];
  updatedAt: string;
  publishedAt?: string;
  publishedUrl?: string;
}

export interface SessionDetail extends SessionSummary {
  items: ChatItem[];
  draft?: ReviewDraft;
  headSha?: string;
  stale?: boolean;
}

export interface CreateSessionRequest {
  prNumber?: number;
  message?: string;
  review?: boolean;
  model?: string;
  writeScope?: WriteScope;
  evalScope?: EvalScope;
}

export interface SetWriteScopeRequest {
  writeScope: WriteScope;
}

export interface SetEvalScopeRequest {
  evalScope: EvalScope;
}

export type SessionEvent =
  | { type: "snapshot"; session: SessionDetail }
  | { type: "status"; status: SessionStatus; lastError?: string }
  | { type: "item"; item: ChatItem }
  | { type: "draft"; draft: ReviewDraft }
  | { type: "ping" };

export type LlmProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmEndpoint {
  id: string;
  provider: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  maxOutput?: number;
  thinking?: ThinkingLevel;
}

export interface LlmConfig {
  endpoints: LlmEndpoint[];
  agent?: string;
  reviewers: string[];
}

export interface LlmEndpointView extends Omit<LlmEndpoint, "apiKey"> {
  hasKey: boolean;
}

export interface LlmConfigView {
  endpoints: LlmEndpointView[];
  agent?: string;
  reviewers: string[];
}

export interface LlmConfigUpdate {
  endpoints: (Omit<LlmEndpoint, "apiKey"> & { apiKey?: string })[];
  agent?: string;
  reviewers: string[];
}

export interface ProbeModelsRequest {
  baseUrl: string;
  protocol: LlmProtocol;
  apiKey?: string;
  endpointId?: string;
}

export interface SystemStatus {
  github: { mode: "app" | "pat" | "anonymous"; rateLimit?: { remaining: number; limit: number; resetAt: string } };
  webhook: boolean;
  curseforge: boolean;
  glossary: boolean;
  llm: { agent?: string; reviewers: string[] };
  prCache: { openCount: number; refreshedAt: string | null };
  modList: { updatedAt: string | null; count: number };
  mappings: { count: number; updatedAt: string | null };
}

export interface MappingEntry {
  slug: string;
  curseforgeId: number;
  source: "manual" | "resolved";
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

export interface ReviewComment {
  id: string;
  author: string;
  avatarUrl: string;
  body: string;
  createdAt: string;
  url: string;
  pending: boolean;
  mine: boolean;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  outdated: boolean;
  resolved: boolean;
  comments: ReviewComment[];
}

export interface PrReviewState {
  viewer: string | null;
  headSha: string;
  pendingReviewId: string | null;
  threads: ReviewThread[];
  viewed: Record<string, FileViewedState>;
}

export interface AddReviewCommentRequest {
  path: string;
  line: number;
  body: string;
}

export interface SetFileViewedRequest {
  path: string;
  viewed: boolean;
}

export interface SubmitReviewRequest {
  event: ReviewEvent;
  body: string;
}

export interface ReviewHtmlRequest {
  ids: string[];
}

export interface ReviewHtmlResult {
  html: Record<string, string>;
}

export interface SetThreadResolvedRequest {
  resolved: boolean;
}

export interface AddReviewReplyRequest {
  body: string;
}
