import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../util/errors.ts";
import { relativePath, resolveFrom } from "../util/paths.ts";
import { escapeRegExp, matchesGlob, truncate } from "../util/text.ts";
import { fileMtimeMsSync, walkFiles } from "../util/walk.ts";
import { loadIgnoreMatcher } from "../util/ignore.ts";
import { optionalBoolean, optionalNumber, optionalString, requiredString } from "./args.ts";
import { defineTool, type ToolContext } from "./types.ts";
import { ensureInsideWorkspace } from "./workspace.ts";

const DEFAULT_GLOB_LIMIT = 300;
const DEFAULT_MATCH_LIMIT = 200;
/** Longest line handed to a user-supplied regex, bounding backtracking cost. */
const MAX_REGEX_LINE = 20_000;
/** Wall-clock budget for one search, so a pathological pattern cannot hang the CLI. */
const SEARCH_DEADLINE_MS = 30_000;

function assertInside(ctx: ToolContext, absolute: string): void {
  ensureInsideWorkspace(ctx, absolute, "search");
}

/**
 * Rejects the nested-quantifier shapes that make a regex backtrack
 * exponentially against non-matching input (`(a+)+`, `(.*)*`, `(\w*){2,}`).
 */
export function hasNestedQuantifier(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern);
}

export const globTool = defineTool({
  name: "glob",
  label: "Glob",
  description:
    "Find files by glob pattern, e.g. `src/**/*.ts` or `**/{test,spec}/*.js`. Returns paths sorted by most recently modified. Respects .gitignore.",
  tags: ["search", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to `path`." },
      path: { type: "string", description: "Directory to search in. Defaults to the workspace root." },
      limit: { type: "number", description: `Maximum results (default ${DEFAULT_GLOB_LIMIT}).` },
    },
    required: ["pattern"],
  },
  describe(args) {
    return `${optionalString(args, "pattern") ?? "?"}${optionalString(args, "path") ? ` in ${optionalString(args, "path")}` : ""}`;
  },
  async execute(args, ctx) {
    const pattern = requiredString(args, ["pattern", "glob", "query"], "glob");
    const searchRoot = resolveFrom(ctx.cwd, optionalString(args, "path", "directory", "dir") ?? ctx.root);
    assertInside(ctx, searchRoot);
    const limit = Math.max(1, Math.min(optionalNumber(args, "limit") ?? DEFAULT_GLOB_LIMIT, 5000));

    const ignore = ctx.config.raw.ui?.respectGitIgnore === false ? undefined : loadIgnoreMatcher(searchRoot);
    const walk = await walkFiles({ root: searchRoot, ignore, signal: ctx.signal, maxEntries: 200_000 });
    const results: { path: string; mtime: number }[] = [];

    for (const file of walk.files) {
      const relative = relativePath(searchRoot, file);
      if (!matchesGlob(pattern, relative) && !matchesGlob(pattern, `./${relative}`)) continue;
      let mtime = 0;
      try {
        mtime = fileMtimeMsSync(file);
      } catch {
        mtime = 0;
      }
      results.push({ path: file, mtime });
    }

    results.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      return {
        content: `No files matched ${pattern} under ${relativePath(ctx.cwd, searchRoot) || "."}`,
        summary: "no matches",
      };
    }

    const listing = limited.map((entry) => relativePath(ctx.cwd, entry.path)).join("\n");
    const truncated = results.length > limited.length;
    // A partial walk reported as complete is worse than no answer: the model
    // would conclude a symbol does not exist.
    const walkNote = walk.truncated ? "\n\nNote: the directory walk hit its entry/depth limit, so this list may be incomplete." : "";
    return {
      content: `${limited.length} file${limited.length === 1 ? "" : "s"} matched${truncated ? ` (of ${results.length})` : ""}:\n${listing}${walkNote}`,
      summary: `${limited.length}${truncated ? `/${results.length}` : ""} files`,
      display: { kind: "list", title: pattern, lines: limited.map((entry) => relativePath(ctx.cwd, entry.path)) },
      meta: { truncated: truncated || walk.truncated },
    };
  },
});

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export const grepTool = defineTool({
  name: "grep",
  label: "Grep",
  description:
    "Search file contents with a regular expression. Modes: `content` (matching lines with line numbers), `files_with_matches` (paths only), `count`. Respects .gitignore, skips binaries, and supports context lines.",
  tags: ["search", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (ripgrep syntax)." },
      path: { type: "string", description: "File or directory to search. Defaults to the workspace root." },
      glob: { type: "string", description: "Restrict to files matching this glob, e.g. `*.ts` or `src/**`." },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Defaults to content." },
      ignore_case: { type: "boolean", description: "Case-insensitive search." },
      line_numbers: { type: "boolean", description: "Include line numbers (content mode, default true)." },
      context: { type: "number", description: "Lines of context before and after each match." },
      before: { type: "number", description: "Lines of context before each match." },
      after: { type: "number", description: "Lines of context after each match." },
      head_limit: { type: "number", description: `Maximum results (default ${DEFAULT_MATCH_LIMIT}).` },
      multiline: { type: "boolean", description: "Allow the pattern to span lines." },
    },
    required: ["pattern"],
  },
  describe(args) {
    const pattern = optionalString(args, "pattern") ?? "?";
    const target = optionalString(args, "path", "glob");
    return target ? `${truncate(pattern, 40)} in ${target}` : truncate(pattern, 60);
  },
  async execute(args, ctx) {
    const patternText = requiredString(args, ["pattern", "query", "regex"], "grep");
    const mode = (optionalString(args, "output_mode", "mode") ?? "content") as "content" | "files_with_matches" | "count";
    const flags = optionalBoolean(args, "ignore_case", "-i") ? "gi" : "g";
    const multiline = optionalBoolean(args, "multiline") ?? false;
    if (hasNestedQuantifier(patternText)) {
      throw new ToolError(`Pattern has a nested quantifier, which can hang the search: /${truncate(patternText, 80)}/`, {
        hint: "Rewrite it without a quantifier inside a quantified group, e.g. `(\\w+)+` becomes `\\w+`, or search for a literal substring.",
      });
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternText, multiline ? `${flags}s` : flags);
    } catch (error) {
      throw new ToolError(`Invalid regular expression: ${(error as Error).message}`, {
        hint: "Escape special characters such as ( ) [ ] { } . * + ? ^ $ |",
      });
    }

    const target = resolveFrom(ctx.cwd, optionalString(args, "path", "directory", "dir") ?? ctx.root);
    assertInside(ctx, target);
    const fileGlob = optionalString(args, "glob", "include");
    const headLimit = Math.max(1, Math.min(optionalNumber(args, "head_limit", "limit") ?? DEFAULT_MATCH_LIMIT, 5000));
    const contextBefore = optionalNumber(args, "before", "-B") ?? optionalNumber(args, "context", "-C") ?? 0;
    const contextAfter = optionalNumber(args, "after", "-A") ?? optionalNumber(args, "context", "-C") ?? 0;
    const showLineNumbers = optionalBoolean(args, "line_numbers", "-n") ?? true;

    const stats = fs.existsSync(target) ? fs.statSync(target) : undefined;
    const walk = stats?.isDirectory()
      ? await walkFiles({
          root: target,
          ignore: ctx.config.raw.ui?.respectGitIgnore === false ? undefined : loadIgnoreMatcher(target),
          signal: ctx.signal,
          maxEntries: 200_000,
        })
      : undefined;
    const files = walk ? walk.files : target ? [target] : [];

    const deadline = Date.now() + SEARCH_DEADLINE_MS;
    const matches: GrepMatch[] = [];
    const fileCounts = new Map<string, number>();
    const matchedFiles: string[] = [];
    let scanned = 0;
    let timedOut = false;

    for (const file of files) {
      if (ctx.signal.aborted) throw new Error("aborted");
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      const relative = relativePath(ctx.cwd, file);
      if (fileGlob && !matchesGlob(fileGlob, relative) && !matchesGlob(fileGlob, path.basename(file))) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > 4_000_000) continue;
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;
      scanned += 1;

      if (multiline) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        let found = 0;
        while ((match = pattern.exec(content)) !== null) {
          found += 1;
          const line = content.slice(0, match.index).split("\n").length;
          matches.push({ file, line, text: match[0].split("\n")[0]!.slice(0, 400), before: [], after: [] });
          if (matches.length >= headLimit) break;
          if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
        }
        if (found) {
          fileCounts.set(file, found);
          matchedFiles.push(file);
        }
        if (matches.length >= headLimit) break;
        continue;
      }

      const lines = content.split("\n");
      let fileMatches = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        // Testing a bounded slice keeps one enormous minified line from turning
        // a simple pattern into a multi-second scan.
        const tested = line.length > MAX_REGEX_LINE ? line.slice(0, MAX_REGEX_LINE) : line;
        pattern.lastIndex = 0;
        if (!pattern.test(tested)) continue;
        fileMatches += 1;
        if (mode === "content") {
          matches.push({
            file,
            line: index + 1,
            text: truncate(line, 400),
            before: contextBefore ? lines.slice(Math.max(0, index - contextBefore), index).map((entry) => truncate(entry, 300)) : [],
            after: contextAfter ? lines.slice(index + 1, index + 1 + contextAfter).map((entry) => truncate(entry, 300)) : [],
          });
        }
        if (matches.length >= headLimit) break;
      }
      if (fileMatches > 0) {
        fileCounts.set(file, fileMatches);
        matchedFiles.push(file);
      }
      if (matches.length >= headLimit) break;
    }

    if (matchedFiles.length === 0) {
      const notes = [timedOut ? `stopped after the ${SEARCH_DEADLINE_MS / 1000}s search budget` : "", walk?.truncated ? "the directory walk hit its limit" : ""].filter(Boolean);
      return {
        content: `No matches for /${patternText}/ in ${relativePath(ctx.cwd, target) || "."} (${scanned} files searched)${notes.length ? ` — ${notes.join("; ")}` : ""}`,
        summary: "no matches",
      };
    }

    if (mode === "files_with_matches") {
      const listing = matchedFiles.map((file) => relativePath(ctx.cwd, file)).join("\n");
      return {
        content: `${matchedFiles.length} file(s) matched /${patternText}/:\n${listing}`,
        summary: `${matchedFiles.length} files`,
        meta: { readFiles: matchedFiles.slice(0, 50) },
      };
    }

    if (mode === "count") {
      const rows = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
      const total = rows.reduce((sum, [, count]) => sum + count, 0);
      const listing = rows.map(([file, count]) => `${count}\t${relativePath(ctx.cwd, file)}`).join("\n");
      return {
        content: `${total} match(es) across ${rows.length} file(s):\n${listing}`,
        summary: `${total} matches`,
      };
    }

    const grouped = new Map<string, GrepMatch[]>();
    for (const match of matches) {
      const list = grouped.get(match.file) ?? [];
      list.push(match);
      grouped.set(match.file, list);
    }

    const chunks: string[] = [];
    for (const [file, fileMatches] of grouped) {
      const header = relativePath(ctx.cwd, file);
      const body = fileMatches
        .map((match) => {
          const lines: string[] = [];
          for (const [offset, text] of match.before.entries()) {
            lines.push(`${match.line - match.before.length + offset}-${text}`);
          }
          lines.push(showLineNumbers ? `${match.line}:${match.text}` : match.text);
          for (const [offset, text] of match.after.entries()) {
            lines.push(`${match.line + offset + 1}-${text}`);
          }
          return lines.join("\n");
        })
        .join("\n--\n");
      chunks.push(`${header}\n${body}`);
    }

    const header = `${matches.length} match(es) in ${grouped.size} file(s)${matches.length >= headLimit ? ` (stopped at the ${headLimit} result limit)` : ""}`;
    const notes = [
      timedOut ? `the search stopped after its ${SEARCH_DEADLINE_MS / 1000}s budget, so these results are partial` : "",
      walk?.truncated ? "the directory walk hit its entry limit, so the search was not exhaustive" : "",
    ].filter(Boolean);
    return {
      content: `${header}${notes.length ? `\n\nNote: ${notes.join("; ")}.` : ""}\n\n${chunks.join("\n\n")}`,
      summary: `${matches.length} matches · ${grouped.size} files`,
      display: {
        kind: "text",
        title: `/${truncate(patternText, 40)}/`,
        text: chunks.join("\n\n"),
        collapseAfter: 20,
      },
      meta: { readFiles: [...grouped.keys()].slice(0, 50), truncated: matches.length >= headLimit || timedOut || Boolean(walk?.truncated) },
    };
  },
});

export function literalPattern(text: string): string {
  return escapeRegExp(text);
}
