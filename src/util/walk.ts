import { execFile } from "node:child_process";
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IgnoreMatcher } from "./ignore.ts";

/** Options accepted by {@link walkFiles} and {@link walkFilesSync}. */
export interface WalkOptions {
  root: string;
  ignore?: IgnoreMatcher;
  /** Maximum directory depth below root. Defaults to 24. */
  maxDepth?: number;
  /** Maximum number of directory entries to scan. Defaults to 250_000. */
  maxEntries?: number;
  signal?: AbortSignal;
  /** Collect directories (excluding root) in {@link WalkResult.dirs}. */
  includeDirectories?: boolean;
  /** Descend into symlinked directories. Defaults to false. */
  followSymlinks?: boolean;
  /** Called per directory entry; return false to skip descending (dirs) or to skip collecting (files). */
  filter?: (absPath: string, isDir: boolean, relPath: string) => boolean;
  /** Collect nested `.gitignore` files as they are encountered (default true when an IgnoreMatcher is given). */
  nestedIgnoreFiles?: boolean;
}

/** Outcome of a walk. Paths are absolute and ordered by a depth-first, case-insensitive name sort. */
export interface WalkResult {
  files: string[];
  dirs: string[];
  truncated: boolean;
  scanned: number;
  durationMs: number;
  skippedIgnored: number;
}

interface WalkState {
  files: string[];
  dirs: string[];
  scanned: number;
  skippedIgnored: number;
  truncated: boolean;
  visited: Set<string>;
}

/** Case-insensitive name comparison with a deterministic case-sensitive tie-breaker. */
function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA < lowerB) return -1;
  if (lowerA > lowerB) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function finish(state: WalkState, started: number): WalkResult {
  return {
    files: state.files,
    dirs: state.dirs,
    truncated: state.truncated,
    scanned: state.scanned,
    durationMs: Date.now() - started,
    skippedIgnored: state.skippedIgnored,
  };
}

/** Depth-first walk returning absolute file paths (and optionally directories) in deterministic order. */
export async function walkFiles(options: WalkOptions): Promise<WalkResult> {
  const started = Date.now();
  const root = resolve(options.root);
  const maxDepth = options.maxDepth ?? 24;
  const maxEntries = options.maxEntries ?? 250_000;
  const includeDirectories = options.includeDirectories ?? false;
  const followSymlinks = options.followSymlinks ?? false;
  const nestedIgnoreFiles = options.nestedIgnoreFiles ?? options.ignore !== undefined;
  const signal = options.signal;
  const state: WalkState = { files: [], dirs: [], scanned: 0, skippedIgnored: 0, truncated: false, visited: new Set() };

  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (state.truncated) return;
    if (followSymlinks) {
      let real: string;
      try {
        real = await realpath(absDir);
      } catch {
        return;
      }
      if (state.visited.has(real)) return;
      state.visited.add(real);
    }
    if (depth > 0 && nestedIgnoreFiles && options.ignore !== undefined) {
      options.ignore.addFile(join(absDir, ".gitignore"), relDir.length > 0 ? `${relDir}/.gitignore` : ".gitignore");
    }
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (state.scanned >= maxEntries) {
        state.truncated = true;
        return;
      }
      state.scanned += 1;
      signal?.throwIfAborted();
      const absPath = join(absDir, entry.name);
      const relPath = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try {
          const info = await stat(absPath);
          isDir = info.isDirectory();
          isFile = info.isFile();
        } catch {
          continue;
        }
      }
      if (!isDir && !isFile) continue;
      if (options.ignore !== undefined && options.ignore.ignores(relPath, isDir)) {
        state.skippedIgnored += 1;
        continue;
      }
      if (!isDir) {
        if (options.filter !== undefined && !options.filter(absPath, false, relPath)) continue;
        state.files.push(absPath);
        continue;
      }
      const descend = options.filter === undefined || options.filter(absPath, true, relPath);
      if (includeDirectories) state.dirs.push(absPath);
      if (descend && depth < maxDepth) await walk(absPath, relPath, depth + 1);
    }
  };

  await walk(root, "", 0);
  return finish(state, started);
}

