import type { Theme } from "./theme.ts";
import { truncateVisible } from "./ansi.ts";

export interface DiffOptions {
  context?: number;
  oldLabel?: string;
  newLabel?: string;
  maxLines?: number;
}

interface DiffOp {
  tag: "=" | "-" | "+";
  line: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  lines: string[];
}

const MYERS_MAX_TOTAL = 2500;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function myersDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let foundAt = -1;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundAt = d;
        break;
      }
    }
    if (foundAt >= 0) break;
  }
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundAt; d >= 0; d -= 1) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1]! < vv[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ tag: "=", line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ tag: "+", line: b[y - 1]! });
        y -= 1;
      } else {
        ops.push({ tag: "-", line: a[x - 1]! });
        x -= 1;
      }
    }
  }
  ops.reverse();
  return ops;
}

function patienceAnchors(a: string[], b: string[]): [number, number][] {
  const countA = new Map<string, number>();
  for (const line of a) countA.set(line, (countA.get(line) ?? 0) + 1);
  const countB = new Map<string, number>();
  const indexB = new Map<string, number>();
  for (let i = 0; i < b.length; i += 1) {
    const line = b[i]!;
    countB.set(line, (countB.get(line) ?? 0) + 1);
    indexB.set(line, i);
  }
  const candidates: [number, number][] = [];
  for (let i = 0; i < a.length; i += 1) {
    const line = a[i]!;
    if (countA.get(line) === 1 && countB.get(line) === 1) candidates.push([i, indexB.get(line)!]);
  }
  if (candidates.length === 0) return [];
  const tails: number[] = [];
  const prev = new Array<number>(candidates.length).fill(-1);
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]!]![1] < value) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const result: [number, number][] = [];
  let k = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (k !== -1) {
    result.push(candidates[k]!);
    k = prev[k]!;
  }
  result.reverse();
  return result;
}

function diffMiddle(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line): DiffOp => ({ tag: "+", line }));
  if (m === 0) return a.map((line): DiffOp => ({ tag: "-", line }));
  if (n + m <= MYERS_MAX_TOTAL) return myersDiff(a, b);
  const anchors = patienceAnchors(a, b);
  if (anchors.length === 0) {
    const removed = a.map((line): DiffOp => ({ tag: "-", line }));
    const added = b.map((line): DiffOp => ({ tag: "+", line }));
    return [...removed, ...added];
  }
  const ops: DiffOp[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ax, bx] of anchors) {
    ops.push(...diffMiddle(a.slice(ai, ax), b.slice(bi, bx)));
    ops.push({ tag: "=", line: a[ax]! });
    ai = ax + 1;
    bi = bx + 1;
  }
  ops.push(...diffMiddle(a.slice(ai), b.slice(bi)));
  return ops;
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start += 1;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middle = diffMiddle(a.slice(start, endA), b.slice(start, endB));
  const result: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) result.push({ tag: "=", line: a[i]! });
  result.push(...middle);
  for (let i = endA; i < n; i += 1) result.push({ tag: "=", line: a[i]! });
  return result;
}

function rangeText(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function buildHunks(ops: DiffOp[], context: number): string[] {
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i += 1) if (ops[i]!.tag !== "=") changeIdx.push(i);
  if (changeIdx.length === 0) return [];
  const groups: [number, number][] = [];
  let groupStart = changeIdx[0]!;
  let groupEnd = changeIdx[0]!;
  for (let i = 1; i < changeIdx.length; i += 1) {
    const idx = changeIdx[i]!;
    if (idx - groupEnd <= context * 2 + 1) {
      groupEnd = idx;
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = idx;
      groupEnd = idx;
    }
  }
  groups.push([groupStart, groupEnd]);

  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i += 1) {
    oldBefore[i + 1] = oldBefore[i]! + (ops[i]!.tag === "+" ? 0 : 1);
    newBefore[i + 1] = newBefore[i]! + (ops[i]!.tag === "-" ? 0 : 1);
  }

  const out: string[] = [];
  for (const [gs, ge] of groups) {
    const start = Math.max(0, gs - context);
    const end = Math.min(ops.length - 1, ge + context);
    const oldCount = oldBefore[end + 1]! - oldBefore[start]!;
    const newCount = newBefore[end + 1]! - newBefore[start]!;
    let oldStart = oldBefore[start]!;
    if (oldCount > 0) {
      for (let i = start; i <= end; i += 1) {
        if (ops[i]!.tag !== "+") {
          oldStart = oldBefore[i]! + 1;
          break;
        }
      }
    }
    let newStart = newBefore[start]!;
    if (newCount > 0) {
      for (let i = start; i <= end; i += 1) {
        if (ops[i]!.tag !== "-") {
          newStart = newBefore[i]! + 1;
          break;
        }
      }
    }
    out.push(`@@ -${rangeText(oldStart, oldCount)} +${rangeText(newStart, newCount)} @@`);
    for (let i = start; i <= end; i += 1) {
      const op = ops[i]!;
      out.push((op.tag === "=" ? " " : op.tag) + op.line);
    }
  }
  return out;
}

