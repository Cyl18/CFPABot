// src/logger.ts
// Pino-backed logger with in-memory ring buffer for Logs UI + file output.
// Exposes the same Logger interface and getRecentLogs() used throughout the codebase.
// Writes to logs/combined.log via pino/file transport.

import pino, { type TransportTargetOptions, type Logger as PinoLogger } from "pino";
import { type EntryConfig } from "./config.js";
import type { Logger } from "./types.js";
export type { Logger };
// ---- Ring buffer (module-level, shared) ----
const MAX_BUFFER_SIZE = 2000;
const logBuffer: LogEntry[] = [];

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data: Record<string, unknown>;
}

/** Return recent log entries, optionally filtered by minimum level. */
export function getRecentLogs(limit = 500, levelFilter?: string): LogEntry[] {
  const levels = ["debug", "info", "warn", "error"];
  const filterIdx = levelFilter ? levels.indexOf(levelFilter) : -1;

  const filtered = filterIdx >= 0
    ? logBuffer.filter((e) => levels.indexOf(e.level) >= filterIdx)
    : logBuffer;

  return filtered.slice(-limit);
}

function pushToBuffer(level: LogEntry["level"], message: string, data: Record<string, unknown>): void {
  logBuffer.push({
    timestamp: new Date().toISOString().slice(0, 19) + "Z",
    level,
    message,
    data,
  });
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.splice(0, logBuffer.length - MAX_BUFFER_SIZE);
  }
}

export function createLogger(config: EntryConfig): Logger {
  const isDev = config.environment === "development";

  // Create multi-target transport: console (pretty in dev, raw in prod) + file
  const targets: TransportTargetOptions[] = [];

  // Console transport
  if (isDev) {
    targets.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
        singleLine: true,
      },
      level: config.logLevel,
    });
  } else {
    // Production: write structured JSON to stdout
    targets.push({
      target: "pino/file",
      options: { destination: 1 },
      level: config.logLevel,
    });
  }

  // File transport — always captures everything at debug level
  targets.push({
    target: "pino/file",
    options: { destination: "./logs/combined.log", mkdir: true },
    level: "debug",
  });

  const transportStream = pino.transport({ targets });

  const pinoLogger: PinoLogger = pino(
    {
      level: config.logLevel,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transportStream,
  );

  return {
    info(data, message) {
      pinoLogger.info(data, message);
      pushToBuffer("info", message, data);
    },
    warn(data, message) {
      pinoLogger.warn(data, message);
      pushToBuffer("warn", message, data);
    },
    error(data, message) {
      pinoLogger.error(data, message);
      pushToBuffer("error", message, data);
    },
    debug(data, message) {
      pinoLogger.debug(data, message);
      pushToBuffer("debug", message, data);
    },
  };
}
