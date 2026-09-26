import fs from "node:fs";
import path from "node:path";
import type { Logger, LogLevel } from "../core/contracts.ts";
import { ensureDirSync } from "./paths.ts";

export interface LoggerOptions {
  level?: LogLevel;
  /** Mirrored to a file when set. */
  file?: string;
  scope?: string;
  /** Extra sink, used by the TUI to surface warnings in the transcript. */
  onRecord?: (level: LogLevel, message: string, scope?: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.level ?? "info"];
  let stream: fs.WriteStream | undefined;

  if (options.file) {
    try {
      ensureDirSync(path.dirname(options.file));
      stream = fs.createWriteStream(options.file, { flags: "a" });
      stream.on("error", () => {
        stream = undefined;
      });
    } catch {
      stream = undefined;
    }
  }

  const record = (level: LogLevel, message: string, scope?: string, meta?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < min) return;
    if (stream) {
      const metaText = meta && Object.keys(meta).length ? ` ${safeJson(meta)}` : "";
      stream.write(`${new Date().toISOString()} ${level.toUpperCase()} ${scope ? `[${scope}] ` : ""}${message}${metaText}\n`);
    }
    if (options.onRecord && (level === "warn" || level === "error")) {
      options.onRecord(level, message, scope);
    }
  };

  const make = (scope?: string): Logger => ({
    debug: (message, meta) => record("debug", message, scope, meta),
    info: (message, meta) => record("info", message, scope, meta),
    warn: (message, meta) => record("warn", message, scope, meta),
    error: (message, meta) => record("error", message, scope, meta),
    child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope),
  });

  return make(options.scope);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export const silentLogger: Logger = createLogger({ level: "error" });