/**
 * Unified diff body between two texts, with an optional `---`/`+++` header when labels are given.
 */
export function unifiedDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  const context = Math.max(0, options.context ?? 3);
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let body = buildHunks(ops, context);
  if (body.length === 0) return "";
  const maxLines = options.maxLines ?? 0;
  if (maxLines > 0 && body.length > maxLines) body = body.slice(0, maxLines);
  const header: string[] = [];
  if (options.oldLabel) header.push(`--- ${options.oldLabel}`);
  if (options.newLabel) header.push(`+++ ${options.newLabel}`);
  return [...header, ...body].join("\n");
}

/**
 * Full unified patch with `--- a/path` / `+++ b/path` headers.
 */
export function makePatch(oldText: string, newText: string, filePath: string, options: DiffOptions = {}): string {
  const context = Math.max(0, options.context ?? 3);
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const hunks = buildHunks(ops, context);
  if (hunks.length === 0) return "";
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const oldPath = normalized.startsWith("/") ? normalized : `a/${normalized}`;
  const newPath = normalized.startsWith("/") ? normalized : `b/${normalized}`;
  return [`--- ${oldPath}`, `+++ ${newPath}`, ...hunks].join("\n");
}

/**
 * Count added, removed and hunk lines in a unified diff.
 */
export function diffStats(diff: string): { added: number; removed: number; hunks: number } {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) hunks += 1;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed, hunks };
}

/**
 * Added and removed line counts between two texts.
 */
export function countChangedLines(oldText: string, newText: string): { added: number; removed: number } {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.tag === "+") added += 1;
    else if (op.tag === "-") removed += 1;
  }
  return { added, removed };
}

function colorizeDiffLine(line: string, theme: Theme): string {
  if (line.startsWith("@@")) return theme.diffHunk(line);
  if (line.startsWith("+++") || line.startsWith("---")) return theme.diffMeta(line);
  if (line.startsWith("+")) return theme.diffAdd(line);
  if (line.startsWith("-")) return theme.diffDel(line);
  return theme.muted(line);
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return undefined;
  return { oldStart: Number(match[1]), newStart: Number(match[3]) };
}

function gutterColumnCount(lines: string[]): number {
  let max = 0;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    max = Math.max(max, oldStart + oldCount - 1, newStart + newCount - 1);
  }
  return String(Math.max(max, 1)).length;
}

/**
 * Colorized, width-clipped rendering of a unified diff.
 */