/** Synchronous counterpart of {@link walkFiles} with identical ordering and filtering semantics. */
export function walkFilesSync(options: WalkOptions): WalkResult {
  const started = Date.now();
  const root = resolve(options.root);
  const maxDepth = options.maxDepth ?? 24;
  const maxEntries = options.maxEntries ?? 250_000;
  const includeDirectories = options.includeDirectories ?? false;
  const followSymlinks = options.followSymlinks ?? false;
  const nestedIgnoreFiles = options.nestedIgnoreFiles ?? options.ignore !== undefined;
  const signal = options.signal;
  const state: WalkState = { files: [], dirs: [], scanned: 0, skippedIgnored: 0, truncated: false, visited: new Set() };

  const walk = (absDir: string, relDir: string, depth: number): void => {
    signal?.throwIfAborted();
    if (state.truncated) return;
    if (followSymlinks) {
      let real: string;
      try {
        real = realpathSync(absDir);
      } catch {
        return;
      }
      if (state.visited.has(real)) return;
      state.visited.add(real);
    }
    if (depth > 0 && nestedIgnoreFiles && options.ignore !== undefined) {
      options.ignore.addFile(join(absDir, ".gitignore"), relDir.length > 0 ? `${relDir}/.gitignore` : ".gitignore");
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (state.scanned >= maxEntries) {
        state.truncated = true;
        return;
      }
      state.scanned += 1;
      signal?.throwIfAborted();
      const absPath = join(absDir, entry.name);
      const relPath = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try {
          const info = statSync(absPath);
          isDir = info.isDirectory();
          isFile = info.isFile();
        } catch {
          continue;
        }
      }
      if (!isDir && !isFile) continue;
      if (options.ignore !== undefined && options.ignore.ignores(relPath, isDir)) {
        state.skippedIgnored += 1;
        continue;
      }
      if (!isDir) {
        if (options.filter !== undefined && !options.filter(absPath, false, relPath)) continue;
        state.files.push(absPath);
        continue;
      }
      const descend = options.filter === undefined || options.filter(absPath, true, relPath);
      if (includeDirectories) state.dirs.push(absPath);
      if (descend && depth < maxDepth) walk(absPath, relPath, depth + 1);
    }
  };

  walk(root, "", 0);
  return finish(state, started);
}

/** Reads up to `maxBytes` of a file, detecting binary content and stripping a UTF-8 BOM. */
export async function readTextFile(
  filePath: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<{ text: string; bytes: number; bytesRead: number; truncated: boolean; binary: boolean }> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  options.signal?.throwIfAborted();
  const info = await stat(filePath);
  const bytes = info.size;
  const toRead = Math.max(0, Math.min(bytes, maxBytes));
  let buffer = Buffer.allocUnsafe(toRead);
  let bytesRead = 0;
  const handle = await open(filePath, "r");
  try {
    if (toRead > 0) {
      const result = await handle.read(buffer, 0, toRead, 0);
      bytesRead = result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (bytesRead < buffer.length) buffer = buffer.subarray(0, bytesRead);
  const probe = Math.min(bytesRead, 8000);
  let binary = false;
  for (let i = 0; i < probe; i += 1) {
    if (buffer[i] === 0) {
      binary = true;
      break;
    }
  }
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, bytes, bytesRead, truncated: bytes > bytesRead, binary };
}

/** Modification time in milliseconds since epoch. */
export async function fileMtimeMs(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.mtimeMs;
}

/** Synchronous counterpart of {@link fileMtimeMs}. */
export function fileMtimeMsSync(filePath: string): number {
  return statSync(filePath).mtimeMs;
}

/** Walks up from `startDir` looking for a `.git` entry; returns the repo root or undefined. */
export async function findGitRoot(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    try {
      const info = await stat(join(dir, ".git"));
      if (info.isDirectory() || info.isFile()) return dir;
    } catch {
      // keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseBranch(text: string): string | undefined {
  let value = text.trim();
  if (value.length === 0) return undefined;
  if (value.startsWith("No commits yet on ")) {
    value = value.slice("No commits yet on ".length);
  } else if (value.startsWith("Initial commit on ")) {
    value = value.slice("Initial commit on ".length);
  }
  if (value.startsWith("HEAD (no branch)")) return undefined;
  const dots = value.indexOf("...");
  if (dots >= 0) value = value.slice(0, dots);
  const space = value.indexOf(" ");
  if (space >= 0) value = value.slice(0, space);
  return value.length > 0 ? value : undefined;
}

function execGitStatus(cwd: string): Promise<{ stdout: string }> {
  return new Promise((settle, fail) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-b"],
      { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          fail(error);
          return;
        }
        settle({ stdout });
      },
    );
  });
}

/** Runs `git status --porcelain=v1 -b`; never throws, reporting `isRepo:false` when git is missing or the directory is not a repository. */
export async function gitStatusFiles(
  root: string,
): Promise<{ branch?: string; statuses: string[]; isRepo: boolean }> {
  try {
    const { stdout } = await execGitStatus(resolve(root));
    const statuses: string[] = [];
    let branch: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.length === 0) continue;
      if (line.startsWith("## ")) {
        branch = parseBranch(line.slice(3));
        continue;
      }
      statuses.push(line);
    }
    return { branch, statuses, isRepo: true };
  } catch {
    return { statuses: [], isRepo: false };
  }
}
