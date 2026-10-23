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

export type FindingSource = "program" | "term";

export interface Finding {
  code: string;
  severity: Severity;
  source: FindingSource;
  detail: string;
  unit?: string;
  path?: string;
  key?: string;
  line?: number;
  keys?: string[];
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
  units: string[];
  findings: Finding[];
  modFiles: ModFileCheck[];
}

export interface PackWorkspaceSummary {
  workspace: string;
  format: "json" | "lang";
  enPath: string | null;
  zhPath: string | null;
  counts: { total: number; changed: number; flagged: number };
  histogram: Record<string, number>;
  duplicates: { zh: string; keys: string[] }[];
  files: { path: string; findings: Finding[] }[];
}

export interface PackSummary {
  prNumber: number;
  headSha: string;
  generatedAt: string;
  counts: { workspaces: number; rows: number; changed: number; flagged: number };
  workspaces: PackWorkspaceSummary[];
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
  reviewEn: CompareReview | null;
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

export type WriteScope = "off" | "on";

export type EvalScope = "off" | "run";

export interface SessionDraftSummary {
  prNumber: number;
  verdict: Verdict;
  comments: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  model: string;
  workflow: string;
  prNumber?: number;
  hasArtifact: boolean;
  draft?: SessionDraftSummary;
  writeScope: WriteScope;
  evalScope: EvalScope;
  thinking?: ThinkingLevel;
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
  artifact?: unknown;
  artifactFile?: string;
}

export interface CreateSessionRequest {
  message?: string;
  model?: string;
  prNumber?: number;
  writeScope?: WriteScope;
  evalScope?: EvalScope;
}

export interface SetWriteScopeRequest {
  writeScope: WriteScope;
}

export interface SetEvalScopeRequest {
  evalScope: EvalScope;
}

export interface SetSessionConfigRequest {
  model?: string;
  thinking?: ThinkingLevel | null;
  prNumber?: number | null;
}

export type SessionEvent =
  | { type: "snapshot"; session: SessionDetail }
  | { type: "status"; status: SessionStatus; lastError?: string }
  | { type: "item"; item: ChatItem }
  | { type: "artifact"; artifact: unknown }
  | { type: "ping" };

export type LlmProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function parseModelSelector(value: string): { endpoint: string; thinking?: ThinkingLevel } {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const level = trimmed.slice(colon + 1) as ThinkingLevel;
    if (THINKING_LEVELS.includes(level)) return { endpoint: trimmed.slice(0, colon), thinking: level };
  }
  return { endpoint: trimmed };
}

export function formatModelSelector(endpoint: string, thinking?: ThinkingLevel): string {
  return thinking ? `${endpoint}:${thinking}` : endpoint;
}

export interface LlmEndpoint {
  id: string;
  provider: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface LlmSearch {
  provider: string;
  endpoint: string;
  apiKey: string;
}

export interface LlmConfig {
  endpoints: LlmEndpoint[];
  roles: Record<string, string>;
  search?: LlmSearch;
}

export interface LlmEndpointView extends Omit<LlmEndpoint, "apiKey"> {
  hasKey: boolean;
}

export interface LlmSearchView {
  provider: string;
  endpoint: string;
  hasKey: boolean;
}

export interface LlmConfigView {
  endpoints: LlmEndpointView[];
  roles: Record<string, string>;
  search: LlmSearchView | null;
}

export interface LlmConfigUpdate {
  endpoints: (Omit<LlmEndpoint, "apiKey"> & { apiKey?: string })[];
  roles: Record<string, string>;
  search?: { provider: string; endpoint?: string; apiKey?: string } | null;
}

export interface LlmProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  protocol: LlmProtocol;
}

