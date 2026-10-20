import { env, isDev } from "./env.ts";
import type { LogEntry, LogLevel } from "../shared/api.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 2000;
const ring: LogEntry[] = [];
const threshold = ORDER[env.LOG_LEVEL];

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function emit(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const clean = data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, serializeError(v)])) : undefined;
  const entry: LogEntry = { at: new Date().toISOString(), level, scope, message, ...(clean ? { data: clean } : {}) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const line = isDev
    ? `${entry.at.slice(11, 19)} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${clean ? ` ${JSON.stringify(clean)}` : ""}`
    : JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
  };
}

export function recentLogs(limit = 500, level?: LogLevel): LogEntry[] {
  const min = level ? ORDER[level] : 0;
  return ring.filter((e) => ORDER[e.level] >= min).slice(-limit);
}
