const ELLIPSIS = "\u2026";

/**
 * Shorten text to `max` characters, appending an ellipsis when clipped.
 */
export function truncate(text: string, max: number, ellipsis: string = ELLIPSIS): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (ellipsis.length >= max) return ellipsis.slice(0, max);
  return text.slice(0, max - ellipsis.length) + ellipsis;
}

/**
 * Shorten text to `max` characters, keeping both the start and the end.
 */
export function truncateMiddle(text: string, max: number, ellipsis: string = ELLIPSIS): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (ellipsis.length >= max) return ellipsis.slice(0, max);
  const room = max - ellipsis.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return text.slice(0, head) + ellipsis + (tail > 0 ? text.slice(text.length - tail) : "");
}

/**
 * Keep at most `maxLines` lines, appending a note line when lines were dropped.
 */
export function truncateLines(
  text: string,
  maxLines: number,
  note?: string,
): { text: string; truncated: boolean } {
  if (maxLines <= 0) return { text: "", truncated: text.length > 0 };
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  const kept = lines.slice(0, maxLines);
  const dropped = lines.length - maxLines;
  const footer = note ?? `${ELLIPSIS} (${dropped} more ${dropped === 1 ? "line" : "lines"})`;
  return { text: [...kept, footer].join("\n"), truncated: true };
}

/**
 * Number of `\n`-separated lines; 0 for an empty string.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/**
 * Prefix every line with `prefix`, optionally leaving the first untouched.
 */
export function indent(text: string, prefix: string, opts: { skipFirst?: boolean } = {}): string {
  if (text === "") return "";
  return text
    .split("\n")
    .map((line, index) => (opts.skipFirst && index === 0 ? line : prefix + line))
    .join("\n");
}

/**
 * Escape a string for safe embedding in a regular expression.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lowercase, dash-separated, filesystem-safe identifier capped at 60 characters.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, 60).replace(/-+$/, "");
}

function trimNumber(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Human-readable byte size using binary units.
 */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = abs / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${sign}${trimNumber(value, digits)} ${units[unit]}`;
}

/**
 * Compact count such as "999", "1.2k", "3.4M".
 */
export function formatCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${n}`;
  if (abs < 1_000_000) return `${sign}${trimNumber(abs / 1000, 1)}k`;
  if (abs < 1_000_000_000) return `${sign}${trimNumber(abs / 1_000_000, 1)}M`;
  return `${sign}${trimNumber(abs / 1_000_000_000, 1)}B`;
}

/**
 * Compact duration such as "480ms", "2.1s", "1m 5s", "1h 1m".
 */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const value = Math.abs(ms);
  if (value < 1000) return `${sign}${Math.round(value)}ms`;
  if (value < 60_000) return `${sign}${trimNumber(value / 1000, 1)}s`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1000);
    return seconds > 0 ? `${sign}${minutes}m ${seconds}s` : `${sign}${minutes}m`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return minutes > 0 ? `${sign}${hours}h ${minutes}m` : `${sign}${hours}h`;
}

/**
 * US-dollar cost with more precision for sub-cent amounts; never scientific notation.
 */
