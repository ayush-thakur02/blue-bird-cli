import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const WORKSPACE_MARKERS = [".git", ".bluebird", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", ".hg"];

/** Directories that are never a project root, so the search must not climb through them. */
const ROOT_BOUNDARIES = new Set(["/tmp", "/var", "/usr", "/etc", "/opt", "/home", "/Users", "/mnt", "/media", "/dev", "/proc", "/sys"]);

export function isProjectBoundary(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (ROOT_BOUNDARIES.has(resolved)) return true;
  const home = os.homedir();
  if (path.resolve(home) === resolved) return true;
  return false;
}

function isBoundary(dir: string): boolean {
  return isProjectBoundary(dir);
}

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Blue Bird config directory: `BLUEBIRD_HOME` override or `~/.bluebird`.
 */
export function bluebirdHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BLUEBIRD_HOME;
  if (override) return expandHome(override);
  return path.join(os.homedir(), ".bluebird");
}

/**
 * Resolve `target` (after home expansion) against a base directory.
 */
export function resolveFrom(base: string, target: string): string {
  return path.resolve(base, expandHome(target));
}

/**
 * Whether `child` is `parent` or lives inside it, without prefix false positives.
 */
export function isInside(parent: string, child: string): boolean {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  if (parentResolved === childResolved) return true;
  const rel = path.relative(parentResolved, childResolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Path of `to` relative to `from`.
 */
export function relativePath(from: string, to: string): string {
  return path.relative(from, to);
}

/**
 * Display path: relative to cwd when inside, `~/...` under home, else absolute.
 */
export function displayPath(cwd: string, absolute: string): string {
  const cwdResolved = path.resolve(cwd);
  const target = path.resolve(absolute);
  if (isInside(cwdResolved, target)) {
    const rel = path.relative(cwdResolved, target);
    return rel === "" ? "." : rel;
  }
  const home = os.homedir();
  if (isInside(home, target)) {
    const rel = path.relative(home, target);
    return rel === "" ? "~" : `~/${rel}`;
  }
  return target;
}

/**
 * Nearest ancestor (including start) that contains one of the named entries; returns the entry path.
 */
export function findUp(startDir: string, names: readonly string[]): string | undefined {
  let dir = path.resolve(startDir);
  while (true) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Nearest ancestor containing a project marker, else the starting directory.
 */
export function findWorkspaceRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let dir = start;
  while (true) {
    if (isBoundary(dir)) return start;
    for (const marker of WORKSPACE_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || isBoundary(parent)) return start;
    dir = parent;
  }
}

/**
 * Stable, filesystem-safe slug: basename plus the first 8 hex of the real path hash.
 */
export function projectSlug(dir: string): string {
  const real = safeRealPath(dir);
  const base = path.basename(real) || "root";
  return `${safeFileName(base, "-")}-${hashShort(real, 8)}`;
}

/**
 * Create a directory tree if it does not already exist.
 */
export function ensureDirSync(dir: string): void {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Whether a path exists.
 */
export function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

/**
 * Whether a path exists and is a directory.
 */
export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a path exists and is a regular file.
 */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Parse a JSON file, returning undefined on missing files or parse errors.
 */
export function readJsonSync<T>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Atomically write a string to a file (temp file plus rename).
 */
export function writeFileAtomic(p: string, data: string, opts: { mode?: number } = {}): void {
  ensureDirSync(path.dirname(p));
  const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
    fs.renameSync(tmp, p);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* cleanup failure is not fatal */
    }
    throw error;
  }
}

/**
 * Atomically write pretty-printed JSON with a trailing newline.
 */
export function writeJsonAtomic(p: string, value: unknown, opts: { mode?: number } = {}): void {
  writeFileAtomic(p, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/**
 * Hex sha256 prefix of the input.
 */
export function hashShort(input: string, length = 12): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/**
 * Replace characters unsafe for filenames, collapsing runs of the replacement.
 */
export function safeFileName(name: string, replacement = "_"): string {
  const replaced = name.replace(/[^A-Za-z0-9._-]+/g, replacement);
  const collapsed = replacement ? replaced.split(replacement).filter(Boolean).join(replacement) : replaced;
  const trimmed = collapsed.replace(/^[.\s]+/, "").slice(0, 200);
  return trimmed || "file";
}

/**
 * File names (not directories) directly inside a directory, sorted.
 */
export function listFilesSync(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Real path, falling back to a lexical resolve when the target is missing.
 */
export function safeRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Real path of the deepest ancestor that exists, with the missing tail re-appended.
 * Lets a not-yet-created file be contained by its real parent directory.
 */
export function realPathOfExistingPrefix(target: string): string {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Symlink-aware containment. `isInside` alone is lexical, so a symlink placed in
 * the workspace could point at `/etc` and pass the check; this resolves both
 * sides first so the real location decides.
 */
export function containsPath(parent: string, child: string): boolean {
  if (!isInside(parent, child)) return false;
  const realParent = safeRealPath(parent);
  const realChild = realPathOfExistingPrefix(child);
  return realParent === realChild || isInside(realParent, realChild);
}

/**
 * Convert backslashes to forward slashes.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Canonical path comparison form: posix real path, lowercased on case-insensitive filesystems.
 */
export function normalizeForCompare(p: string): string {
  const value = toPosix(safeRealPath(p));
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

/**
 * Create and return a unique scratch directory under the OS temp directory.
 */
export function tmpDir(prefix = "bluebird-"): string {
  const dir = path.join(os.tmpdir(), prefix + randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Recursively remove a directory, ignoring missing paths.
 */
export function removeDirSync(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Recursively copy a directory tree, optionally filtering source paths.
 */
export function copyDirSync(src: string, dest: string, filter?: (src: string) => boolean): void {
  if (filter && !filter(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    if (filter && !filter(from)) continue;
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(from, to, filter);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}
