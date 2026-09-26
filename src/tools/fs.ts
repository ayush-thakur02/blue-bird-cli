import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../util/errors.ts";
import { realPathOfExistingPrefix, relativePath, writeFileAtomic } from "../util/paths.ts";
import { countLines, normalizeWhitespace } from "../util/text.ts";
import { fileMtimeMsSync, readTextFile } from "../util/walk.ts";
import { diffStats, unifiedDiff } from "../ui/diff.ts";
import { imageResult, looksLikeImage } from "./image.ts";
import { optionalBoolean, optionalNumber, optionalString, presentString, requiredString } from "./args.ts";
import { defineTool, type ToolContext } from "./types.ts";
import { ensureInsideWorkspace, resolveTarget } from "./workspace.ts";

const MAX_READ_LINES = 3000;
const MAX_LINE_LENGTH = 2000;
/** Above this, an edit cannot be matched safely; the model is told to use bash or split the file. */
const MAX_EDIT_BYTES = 8_000_000;
/** Above this, `write` skips the diff instead of reading the old file into memory. */
const MAX_DIFF_BYTES = 4_000_000;

/**
 * Writes through a temp file so a crash cannot leave a truncated source file,
 * copying the target's permission bits first (temp files start at 0666, which
 * would silently clear an executable bit) and resolving symlinks so an edit
 * lands on the link's target instead of replacing the link.
 */
function writeFilePreservingMode(absolute: string, content: string): void {
  const target = realPathOfExistingPrefix(absolute);
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    mode = undefined;
  }
  writeFileAtomic(target, content, mode === undefined ? {} : { mode });
}

/** Refuses to read a file too large to match edits against. */
function readForEdit(absolute: string, relative: string, verb: string): string {
  const stats = fs.statSync(absolute);
  if (stats.size > MAX_EDIT_BYTES) {
    throw new ToolError(`Refusing to ${verb} ${relative}: it is ${Math.round(stats.size / 1024 / 1024)} MB`, {
      hint: `Files over ${MAX_EDIT_BYTES / 1_000_000} MB cannot be matched reliably. Use bash (sed, awk) or split the file first.`,
    });
  }
  return fs.readFileSync(absolute, "utf8");
}

