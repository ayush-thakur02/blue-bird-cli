import fs from "node:fs";
import path from "node:path";
import { bluebirdHome, fileExists, writeFileAtomic } from "../util/paths.ts";
import { ConfigError } from "../util/errors.ts";

export const ENV_FILE_NAME = ".env";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Whether `name` is a usable environment variable name. */
export function isEnvVarName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

export function projectEnvFile(root: string): string {
  return path.join(root, ENV_FILE_NAME);
}

export function globalEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(bluebirdHome(env), ENV_FILE_NAME);
}

/**
 * Env files consulted on every run, highest precedence first. Project entries
 * win over global ones, and both lose to variables already set in the shell.
 */
export function envFileCandidates(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [projectEnvFile(root), globalEnvFile(env)];
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

export interface EnvEntry {
  key: string;
  value: string;
  /** Index into `lines`, so a write can replace the line in place. */
  line: number;
}

export interface ParsedEnvFile {
  /** Raw lines, each keeping its own line ending. */
  lines: string[];
  entries: EnvEntry[];
}

/**
 * Splits on "\n" while keeping each terminator, so rewriting a file never
 * changes the line endings or the trailing-newline state of untouched lines.
 */
function splitLines(content: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lines.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) lines.push(content.slice(start));
  return lines;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const quote = trimmed[0]!;
  if (quote === '"' || quote === "'" || quote === "`") {
    let out = "";
    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index]!;
      if (char === "\\" && quote === '"' && index + 1 < trimmed.length) {
        const next = trimmed[index + 1]!;
        out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
        index += 1;
        continue;
      }
      if (char === quote) break;
      out += char;
    }
    return out;
  }
  // Unquoted values end at a ` #` inline comment, matching dotenv semantics.
  const comment = trimmed.search(/\s#/);
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}

function formatValue(value: string): string {
  if (!value) return "";
  if (/^[^\s#'"`\\]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

/** Parses dotenv-style content: comments, blank lines, `export`, quotes, CRLF. */
export function parseEnvFile(content: string): ParsedEnvFile {
  const lines = splitLines(content);
  const entries: EnvEntry[] = [];
  lines.forEach((line, index) => {
    const text = line.replace(/\r?\n$/, "");
    if (!text.trim() || text.trimStart().startsWith("#")) return;
    const match = ENV_LINE_PATTERN.exec(text);
    if (!match) return;
    entries.push({ key: match[1]!, value: unquote(match[2] ?? ""), line: index });
  });
  return { lines, entries };
}

/** Values from an env file. The last definition of a key wins, matching dotenv. */
export function readEnvFileValues(file: string): Record<string, string> {
  if (!fileExists(file)) return {};
  const values: Record<string, string> = {};
  for (const entry of parseEnvFile(readEnvFileText(file)).entries) values[entry.key] = entry.value;
  return values;
}

function readEnvFileText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export interface EnvLoadResult {
  /** Env files that existed and were read. */
  files: string[];
  /** Variables that came from a file (already-set variables are left alone). */
  keys: string[];
}

/**
 * Fills `env` from the given files without overriding values the process
 * already has, so `MY_KEY=... bluebird` and CI variables always win.
 */
export function loadEnvFiles(files: readonly string[], env: NodeJS.ProcessEnv = process.env): EnvLoadResult {
  const loaded: string[] = [];
  const keys: string[] = [];
  for (const file of files) {
    if (!fileExists(file)) continue;
    loaded.push(file);
    for (const entry of parseEnvFile(readEnvFileText(file)).entries) {
      if (env[entry.key] !== undefined) continue;
      env[entry.key] = entry.value;
      keys.push(entry.key);
    }
  }
  return { files: loaded, keys };
}

export type EnvWriteAction = "created" | "appended" | "updated" | "unchanged";

export interface EnvWriteResult {
  path: string;
  key: string;
  action: EnvWriteAction;
  /** False when the file already held this exact key and value. */
  changed: boolean;
}

const ENV_FILE_HEADER = "# Local secrets for Blue Bird — keep this file out of version control";

function envLine(key: string, value: string, eol: string): string {
  return `${key}=${formatValue(value)}${eol}`;
}

/**
 * Writes `key=value` into a dotenv file, checking what is already there first:
 * an existing key is updated in place, never appended a second time, and an
 * identical value leaves the file byte-for-byte untouched.
 */
export function upsertEnvVar(file: string, key: string, value: string): EnvWriteResult {
  if (!isEnvVarName(key)) {
    throw new ConfigError(`"${key}" is not a valid environment variable name`, {
      hint: "Use letters, digits and underscores, starting with a letter or underscore (for example OPENAI_API_KEY).",
    });
  }

  const exists = fileExists(file);
  const existing = exists ? readEnvFileText(file) : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  // Preserve the file's own permissions; a brand new secrets file is 0600.
  const mode = exists ? fs.statSync(file).mode & 0o777 : 0o600;
  const parsed = parseEnvFile(existing);
  const matches = parsed.entries.filter((entry) => entry.key === key);
  const current = matches[matches.length - 1];

  if (current && current.value === value) {
    return { path: file, key, action: "unchanged", changed: false };
  }

  if (current) {
    const lines = [...parsed.lines];
    lines[current.line] = envLine(key, value, parsed.lines[current.line]!.endsWith("\n") ? eol : "");
    writeFileAtomic(file, lines.join(""), { mode });
    return { path: file, key, action: "updated", changed: true };
  }

  if (!existing) {
    writeFileAtomic(file, `${ENV_FILE_HEADER}\n${envLine(key, value, eol)}`, { mode });
    return { path: file, key, action: "created", changed: true };
  }

  const lines = [...parsed.lines];
  const last = lines[lines.length - 1];
  if (last !== undefined && !last.endsWith("\n")) lines[lines.length - 1] = `${last}${eol}`;
  lines.push(envLine(key, value, eol));
  writeFileAtomic(file, lines.join(""), { mode });
  return { path: file, key, action: "appended", changed: true };
}

/** Human-readable one-liner for an upsert, used by `bluebird init`. */
export function describeEnvWrite(result: EnvWriteResult): string {
  switch (result.action) {
    case "created":
      return `created ${result.path} with ${result.key}`;
    case "appended":
      return `appended ${result.key} to ${result.path}`;
    case "updated":
      return `updated ${result.key} in ${result.path}`;
    case "unchanged":
      return `${result.key} in ${result.path} already holds this value — left unchanged`;
  }
}
