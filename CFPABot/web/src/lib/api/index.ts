// Barrel re-export — preserves the public API from the original lib/api.ts.
// All existing `import { ... } from '@/lib/api'` calls continue to work.
//
// The legacy `api` object mixed three base URLs. We now split them into
// `frontendApi` (/api/frontend), `sessionsApi` (/api/sessions), and
// `reviewApi` (/api/reviews) for clarity, but re-merge into a single `api`
// here so existing callers (useAgentChat, Sessions, etc.) stay unchanged.
// New code should import the domain-specific clients directly.

import { api as frontendApi } from './frontend'
import { sessionsApi } from './sessions'
export { api as frontendApi } from './frontend'
export { sessionsApi } from './sessions'
export { formatApiErrorEnvelope } from './client'

/** Legacy unified api object — delegates to the correct base URL per method. */
export const api = {
  ...frontendApi,
  ...sessionsApi,
}

// Re-export types for direct named imports
export type {
  Pr,
  PrFile,
  PrMod,
  PrDetail,
  DiffRow,
  LogEntry,
  RateLimitResponse,
  OutboundCall,
  UnmappedSlugInfo,
  UnmappedSlugsResponse,
  LlmProtocol,
  LlmEndpointResponse,
  LlmEndpointInput,
  LlmDefaultsResponse,
  LlmDefaultsInput,
  AgentSession,
  AgentMessage,
  PendingConfirmation,
  CompareUploadResponse,
  WorkspaceCompareStatus,
  CompareWorkspaceRow,
  WorkspaceCompareSummary,
  CompareWorkspaceRequest,
  CompareWorkspaceResponse,
  CrossVersionCell,
  CrossVersionRow,
  CrossVersionSummary,
  CrossVersionResponse,
  ThinkingLevel,
  AuthError,
} from './types'

export { normalizeRole } from './types'