export function renderDiff(
  diff: string,
  options: { theme: Theme; width: number; maxLines?: number; lineNumbers?: boolean },
): string {
  const { theme, width } = options;
  if (!diff) return "";
  let lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let overflow = 0;
  const maxLines = options.maxLines ?? 0;
  if (maxLines > 0 && lines.length > maxLines) {
    overflow = lines.length - maxLines;
    lines = lines.slice(0, maxLines);
  }

  const columns = options.lineNumbers ? gutterColumnCount(lines) : 0;
  const gutterLength = columns > 0 ? columns * 2 + 2 : 0;
  const useGutter = gutterLength > 0 && width - gutterLength >= 8;
  let oldNo = 0;
  let newNo = 0;

  const out: string[] = [];
  for (const line of lines) {
    let prefix = "";
    if (useGutter) {
      if (line.startsWith("@@")) {
        const header = parseHunkHeader(line);
        if (header) {
          oldNo = header.oldStart;
          newNo = header.newStart;
        }
        prefix = " ".repeat(gutterLength);
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        prefix = " ".repeat(gutterLength);
      } else if (line.startsWith("+")) {
        prefix = `${"".padStart(columns)} ${String(newNo).padStart(columns)} `;
        newNo += 1;
      } else if (line.startsWith("-")) {
        prefix = `${String(oldNo).padStart(columns)} ${"".padStart(columns)} `;
        oldNo += 1;
      } else {
        prefix = `${String(oldNo).padStart(columns)} ${String(newNo).padStart(columns)} `;
        oldNo += 1;
        newNo += 1;
      }
    }
    out.push(truncateVisible(prefix + colorizeDiffLine(line, theme), width));
  }
  if (overflow > 0) out.push(truncateVisible(theme.dim(`... ${overflow} more lines`), width));
  return out.join("\n");
}

/**
 * Compact colored change summary such as "+12 −3", or "" when there are no changes.
 */
export function renderChangeSummary(diff: string, theme: Theme): string {
  const { added, removed } = diffStats(diff);
  const parts: string[] = [];
  if (added > 0) parts.push(theme.success(`+${added}`));
  if (removed > 0) parts.push(theme.error(`\u2212${removed}`));
  return parts.join(" ");
}

/**
 * Apply a unified diff to text, reporting how many hunks applied or failed.
 */
export function applyUnifiedDiff(original: string, patch: string): { text: string; applied: number; failed: number } {
  const hadTrailingNewline = original.endsWith("\n");
  const oldLines = splitLines(original);
  const patchLines = patch.split("\n");
  const hunks: Hunk[] = [];

  for (let i = 0; i < patchLines.length; i += 1) {
    const line = patchLines[i]!;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const body: string[] = [];
    let j = i + 1;
    for (; j < patchLines.length; j += 1) {
      const bodyLine = patchLines[j]!;
      if (bodyLine.startsWith("@@")) break;
      if (bodyLine === "" || bodyLine.startsWith("\\")) continue;
      body.push(bodyLine);
    }
    hunks.push({ oldStart, oldCount, lines: body });
    i = j - 1;
  }

  const out: string[] = [];
  let cursor = 0;
  let applied = 0;
  let failed = 0;
  for (const hunk of hunks) {
    const target = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (target < cursor) {
      failed += 1;
      continue;
    }
    while (cursor < target && cursor < oldLines.length) {
      out.push(oldLines[cursor]!);
      cursor += 1;
    }
    const staged: string[] = [];
    let pos = target;
    let ok = true;
    for (const bodyLine of hunk.lines) {
      const content = bodyLine.slice(1);
      if (bodyLine.startsWith("+")) {
        staged.push(content);
      } else if (bodyLine.startsWith("-")) {
        if (oldLines[pos] !== content) {
          ok = false;
          break;
        }
        pos += 1;
      } else {
        if (oldLines[pos] !== content) {
          ok = false;
          break;
        }
        staged.push(content);
        pos += 1;
      }
    }
    if (ok) {
      out.push(...staged);
      cursor = pos;
      applied += 1;
    } else {
      failed += 1;
      const copyEnd = Math.min(target + hunk.oldCount, oldLines.length);
      while (cursor < copyEnd) {
        out.push(oldLines[cursor]!);
        cursor += 1;
      }
    }
  }
  while (cursor < oldLines.length) {
    out.push(oldLines[cursor]!);
    cursor += 1;
  }
  let text = out.join("\n");
  if (hadTrailingNewline && text.length > 0) text += "\n";
  return { text, applied, failed };
}

/**
 * Line-based similarity in 0..1, useful for locating fuzzy edit anchors.
 */
export function similarity(a: string, b: string): number {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  if (aLines.length === 0 && bLines.length === 0) return 1;
  if (aLines.length === 0 || bLines.length === 0) return 0;
  const ops = diffLines(aLines, bLines);
  let equal = 0;
  for (const op of ops) if (op.tag === "=") equal += 1;
  return (2 * equal) / (aLines.length + bLines.length);
}
