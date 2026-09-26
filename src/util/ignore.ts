import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A parsed gitignore pattern together with its compiled matcher. */
export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
  source: string;
}

/** Options for {@link IgnoreMatcher}. */
export interface IgnoreMatcherOptions {
  /** Include the built-in cache and dependency ignores. Defaults to true. */
  builtin?: boolean;
}

/** Default noise that is never worth walking: dependencies, caches and VCS metadata. */
export const BUILTIN_IGNORES: readonly string[] = Object.freeze([
  "node_modules/",
  ".git/",
  ".hg/",
  ".svn/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "venv/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".ruff_cache/",
  ".gradle/",
  ".idea/",
  ".vscode/",
  ".terraform/",
  "vendor/",
  ".pnpm-store/",
  ".parcel-cache/",
  ".svelte-kit/",
  ".angular/",
  "tmp/",
  ".tmp/",
  "*.pyc",
  "*.log",
  ".DS_Store",
]);

const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/;
const CLASS_SPECIAL = /[\]\\^-]/;

function escapeRegexChar(ch: string): string {
  return REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
}

function escapeClassChar(ch: string): string {
  return CLASS_SPECIAL.test(ch) ? `\\${ch}` : ch;
}

/** Strips trailing spaces/tabs unless they are backslash-escaped, per gitignore rules. */
function stripTrailingWhitespace(line: string): string {
  let end = line.length;
  while (end > 0) {
    const ch = line[end - 1];
    if (ch !== " " && ch !== "\t") break;
    let backslashes = 0;
    for (let i = end - 2; i >= 0 && line[i] === "\\"; i -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

/** Reads a `[...]` character class starting at `[`; returns undefined when unterminated. */
function readCharClass(pattern: string, start: number): { source: string; next: number } | undefined {
  const length = pattern.length;
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i += 1;
  }
  let body = "";
  let closed = false;
  if (pattern[i] === "]") {
    body += "\\]";
    i += 1;
  }
  while (i < length) {
    const ch = pattern[i];
    if (ch === "]") {
      closed = true;
      i += 1;
      break;
    }
    if (ch === "\\") {
      if (i + 1 < length) {
        body += escapeClassChar(pattern[i + 1]);
        i += 2;
      } else {
        body += "\\\\";
        i += 1;
      }
    } else if (ch === "^" || ch === "[" || ch === "]") {
      body += `\\${ch}`;
      i += 1;
    } else {
      body += ch;
      i += 1;
    }
  }
  if (!closed) return undefined;
  return { source: `[${negate ? "^" : ""}${body}]`, next: i };
}

/** Translates one gitignore glob (anchor and trailing slash already removed) into regex source. */
function compilePattern(pattern: string): string {
  const length = pattern.length;
  let out = "";
  let i = 0;
  while (i < length) {
    const ch = pattern[i];
    if (ch === "*") {
      let stars = 0;
      while (i < length && pattern[i] === "*") {
        stars += 1;
        i += 1;
      }
      const atSegmentStart = out.length === 0 || out.endsWith("/");
      const nextIsSlash = i < length && pattern[i] === "/";
      if (stars >= 2 && atSegmentStart && nextIsSlash) {
        i += 1;
        out += "(?:[^/]*/)*";
      } else if (stars >= 2 && atSegmentStart && i >= length) {
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const cls = readCharClass(pattern, i);
      if (cls === undefined) {
        out += "\\[";
        i += 1;
      } else {
        out += cls.source;
        i = cls.next;
      }
    } else if (ch === "\\") {
      if (i + 1 < length) {
        out += escapeRegexChar(pattern[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      out += escapeRegexChar(ch);
      i += 1;
    }
  }
  return out;
}

/** Parses a single gitignore line into a rule, or undefined for comments/blank/empty patterns. */
function parseRule(raw: string, source: string): IgnoreRule | undefined {
  if (raw.length === 0 || raw[0] === "#") return undefined;
  let line = raw;
  let negated = false;
  if (line[0] === "!") {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }
  line = stripTrailingWhitespace(line);
  if (line.length === 0) return undefined;
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return undefined;
  let anchored = line.includes("/");
  if (line.startsWith("/")) {
    anchored = true;
    line = line.slice(1);
  }
  if (line.length === 0) return undefined;
  const prefix = anchored ? "^" : "^(?:.*/)?";
  const regex = new RegExp(`${prefix}${compilePattern(line)}$`);
  return { pattern: raw, negated, dirOnly, anchored, regex, source };
}

/** Normalizes a root-relative path to posix form without leading/trailing slashes. */
function normalizeRel(value: string): string {
  let rel = value.replace(/\\/g, "/");
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (rel.startsWith("/")) rel = rel.replace(/^\/+/, "");
  if (rel.endsWith("/")) rel = rel.replace(/\/+$/, "");
  if (rel === ".") return "";
  return rel;
}

/**
 * Gitignore-compatible matcher with per-directory rule precedence.
 * Rules from deeper base directories override shallower ones and later rules override
 * earlier ones. A negation can re-include a file only when no ancestor directory is excluded.
 */
export class IgnoreMatcher {
  readonly root: string;
  private readonly ruleList: IgnoreRule[] = [];
  private readonly byDir = new Map<string, IgnoreRule[]>();
  private readonly sourceList: string[] = [];

  constructor(root: string, options: IgnoreMatcherOptions = {}) {
    this.root = resolve(root);
    if (options.builtin ?? true) {
      this.addLines(BUILTIN_IGNORES, "", "<builtin>");
    }
  }

  /** Every parsed rule in load order. */
  get rules(): readonly IgnoreRule[] {
    return this.ruleList;
  }

  /** Labels of each file or pattern source that contributed rules. */
  get sources(): readonly string[] {
    return this.sourceList;
  }

  /** Parse gitignore syntax: comments, blank lines, `!` negation, trailing `/` (dir only), leading `/` (anchored), `**`, `*`, `?`, `[a-z]`, and escaped chars. */
  addLines(lines: readonly string[], baseDir: string, source = ""): void {
    const dir = normalizeRel(baseDir);
    if (source.length > 0 && !this.sourceList.includes(source)) this.sourceList.push(source);
    let bucket = this.byDir.get(dir);
    if (bucket === undefined) {
      bucket = [];
      this.byDir.set(dir, bucket);
    }
    for (const line of lines) {
      const rule = parseRule(line, source);
      if (rule === undefined) continue;
      bucket.push(rule);
      this.ruleList.push(rule);
    }
  }

  /** Read a gitignore-style file if it exists (silently ignore ENOENT). */
  addFile(filePath: string, source?: string): void {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    this.addLines(content.split(/\r\n|\r|\n/), this.baseDirFor(filePath), source ?? filePath);
  }

  /** Must be called for directories as well as files. `relPath` must be relative to root, posix separators. */
  ignores(relPath: string, isDir: boolean): boolean {
    const rel = normalizeRel(relPath);
    if (rel.length === 0) return false;
    const parts = rel.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join("/");
      if (this.matchLevel(ancestor, true) === "ignored") return true;
    }
    return this.matchLevel(rel, isDir) === "ignored";
  }

  /** Decides one path level by evaluating every applicable base directory, shallow to deep. */
  private matchLevel(rel: string, isDir: boolean): "ignored" | "included" | "unset" {
    const parts = rel.split("/");
    let decision: "ignored" | "included" | "unset" = "unset";
    for (let depth = 0; depth < parts.length; depth += 1) {
      const baseDir = depth === 0 ? "" : parts.slice(0, depth).join("/");
      const bucket = this.byDir.get(baseDir);
      if (bucket === undefined) continue;
      const sub = depth === 0 ? rel : parts.slice(depth).join("/");
      for (const rule of bucket) {
        if (rule.dirOnly && !isDir) continue;
        if (!rule.regex.test(sub)) continue;
        decision = rule.negated ? "included" : "ignored";
      }
    }
    return decision;
  }

  /** Base directory (root-relative) that a gitignore file governs. Files outside root act as root-level. */
  private baseDirFor(filePath: string): string {
    const rel = relative(this.root, dirname(resolve(filePath)));
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return "";
    return rel.split(sep).join("/");
  }
}

/** Loads, in order: builtin defaults, `<root>/.gitignore`, `<root>/.git/info/exclude`, `<root>/.bluebirdignore`, `<root>/.ignore`, and (when present) `~/.config/git/ignore`. Nested `.gitignore` files inside subdirectories are added lazily by the walker via {@link IgnoreMatcher.addFile}. */
export function loadIgnoreMatcher(
  root: string,
  options: { extraPatterns?: string[]; respectGitIgnore?: boolean } = {},
): IgnoreMatcher {
  const matcher = new IgnoreMatcher(root);
  const respectGit = options.respectGitIgnore ?? true;
  if (respectGit) {
    matcher.addFile(join(root, ".gitignore"), ".gitignore");
    matcher.addFile(join(root, ".git", "info", "exclude"), ".git/info/exclude");
  }
  matcher.addFile(join(root, ".bluebirdignore"), ".bluebirdignore");
  matcher.addFile(join(root, ".ignore"), ".ignore");
  if (respectGit) {
    matcher.addFile(join(homedir(), ".config", "git", "ignore"), "~/.config/git/ignore");
  }
  if (options.extraPatterns !== undefined && options.extraPatterns.length > 0) {
    matcher.addLines(options.extraPatterns, "", "<extra>");
  }
  return matcher;
}

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "icns",
  "webp",
  "avif",
  "tif",
  "tiff",
  "heic",
  "heif",
  "psd",
  "raw",
  "svgz",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "lz4",
  "lzma",
  "zst",
  "7z",
  "rar",
  "tar",
  "jar",
  "war",
  "ear",
  "iso",
  "dmg",
  "cab",
  "msi",
  "deb",
  "rpm",
  "apk",
  "ipa",
  "nupkg",
  "crx",
  "pak",
  "ttf",
  "ttc",
  "otf",
  "woff",
  "woff2",
  "eot",
  "pfb",
  "pfm",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "a",
  "obj",
  "lib",
  "class",
  "pyc",
  "pyo",
  "wasm",
  "node",
  "dat",
  "sqlite",
  "sqlite3",
  "db",
  "mp3",
  "mp4",
  "m4a",
  "m4v",
  "wav",
  "flac",
  "ogg",
  "oga",
  "ogv",
  "opus",
  "aac",
  "wma",
  "aiff",
  "mid",
  "midi",
  "avi",
  "mov",
  "mkv",
  "webm",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "3gp",
  "swf",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub",
  "rtf",
]);

/** True when the path should be treated as binary/ignored-for-reading based on extension alone (images, archives, fonts, executables, media; lockfiles and text formats are not excluded). */
export function isBinaryPath(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