export function formatCost(usd: number): string {
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  if (abs !== 0 && abs < 1) {
    const precise = abs.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    const decimals = precise.includes(".") ? precise.split(".")[1]!.length : 0;
    return `${sign}$${decimals >= 2 ? precise : abs.toFixed(2)}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format a 0..1 ratio as a percentage string.
 */
export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Quantity with a correctly inflected noun.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const noun = count === 1 ? singular : plural ?? `${singular}s`;
  return `${count} ${noun}`;
}

/**
 * Turn snake_case, kebab-case or spaced text into Title Case.
 */
export function titleCase(text: string): string {
  return text
    .split(/[_\s-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Deduplicate items preserving first-seen order.
 */
export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * Bucket items by a derived string key.
 */
export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function sliceOuter(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function repairJson(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Best-effort JSON parse: raw text, fenced code blocks, first object/array slice, trailing-comma repair.
 */
export function parseJsonLoose<T>(text: string): T | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const candidates: string[] = [trimmed];
  const fenced = /```[^\n`]*\n([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const objectSlice = sliceOuter(trimmed, "{", "}");
  if (objectSlice) candidates.push(objectSlice);
  const arraySlice = sliceOuter(trimmed, "[", "]");
  if (arraySlice) candidates.push(arraySlice);
  for (const candidate of candidates) {
    for (const variant of [candidate, repairJson(candidate)]) {
      const parsed = tryParse(variant);
      if (parsed.ok) return parsed.value as T;
    }
  }
  return undefined;
}

/**
 * Remove trailing slashes, preserving a bare root slash.
 */
export function stripTrailingSlash(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * Collapse runs of whitespace to single spaces and trim the ends.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Longest common leading substring shared by all inputs.
 */
export function commonPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0]!;
  for (let i = 1; i < paths.length; i += 1) {
    const value = paths[i]!;
    let j = 0;
    const limit = Math.min(prefix.length, value.length);
    while (j < limit && prefix[j] === value[j]) j += 1;
    prefix = prefix.slice(0, j);
    if (prefix === "") break;
  }
  return prefix;
}

/**
 * Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]!;
}

/**
 * Closest candidate by normalized similarity, or undefined below `threshold`.
 */
export function bestMatch(input: string, candidates: readonly string[], threshold = 0.6): string | undefined {
  const needle = input.toLowerCase();
  let best: string | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (candidate === input) return candidate;
    const haystack = candidate.toLowerCase();
    const distance = levenshtein(needle, haystack);
    const score = 1 - distance / Math.max(needle.length, haystack.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= threshold ? best : undefined;
}

/**
 * Content of the first (optionally language-matched) fenced code block.
 */
export function extractCodeBlock(text: string, lang?: string): string | undefined {
  const re = /```([^\n`]*)\n?([\s\S]*?)```/g;
  const wanted = lang?.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const info = (match[1] ?? "").trim().toLowerCase();
    if (wanted === undefined) return (match[2] ?? "").replace(/\n$/, "");
    if (info === wanted || info.split(/[\s,{]/)[0] === wanted) return (match[2] ?? "").replace(/\n$/, "");
  }
  return undefined;
}

/**
 * Whether the text begins with any of the prefixes.
 */
export function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

/**
 * Copy of the items ordered by score.
 */
export function sortBy<T>(items: readonly T[], score: (item: T) => number, direction: "asc" | "desc" = "asc"): T[] {
  const factor = direction === "desc" ? -1 : 1;
  return [...items].sort((a, b) => (score(a) - score(b)) * factor);
}

/**
 * Trailing-edge debounced wrapper that keeps the latest arguments.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function globSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "*") {
      let stars = 1;
      while (pattern[i + 1] === "*") {
        stars += 1;
        i += 1;
      }
      if (stars >= 2) {
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      let cls = "";
      if (pattern[j] === "!" || pattern[j] === "^") {
        cls += "^";
        j += 1;
      }
      if (pattern[j] === "]") {
        cls += "\\]";
        j += 1;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const ch = pattern[j]!;
        cls += ch === "\\" ? "\\\\" : ch;
        j += 1;
      }
      if (j >= pattern.length) {
        out += "\\[";
      } else {
        out += `[${cls}]`;
        i = j;
      }
    } else if (c === "{") {
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < pattern.length && depth > 0) {
        const ch = pattern[j]!;
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += ch;
        j += 1;
      }
      if (depth !== 0) {
        out += "\\{";
      } else {
        out += `(?:${splitTopLevel(body).map(globSource).join("|")})`;
        i = j;
      }
    } else if (".+^$()|\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

const globCache = new Map<string, RegExp>();

function globRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(`^${globSource(pattern)}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

/**
 * Glob match supporting `*`, `**`, `?`, `{a,b}` and `[abc]`.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedValue = value.replace(/\\/g, "/");
  return globRegExp(normalizedPattern).test(normalizedValue);
}

/**
 * Whether any glob in the list matches the value.
 */
export function matchesAnyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, value));
}

/**
 * Current time as an ISO-8601 string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Human-readable duration since a start timestamp in milliseconds.
 */
export function elapsed(startedAt: number): string {
  return formatDuration(Date.now() - startedAt);
}