export function formatNumberedLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => {
      const number = String(startLine + index).padStart(width);
      const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated, ${line.length} chars]` : line;
      return `${number}→${text}`;
    })
    .join("\n");
}

export const readTool = defineTool({
  name: "read",
  label: "Read",
  description:
    "Read a file from disk. Returns the content with line numbers. Supports images (returns metadata), detects binary files, and can page through large files with offset/limit. Always read a file before editing it.",
  tags: ["fs", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or workspace-relative path to the file." },
      offset: { type: "number", description: "1-indexed line to start from." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["file_path"],
  },
  describe(args) {
    const file = optionalString(args, "file_path", "path") ?? "?";
    const offset = optionalNumber(args, "offset");
    const limit = optionalNumber(args, "limit");
    return offset || limit ? `${file}:${offset ?? 1}${limit ? `+${limit}` : ""}` : file;
  },
  async execute(args, ctx) {
    const requested = requiredString(args, ["file_path", "path", "file"], "read");
    const absolute = resolveTarget(ctx, requested);
    ensureInsideWorkspace(ctx, absolute, "read");

    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolute);
    } catch {
      throw new ToolError(`File not found: ${relativePath(ctx.cwd, absolute)}`, {
        hint: "Check the path with glob or list the directory contents.",
      });
    }
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(absolute, { withFileTypes: true }).slice(0, 200);
      const listing = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((a, b) => a.localeCompare(b))
        .join("\n");
      return {
        content: `${relativePath(ctx.cwd, absolute)} is a directory.\n\n${listing}`,
        summary: `${entries.length} entries`,
        display: { kind: "text", title: `${relativePath(ctx.cwd, absolute)}/`, text: listing },
        meta: { readFiles: [absolute] },
      };
    }

    // Images are handed to the model directly instead of being reported as binary.
    if (looksLikeImage(absolute)) {
      return imageResult(ctx, absolute, { label: path.basename(absolute) });
    }

    const maxBytes = 5_000_000;
    if (stats.size > maxBytes) {
      throw new ToolError(`File is too large to read (${Math.round(stats.size / 1024)} KB)`, {
        hint: "Use bash with head/tail, or read a slice with offset and limit.",
      });
    }

    const readResult = await readTextFile(absolute, { maxBytes });
    if (readResult.binary) {
      return {
        content: `${relativePath(ctx.cwd, absolute)} looks like a binary file (${stats.size} bytes). It cannot be shown as text.`,
        summary: `binary, ${stats.size} bytes`,
        meta: { readFiles: [absolute] },
      };
    }

    const allLines = readResult.text.split("\n");
    const totalLines = allLines.length;
    const offset = Math.max(1, Math.floor(optionalNumber(args, "offset") ?? 1));
    const requestedLimit = optionalNumber(args, "limit");
    const limit = Math.max(1, Math.min(requestedLimit ?? MAX_READ_LINES, MAX_READ_LINES));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const truncated = offset - 1 + slice.length < totalLines;

    ctx.state.markRead(absolute, {
      mtimeMs: fileMtimeMsSync(absolute),
      size: stats.size,
      lines: totalLines,
      offset,
      limit,
    });

    const header =
      offset > 1 || truncated
        ? `[${relativePath(ctx.cwd, absolute)} · lines ${offset}-${offset + slice.length - 1} of ${totalLines}]`
        : "";
    const footer = truncated ? `\n\n[${totalLines - (offset - 1 + slice.length)} more lines. Re-read with offset=${offset + slice.length}.]` : "";
    const body = formatNumberedLines(slice, offset);
    const content = [header, body, footer].filter(Boolean).join("\n");

    return {
      content,
      summary: truncated ? `lines ${offset}-${offset + slice.length - 1} of ${totalLines}` : `${totalLines} lines`,
      display: { kind: "text", title: relativePath(ctx.cwd, absolute), text: content, collapseAfter: 0 },
      meta: { readFiles: [absolute], bytes: stats.size, ...(truncated ? { truncated: true } : {}) },
    };
  },
});

export const writeTool = defineTool({
  name: "write",
  label: "Write",
  description:
    "Write a complete file, creating parent directories as needed. Overwrites the existing content. For partial changes prefer `edit`. Files that already exist must be read first.",
  tags: ["fs"],
  risk: "medium",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or workspace-relative path to write." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["file_path", "content"],
  },
  describe(args) {
    const file = optionalString(args, "file_path", "path") ?? "?";
    const content = optionalString(args, "content") ?? "";
    return `${file} · ${countLines(content)} lines`;
  },
  async prepare(args, ctx) {
    const requested = requiredString(args, ["file_path", "path", "file"], "write");
    const content = presentString(args, "content", "text", "data");
    if (content === undefined) throw new ToolError("write requires the \"content\" argument");
    const absolute = resolveTarget(ctx, requested);
    ensureInsideWorkspace(ctx, absolute, "write");

    if (fs.existsSync(absolute)) {
      const stats = fs.statSync(absolute);
      if (stats.isDirectory()) throw new ToolError(`${relativePath(ctx.cwd, absolute)} is a directory`);
      if (stats.size > 0 && !ctx.state.hasRead(absolute)) {
        throw new ToolError(`${relativePath(ctx.cwd, absolute)} already exists and has not been read in this session`, {
          hint: "Read the file first so you do not overwrite content you have not seen, or use `edit` for a targeted change.",
        });
      }
      const record = ctx.state.getRead(absolute);
      if (record && ctx.state.isStale(absolute, fileMtimeMsSync(absolute))) {
        throw new ToolError(`${relativePath(ctx.cwd, absolute)} changed on disk since you read it`, {
          hint: "Read it again and re-apply your change so nothing is lost.",
        });
      }
    }
    return { ...args, file_path: absolute, content };
  },
  async execute(args, ctx) {
    const absolute = args.file_path as string;
    const content = args.content as string;
    const existed = fs.existsSync(absolute);
    // Reading the old body is only needed for the diff, so a huge file is
    // overwritten without loading it into memory.
    const diffable = existed && fs.statSync(absolute).size <= MAX_DIFF_BYTES;
    const before = diffable ? fs.readFileSync(absolute, "utf8") : "";

    ctx.checkpoints.capture(currentTurnId(ctx), absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    writeFilePreservingMode(absolute, content);

    const relative = relativePath(ctx.cwd, absolute);
    const diff = diffable ? unifiedDiff(before, content, { oldLabel: `a/${relative}`, newLabel: `b/${relative}` }) : "";
    const stats = diffable ? diffStats(diff) : { added: countLines(content), removed: 0, hunks: 1 };
    ctx.state.recordWrite(absolute, { addedLines: stats.added, removedLines: stats.removed });
    ctx.state.markRead(absolute, { mtimeMs: fileMtimeMsSync(absolute), size: Buffer.byteLength(content), lines: countLines(content) });
    ctx.checkpoints.setDelta(currentTurnId(ctx), absolute, { added: stats.added, removed: stats.removed });

    const verb = existed ? "Updated" : "Created";
    return {
      content: `${verb} ${relative} (${countLines(content)} lines, +${stats.added} −${stats.removed}).`,
      summary: existed ? `+${stats.added} −${stats.removed}` : `${countLines(content)} lines`,
      ...displayForDiff(ctx, relative, diff, stats),
      meta: { changedFiles: [absolute], addedLines: stats.added, removedLines: stats.removed },
    };
  },
});

export const editTool = defineTool({
  name: "edit",
  label: "Edit",
  description:
    "Replace an exact string in a file. `old_string` must match the file byte for byte, including indentation, and must be unique unless replace_all is set. Read the file immediately before editing.",
  tags: ["fs"],
  risk: "medium",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File to edit." },
      old_string: { type: "string", description: "Exact text to replace, including indentation." },
      new_string: { type: "string", description: "Replacement text. Empty string deletes the match." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  describe(args) {
    const file = optionalString(args, "file_path", "path") ?? "?";
    const old = optionalString(args, "old_string", "old") ?? "";
    return `${file} · ${firstLine(old) || "…"}`;
  },
  async prepare(rawArgs, ctx) {
    const requested = requiredString(rawArgs, ["file_path", "path", "file"], "edit");
    const oldString = optionalString(rawArgs, "old_string", "old", "search");
    if (oldString === undefined) throw new ToolError("edit requires the \"old_string\" argument");
    if (oldString.length === 0) throw new ToolError("edit requires a non-empty \"old_string\"");
    const newString = optionalString(rawArgs, "new_string", "new", "replacement") ?? "";
    const absolute = resolveTarget(ctx, requested);
    ensureInsideWorkspace(ctx, absolute, "edit");
    if (!fs.existsSync(absolute)) {
      throw new ToolError(`File not found: ${relativePath(ctx.cwd, absolute)}`, { hint: "Use `write` to create a new file." });
    }
    const record = ctx.state.getRead(absolute);
    if (!record) {
      throw new ToolError(`${relativePath(ctx.cwd, absolute)} has not been read in this session`, {
        hint: "Read the file first, then edit it with the exact text you saw.",
      });
    }
    if (ctx.state.isStale(absolute, fileMtimeMsSync(absolute))) {
      throw new ToolError(`${relativePath(ctx.cwd, absolute)} changed on disk since it was read`, {
        hint: "Read it again so your edit applies to the current content.",
      });
    }
    return {
      ...rawArgs,
      file_path: absolute,
      old_string: oldString,
      new_string: newString,
      replace_all: optionalBoolean(rawArgs, "replace_all", "all") ?? false,
    };
  },
  async execute(args, ctx) {
    const absolute = args.file_path as string;
    const relative = relativePath(ctx.cwd, absolute);
    const before = readForEdit(absolute, relative, "edit");
    const result = applyEdit(before, args.old_string as string, args.new_string as string, Boolean(args.replace_all));
    if (!result.ok) {
      throw new ToolError(result.error, { hint: result.hint });
    }

    ctx.checkpoints.capture(currentTurnId(ctx), absolute);
    writeFilePreservingMode(absolute, result.text);
    const diff = unifiedDiff(before, result.text, { oldLabel: `a/${relative}`, newLabel: `b/${relative}` });
    const stats = diffStats(diff);
    ctx.state.recordWrite(absolute, { addedLines: stats.added, removedLines: stats.removed });
    ctx.state.markRead(absolute, { mtimeMs: fileMtimeMsSync(absolute), size: Buffer.byteLength(result.text), lines: countLines(result.text) });
    ctx.checkpoints.setDelta(currentTurnId(ctx), absolute, { added: stats.added, removed: stats.removed });

    return {
      content: `Edited ${relative} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}, +${stats.added} −${stats.removed}).${strategyNote(result.strategy)}`,
      summary: `+${stats.added} −${stats.removed}`,
      ...displayForDiff(ctx, relative, diff, stats),
      meta: { changedFiles: [absolute], addedLines: stats.added, removedLines: stats.removed },
    };
  },
});

export const multiEditTool = defineTool({
  name: "multi_edit",
  label: "MultiEdit",
  description:
    "Apply several sequential string replacements to one file in a single atomic write. Each edit sees the result of the previous one. All edits must apply or nothing is written.",
  tags: ["fs"],
  risk: "medium",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File to edit." },
      edits: {
        type: "array",
        description: "Ordered list of replacements.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  },
  describe(args) {
    const file = optionalString(args, "file_path", "path") ?? "?";
    const edits = Array.isArray(args.edits) ? args.edits.length : 0;
    return `${file} · ${edits} edits`;
  },
  async prepare(rawArgs, ctx) {
    const requested = requiredString(rawArgs, ["file_path", "path", "file"], "multi_edit");
    const editsRaw = rawArgs.edits;
    if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
      throw new ToolError("multi_edit requires a non-empty \"edits\" array");
    }
    const absolute = resolveTarget(ctx, requested);
    ensureInsideWorkspace(ctx, absolute, "edit");
    if (!fs.existsSync(absolute)) throw new ToolError(`File not found: ${relativePath(ctx.cwd, absolute)}`);
    if (!ctx.state.hasRead(absolute)) {
      throw new ToolError(`${relativePath(ctx.cwd, absolute)} has not been read in this session`, {
        hint: "Read the file before editing it.",
      });
    }
    const edits = editsRaw.map((entry, index) => {
      const record = entry as Record<string, unknown>;
      const oldString = optionalString(record, "old_string", "old");
      if (oldString === undefined || oldString.length === 0) {
        throw new ToolError(`edits[${index}].old_string is required`);
      }
      return {
        old_string: oldString,
        new_string: optionalString(record, "new_string", "new") ?? "",
        replace_all: optionalBoolean(record, "replace_all", "all") ?? false,
      };
    });
    return { ...rawArgs, file_path: absolute, edits };
  },
  async execute(args, ctx) {
    const absolute = args.file_path as string;
    const edits = args.edits as { old_string: string; new_string: string; replace_all: boolean }[];
    const relative = relativePath(ctx.cwd, absolute);
    const before = readForEdit(absolute, relative, "multi_edit");
    let text = before;
    let inexact = false;

    for (const [index, edit] of edits.entries()) {
      const result = applyEdit(text, edit.old_string, edit.new_string, edit.replace_all);
      if (!result.ok) throw new ToolError(`edits[${index}] failed: ${result.error}`, { hint: result.hint });
      if (result.strategy && result.strategy !== "exact") inexact = true;
      text = result.text;
    }

    ctx.checkpoints.capture(currentTurnId(ctx), absolute);
    writeFilePreservingMode(absolute, text);
    const diff = unifiedDiff(before, text, { oldLabel: `a/${relative}`, newLabel: `b/${relative}` });
    const stats = diffStats(diff);
    ctx.state.recordWrite(absolute, { addedLines: stats.added, removedLines: stats.removed });
    ctx.state.markRead(absolute, { mtimeMs: fileMtimeMsSync(absolute), size: Buffer.byteLength(text), lines: countLines(text) });
    ctx.checkpoints.setDelta(currentTurnId(ctx), absolute, { added: stats.added, removed: stats.removed });

    return {
      content: `Applied ${edits.length} edits to ${relative} (+${stats.added} −${stats.removed}).${inexact ? " At least one edit matched with an indentation-insensitive comparison — verify the result." : ""}`,
      summary: `${edits.length} edits · +${stats.added} −${stats.removed}`,
      ...displayForDiff(ctx, relative, diff, stats),
      meta: { changedFiles: [absolute], addedLines: stats.added, removedLines: stats.removed },
    };
  },
});

export interface EditResult {
  ok: true;
  text: string;
  replacements: number;
  strategy?: "exact" | "indentation" | "whitespace";
}

export interface EditFailure {
  ok: false;
  error: string;
  hint?: string;
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): EditResult | EditFailure {
  const occurrences = countOccurrences(content, oldString);
  if (occurrences > 0) {
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        error: `old_string appears ${occurrences} times in the file`,
        hint: "Include more surrounding lines so the match is unique, or set replace_all to true.",
      };
    }
    const text = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    return { ok: true, text, replacements: replaceAll ? occurrences : 1, strategy: "exact" };
  }

  const lineMatch = matchByLines(content, oldString);
  if (lineMatch) {
    const { start, end, strategy } = lineMatch;
    const lines = content.split("\n");
    const replacement = newString.split("\n");
    const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
    return { ok: true, text: next.join("\n"), replacements: 1, strategy };
  }

  const normalized = normalizeWhitespace(oldString);
  const bestGuess = closestSnippet(content, normalized);
  return {
    ok: false,
    error: "old_string was not found in the file",
    hint: bestGuess
      ? `Closest matching region starts at line ${bestGuess.line}:\n${bestGuess.snippet}\nRead the file again and copy the exact text.`
      : "Read the file again and copy the exact text, including indentation.",
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Strips the common leading indentation while preserving relative structure. */
function dedentLines(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => (min === 0 ? line : line.slice(Math.min(min, line.length))).replace(/\s+$/, ""));
}

/**
 * Falls back to line-based matching when a byte-exact match fails. The ladder
 * runs most-precise first so the reported strategy tells the model how much
 * trust to place in the result: dedenting tolerates a different overall indent
 * while keeping relative structure, and trimming all whitespace is the loosest
 * option, catching tab-versus-space differences.
 */
function matchByLines(
  content: string,
  oldString: string,
): { start: number; end: number; strategy: "indentation" | "whitespace" } | undefined {
  const contentLines = content.split("\n");
  const targetLines = oldString.split("\n");
  const length = targetLines.length;
  if (length === 0 || targetLines.every((line) => line.trim() === "")) return undefined;
  if (length > contentLines.length) return undefined;

  const strategies: { strategy: "indentation" | "whitespace"; normalise: (lines: string[]) => string[] }[] = [
    { strategy: "indentation", normalise: dedentLines },
    { strategy: "whitespace", normalise: (lines) => lines.map((line) => line.trim()) },
  ];

  for (const { strategy, normalise } of strategies) {
    const needle = normalise(targetLines);
    const firstLine = needle[0]!;
    let start = -1;
    let matches = 0;
    for (let index = 0; index + length <= contentLines.length; index += 1) {
      // Cheap rejection before normalising a whole window: the first line has
      // to agree under this strategy anyway.
      if (normalise([contentLines[index]!])[0] !== firstLine) continue;
      if (!sameLines(normalise(contentLines.slice(index, index + length)), needle)) continue;
      matches += 1;
      start = index;
      if (matches > 1) break;
    }
    // Only an unambiguous match is applied; two candidates mean the edit is
    // ambiguous and the model should be told to add more context.
    if (matches === 1) return { start, end: start + length, strategy };
  }
  return undefined;
}

function sameLines(left: string[], right: string[]): boolean {
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function strategyNote(strategy: EditResult["strategy"]): string {
  if (!strategy || strategy === "exact") return "";
  return ` Matched with the ${strategy}-insensitive fallback because the text was not byte-exact — verify the result.`;
}

function closestSnippet(content: string, normalizedTarget: string): { line: number; snippet: string } | undefined {
  const targetTokens = new Set(normalizedTarget.split(/\s+/).slice(0, 40));
  if (targetTokens.size === 0) return undefined;
  const lines = content.split("\n");
  let bestIndex = -1;
  let bestScore = 0;
  const windowSize = Math.max(3, Math.min(20, normalizedTarget.split("\n").length));
  for (let index = 0; index + windowSize <= lines.length; index += 1) {
    const window = lines.slice(index, index + windowSize).join("\n");
    const tokens = window.split(/\s+/).slice(0, 60);
    let overlap = 0;
    for (const token of tokens) if (targetTokens.has(token)) overlap += 1;
    const score = overlap / Math.max(1, targetTokens.size);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  if (bestIndex === -1 || bestScore < 0.4) return undefined;
  return {
    line: bestIndex + 1,
    snippet: lines
      .slice(bestIndex, bestIndex + Math.min(windowSize, 6))
      .map((line, offset) => `${bestIndex + offset + 1}→${line}`)
      .join("\n"),
  };
}

function displayForDiff(ctx: ToolContext, relative: string, diff: string, stats: { added: number; removed: number }) {
  if (!diff || ctx.config.raw.ui?.diff === "none") return {};
  return {
    display: {
      kind: "diff" as const,
      title: relative,
      diff,
      addedLines: stats.added,
      removedLines: stats.removed,
    },
  };
}

function currentTurnId(ctx: ToolContext): string {
  return ctx.turnId;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}