/** 与 omp 的 provider id 对齐：填错 id 会丢掉该 provider 的请求头与兼容规则。 */
export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = ([
  { slug: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" },
  { slug: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages" },
  { slug: "google", label: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "google-generative-ai" },
  { slug: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", protocol: "openai-completions" },
  { slug: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai-completions" },
  { slug: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", protocol: "openai-responses" },
  { slug: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", protocol: "openai-completions" },
  { slug: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", protocol: "openai-completions" },
  { slug: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai-completions" },
  { slug: "moonshot", label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/v1", protocol: "openai-completions" },
  { slug: "zai", label: "Z.AI", baseUrl: "https://api.z.ai/api/coding/paas/v4", protocol: "openai-completions" },
  { slug: "siliconflow-cn", label: "硅基流动（国内）", baseUrl: "https://api.siliconflow.cn/v1", protocol: "openai-completions" },
  { slug: "siliconflow", label: "硅基流动（国际）", baseUrl: "https://api.siliconflow.com/v1", protocol: "openai-completions" },
  { slug: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", protocol: "openai-completions" },
  { slug: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", protocol: "openai-completions" },
  { slug: "firepass", label: "Fireworks Firepass", baseUrl: "https://api.fireworks.ai/inference/v1", protocol: "openai-completions" },
  { slug: "opencode-zen", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", protocol: "openai-completions" },
  { slug: "opencode-go", label: "OpenCode Go", baseUrl: "https://opencode.ai/inference/go/v1", protocol: "openai-completions" },
  { slug: "kimi-code", label: "Kimi Code", baseUrl: "https://api.kimi.com/coding/v1", protocol: "openai-completions" },
  { slug: "zhipu-coding-plan", label: "智谱 Coding Plan", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", protocol: "openai-completions" },
  { slug: "qwen-portal", label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", protocol: "openai-completions" },
  { slug: "alibaba-coding-plan", label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", protocol: "openai-completions" },
  { slug: "alibaba-token-plan", label: "QwenCloud Token Plan", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", protocol: "openai-completions" },
  { slug: "minimax-code", label: "MiniMax Coding Plan", baseUrl: "https://api.minimax.io/anthropic", protocol: "anthropic-messages" },
  { slug: "minimax-code-cn", label: "MiniMax Coding Plan（国内）", baseUrl: "https://api.minimaxi.com/anthropic", protocol: "anthropic-messages" },
  { slug: "abliteration", label: "Abliteration", baseUrl: "https://api.abliteration.ai/v1", protocol: "openai-responses" },
  { slug: "aiand", label: "ai&", baseUrl: "https://api.aiand.com/v1", protocol: "openai-completions" },
  { slug: "aimlapi", label: "AIML API", baseUrl: "https://api.aimlapi.com/v1", protocol: "openai-completions" },
  { slug: "baseten", label: "Baseten", baseUrl: "https://inference.baseten.co/v1", protocol: "openai-completions" },
  { slug: "cline-pass", label: "ClinePass", baseUrl: "https://api.cline.bot/api/v1", protocol: "openai-completions" },
  { slug: "coralbricks", label: "CoralBricks", baseUrl: "https://inference.coralbricks.ai/v1", protocol: "openai-completions" },
  { slug: "coreweave", label: "CoreWeave", baseUrl: "https://api.inference.wandb.ai/v1", protocol: "openai-completions" },
  { slug: "deepinfra", label: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", protocol: "openai-completions" },
  { slug: "gmi-cloud", label: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1", protocol: "openai-completions" },
  { slug: "helmcode", label: "Helmcode", baseUrl: "https://api.helmcode.com/v1", protocol: "openai-completions" },
  { slug: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", protocol: "openai-completions" },
  { slug: "kilo", label: "Kilo Gateway", baseUrl: "https://api.kilo.ai/api/gateway", protocol: "openai-completions" },
  { slug: "meta", label: "Meta", baseUrl: "https://api.meta.ai/v1", protocol: "openai-responses" },
  { slug: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", protocol: "openai-completions" },
  { slug: "novita", label: "Novita", baseUrl: "https://api.novita.ai/openai/v1", protocol: "openai-completions" },
  { slug: "nvidia", label: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", protocol: "openai-completions" },
  { slug: "qianfan", label: "Qianfan", baseUrl: "https://qianfan.baidubce.com/v2", protocol: "openai-completions" },
  { slug: "sakana", label: "Sakana AI", baseUrl: "https://api.sakana.ai/v1", protocol: "openai-responses" },
  { slug: "sambanova", label: "SambaNova", baseUrl: "https://api.sambanova.ai/v1", protocol: "openai-completions" },
  { slug: "stepfun", label: "StepFun", baseUrl: "https://api.stepfun.ai/v1", protocol: "openai-completions" },
  { slug: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", protocol: "openai-completions" },
  { slug: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", protocol: "openai-completions" },
  { slug: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", protocol: "openai-completions" },
  { slug: "wafer-serverless", label: "Wafer Serverless", baseUrl: "https://pass.wafer.ai/v1", protocol: "openai-completions" },
  { slug: "xiaomi", label: "Xiaomi", baseUrl: "https://api.xiaomimimo.com/v1", protocol: "openai-completions" },
  { slug: "xiaomi-token-plan-cn", label: "Xiaomi Token Plan（国内）", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", protocol: "openai-completions" },
  { slug: "xiaomi-token-plan-ams", label: "Xiaomi Token Plan（AMS）", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", protocol: "openai-completions" },
  { slug: "xiaomi-token-plan-sgp", label: "Xiaomi Token Plan（SGP）", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", protocol: "openai-completions" },
  { slug: "yolo-auto", label: "Yolo-Auto", baseUrl: "https://yolo-auto.com/v1", protocol: "openai-completions" },
  { slug: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", protocol: "openai-completions" },
] satisfies LlmProviderPreset[]).sort((a, b) => a.slug.localeCompare(b.slug));

export interface SearchProviderPreset {
  id: string;
  label: string;
  /** 默认端点；空串表示由 SDK 内置，端点可不填 */
  endpoint: string;
  selfHosted?: true;
  /** 不需要任何凭据的抓取类 provider */
  keyless?: true;
}

/** omp 内置的 web_search provider；端点与密钥通过环境变量注入。 */
export const SEARCH_PROVIDER_PRESETS: readonly SearchProviderPreset[] = ([
  { id: "searxng", label: "SearXNG（自建）", endpoint: "", selfHosted: true },
  { id: "brave", label: "Brave Search", endpoint: "" },
  { id: "exa", label: "Exa", endpoint: "" },
  { id: "tavily", label: "Tavily", endpoint: "" },
  { id: "jina", label: "Jina", endpoint: "" },
  { id: "firecrawl", label: "Firecrawl", endpoint: "" },
  { id: "parallel", label: "Parallel", endpoint: "" },
  { id: "kagi", label: "Kagi", endpoint: "" },
  { id: "perplexity", label: "Perplexity", endpoint: "" },
  { id: "deepseek", label: "DeepSeek", endpoint: "" },
  { id: "zai", label: "Z.AI", endpoint: "" },
  { id: "synthetic", label: "Synthetic", endpoint: "" },
  { id: "tinyfish", label: "TinyFish", endpoint: "" },
  { id: "kimi", label: "Kimi Search", endpoint: "https://api.kimi.com/coding/v1/search", selfHosted: true },
  { id: "ollama", label: "Ollama Cloud", endpoint: "" },
  { id: "duckduckgo", label: "DuckDuckGo", endpoint: "", keyless: true },
  { id: "google", label: "Google（抓取）", endpoint: "", keyless: true },
  { id: "ecosia", label: "Ecosia", endpoint: "", keyless: true },
  { id: "startpage", label: "Startpage", endpoint: "", keyless: true },
  { id: "mojeek", label: "Mojeek", endpoint: "", keyless: true },
  { id: "public", label: "Public Web", endpoint: "", keyless: true },
] satisfies SearchProviderPreset[]).sort((a, b) => a.id.localeCompare(b.id));

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
  llm: { default?: string; roles: string[] };
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
