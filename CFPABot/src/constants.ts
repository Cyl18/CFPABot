// Central constants for timeouts, limits, and batch sizes.
// Import from here instead of hardcoding literals.

/** Default timeout for GitHub raw content fetch (ms). */
export const RAW_FETCH_TIMEOUT_MS = 10_000;

/** Default timeout for OAuth HTTP exchange (ms). */
export const OAUTH_EXCHANGE_TIMEOUT_MS = 10_000;

/** Heartbeat interval for SSE sessions (ms). */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** Sleep interval between SSE stream checks (ms). */
export const SSE_STREAM_SLEEP_MS = 10_000;

/** Flow execution backoff cap (ms). */
export const FLOW_BACKOFF_CAP_MS = 30_000;

/** Maximum PR diff size (bytes). */
export const PR_DIFF_MAX_BYTES = 5_000_000;

/** Compare sources cache TTL (ms). */
export const COMPARE_SOURCES_CACHE_TTL_MS = 300_000;
