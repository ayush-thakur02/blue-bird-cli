import { highlight } from "./highlight.ts";
import { hyperlink, hrule, padEndVisible, truncateVisible, visibleWidth, wrapVisible } from "./ansi.ts";
import type { Theme } from "./theme.ts";

export interface MarkdownTheme {
  heading(text: string, level: number): string;
  bold(text: string): string;
  italic(text: string): string;
  code(text: string): string;
  link(text: string, url: string): string;
  bullet(text: string, level: number): string;
  ordered(text: string, level: number): string;
  quote(text: string): string;
  taskChecked(text: string): string;
  taskUnchecked(text: string): string;
  tableHeader(text: string): string;
  tableBorder(text: string): string;
}

export interface MarkdownOptions {
  width: number;
  theme: Theme;
  indent?: string;
  lineNumbers?: boolean;
}

export function defaultMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text, level) => theme.heading(text, level),
    bold: (text) => (theme.name === "none" ? text : `\u001b[1m${text}\u001b[0m`),
    italic: (text) => theme.thinking(text),
    code: (text) => theme.code(text),
    link: (text, url) => hyperlink(theme.link(text), url),
    bullet: (text, level) => `${"  ".repeat(level)}${theme.dim("•")} ${text}`,
    ordered: (text, level) => `${"  ".repeat(level)}${text}`,
    quote: (text) => theme.dim(text),
    taskChecked: (text) => `${theme.success("☑")} ${theme.dim(text)}`,
    taskUnchecked: (text) => `${theme.dim("☐")} ${text}`,
    tableHeader: (text) => theme.primary(text),
    tableBorder: (text) => theme.dim(text),
  };
}

export function renderInline(text: string, theme: Theme): string {
  const styles = defaultMarkdownTheme(theme);
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === "\\" && index + 1 < text.length && /[`*_[\]()#+\-.!~]/.test(text[index + 1]!)) {
      out += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      if (end !== -1) {
        out += styles.code(text.slice(index + 1, end));
        index = end + 1;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const double = text.slice(index, index + 2) === char.repeat(2);
      const marker = char.repeat(double ? 2 : 1);
      const canOpen =
        char === "*" ||
        index === 0 ||
        /[\s([{'"“‘]/.test(text[index - 1] ?? "");
      const end = canOpen ? findClosing(text, index + marker.length, marker, char === "_") : -1;
      if (end > index) {
        const inner = text.slice(index + marker.length, end);
        out += double ? styles.bold(renderInline(inner, theme)) : styles.italic(renderInline(inner, theme));
        index = end + marker.length;
        continue;
      }
    }

    if (char === "~" && text.slice(index, index + 2) === "~~") {
      const end = text.indexOf("~~", index + 2);
      if (end !== -1) {
        const inner = text.slice(index + 2, end);
        out += theme.name === "none" ? inner : `\u001b[9m${inner}\u001b[0m`;
        index = end + 2;
        continue;
      }
    }

    if (char === "[" ) {
      const match = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
      if (match) {
        out += styles.link(renderInline(match[1] ?? "", theme), match[2] ?? "");
        index += match[0].length;
        continue;
      }
    }

    if (char === "<" && /^<https?:\/\/[^>]+>/.test(text.slice(index))) {
      const match = /^<(https?:\/\/[^>]+)>/.exec(text.slice(index))!;
      out += styles.link(match[1]!, match[1]!);
      index += match[0].length;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function findClosing(text: string, from: number, marker: string, requireBoundary = false): number {
  let index = from;
  while (index < text.length) {
    const found = text.indexOf(marker, index);
    if (found === -1) return -1;
    if (found > 0 && text[found - 1] === "\\") {
      index = found + marker.length;
      continue;
    }
    if (requireBoundary) {
      const after = text[found + marker.length] ?? "";
      if (after && !/[\s.,;:!?)\]}'"”’]/.test(after)) {
        index = found + marker.length;
        continue;
      }
    }
    if (marker.length === 1 && /\s/.test(text[found - 1] ?? "")) {
      index = found + 1;
      continue;
    }
    return found;
  }
  return -1;
}

interface ListContext {
  level: number;
  ordered: boolean;
  index: number;
}

interface TableState {
  headers: string[];
  rows: string[][];
  align: ("left" | "right" | "center")[];
}

/**
 * Line-oriented markdown renderer shared by the one-shot renderer and the
 * streaming renderer, so output looks identical once a turn completes.
 */
class MarkdownParser {
  private readonly options: MarkdownOptions;
  private readonly theme: Theme;
  private readonly styles: MarkdownTheme;
  private paragraph: string[] = [];
  private fence?: { lang: string; lines: string[] };
  private table?: TableState;
  private listStack: ListContext[] = [];

  constructor(options: MarkdownOptions) {
    this.options = options;
    this.theme = options.theme;
    this.styles = defaultMarkdownTheme(options.theme);
  }

  pushLine(line: string): string[] {
    const produced: string[] = [];
    const width = Math.max(20, this.options.width - (this.options.indent ? visibleWidth(this.options.indent) : 0));

    if (this.fence) {
      if (/^\s*(```|~~~)\s*$/.test(line)) {
        this.fence = undefined;
        return produced;
      }
      produced.push(this.codeLine(line, this.fence.lang));
      return produced;
    }

    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fenceMatch) {
      produced.push(...this.flushParagraph(width));
      const lang = fenceMatch[2] ?? "";
      this.fence = { lang, lines: [] };
      if (lang) produced.push(`${this.options.indent ?? ""}${this.theme.dim(`┄ ${lang}`)}`);
      return produced;
    }

    const tableRow = parseTableRow(line);
    if (tableRow) {
      if (!this.table) {
        produced.push(...this.flushParagraph(width));
        this.table = { headers: tableRow, rows: [], align: [] };
        return produced;
      }
      if (isTableDivider(line)) {
        this.table.align = parseAlignments(line, tableRow.length);
        return produced;
      }
      this.table.rows.push(tableRow);
      return produced;
    }

    if (this.table) {
      produced.push(...this.renderTable(this.table, width));
      this.table = undefined;
    }

    if (!line.trim()) {
      produced.push(...this.flushParagraph(width));
      this.listStack = [];
      produced.push("");
      return produced;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      produced.push(...this.flushParagraph(width));
      const level = heading[1]!.length;
      const text = renderInline(heading[2]!.replace(/\s+#+\s*$/, ""), this.theme);
      const prefix = level === 1 ? "" : level === 2 ? "" : "  ".repeat(level - 3);
      const wrapped = wrapVisible(`${prefix}${text}`, width);
      produced.push(...wrapped.map((entry, index) => (index === 0 ? this.styles.heading(entry, level) : `   ${entry}`)));
      return produced;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      produced.push(...this.flushParagraph(width));
      produced.push(this.theme.dim(hrule(width)));
      return produced;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      produced.push(...this.flushParagraph(width));
      const depth = (line.match(/>/g) ?? []).length;
      const inner = wrapVisible(renderInline(quote[1] ?? "", this.theme), width - depth * 2 - 2);
      for (const entry of inner) {
        produced.push(`${this.theme.dim("│")} ${this.styles.quote(entry)}`);
      }
      return produced;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      produced.push(...this.flushParagraph(width));
      const indentWidth = (item[1] ?? "").replace(/\t/g, "  ").length;
      const level = Math.max(0, Math.floor(indentWidth / 2));
      const ordered = /\d/.test(item[2]!);
      const markerIndex = this.nextIndex(level, ordered, item[2]!);

      let content = item[3] ?? "";
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      let rendered: string;
      if (task) {
        const body = renderInline(task[2] ?? "", this.theme);
        rendered = task[1]!.toLowerCase() === "x" ? this.styles.taskChecked(body) : this.styles.taskUnchecked(body);
      } else {
        rendered = renderInline(content, this.theme);
      }

      const prefix = `${"  ".repeat(level)}${this.theme.dim(ordered ? `${markerIndex}.` : "•")} `;
      const wrapped = wrapVisible(rendered, width - visibleWidth(prefix));
      produced.push(`${prefix}${wrapped[0] ?? ""}`);
      for (const extra of wrapped.slice(1)) {
        produced.push(`${" ".repeat(visibleWidth(prefix))}${extra}`);
      }
      return produced;
    }

    this.listStack = [];
    this.paragraph.push(renderInline(line.trimEnd(), this.theme));
    return produced;
  }

  flush(): string[] {
    const width = Math.max(20, this.options.width);
    const produced: string[] = [];
    produced.push(...this.flushParagraph(width));
    if (this.fence) {
      produced.push(...this.renderCodeBlock(this.fence.lang, this.fence.lines));
      this.fence = undefined;
    }
    if (this.table) {
      produced.push(...this.renderTable(this.table, width));
      this.table = undefined;
    }
    return produced;
  }

  private nextIndex(level: number, ordered: boolean, raw: string): number {
    const existing = this.listStack[level];
    if (existing && existing.ordered === ordered) {
      existing.index += 1;
      return existing.index;
    }
    const start = ordered ? Number(raw.replace(/[.)]/, "")) || 1 : 1;
    this.listStack[level] = { level, ordered, index: start };
    this.listStack = this.listStack.slice(0, level + 1);
    return start;
  }

  private flushParagraph(width: number): string[] {
    if (this.paragraph.length === 0) return [];
    const text = this.paragraph.join(" ");
    this.paragraph = [];
    const indent = this.options.indent ?? "";
    return wrapVisible(text, width).map((line) => `${indent}${line}`);
  }

  private codeLine(line: string, lang: string): string {
    const indent = this.options.indent ?? "";
    const body = line.length > this.options.width ? truncateVisible(line, this.options.width - 4) : line;
    const painted = this.theme.name === "none" ? body : highlight(body, lang, { theme: this.theme });
    return `${indent}${this.theme.dim("│")} ${painted}`;
  }

  private renderCodeBlock(lang: string, lines: string[]): string[] {
    const indent = this.options.indent ?? "";
    const produced: string[] = [];
    if (lang) produced.push(`${indent}${this.theme.dim(`┄ ${lang}`)}`);
    for (const [index, line] of lines.entries()) {
      const body = line.length > this.options.width - 4 ? truncateVisible(line, this.options.width - 4) : line;
      const painted = this.theme.name === "none" ? body : highlight(body, lang, { theme: this.theme });
      const gutter = this.options.lineNumbers ? this.theme.dim(String(index + 1).padStart(3)) : this.theme.dim("│");
      produced.push(`${indent}${gutter} ${painted}`);
    }
    return produced;
  }

  private renderTable(table: TableState, width: number): string[] {
    const indent = this.options.indent ?? "";
    const columns = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
    const widths: number[] = [];
    for (let index = 0; index < columns; index += 1) {
      const cells = [table.headers[index] ?? "", ...table.rows.map((row) => row[index] ?? "")].map(plainLength);
      widths.push(Math.min(32, Math.max(...cells, 3)));
    }

    const total = widths.reduce((sum, value) => sum + value, 0) + (columns - 1) * 3;
    if (total + indent.length > width * 1.4) {
      const produced: string[] = [];
      table.rows.forEach((row, rowIndex) => {
        if (rowIndex > 0) produced.push(indent);
        table.headers.forEach((header, index) => {
          const value = row[index] ?? "";
          produced.push(`${indent}${this.theme.dim(`${header}:`)} ${renderInline(value, this.theme)}`);
        });
      });
      return produced;
    }

    const produced: string[] = [];
    const headerLine = table.headers
      .map((cell, index) => padEndVisible(truncateVisible(this.styles.tableHeader(renderInline(cell, this.theme)), widths[index]!), widths[index]!))
      .join(this.theme.dim(" │ "));
    produced.push(`${indent}${headerLine}`);
    produced.push(`${indent}${this.styles.tableBorder(widths.map((value) => "─".repeat(value)).join("─┼─"))}`);
    for (const row of table.rows) {
      const line = Array.from({ length: columns }, (_, index) => {
        const cell = renderInline(row[index] ?? "", this.theme);
        const align = table.align[index] ?? "left";
        const clipped = truncateVisible(cell, widths[index]!);
        if (align === "right") return " ".repeat(Math.max(0, widths[index]! - visibleWidth(clipped))) + clipped;
        if (align === "center") {
          const gap = Math.max(0, widths[index]! - visibleWidth(clipped));
          return `${" ".repeat(Math.floor(gap / 2))}${clipped}${" ".repeat(Math.ceil(gap / 2))}`;
        }
        return padEndVisible(clipped, widths[index]!);
      }).join(this.theme.dim(" │ "));
      produced.push(`${indent}${line}`);
    }
    return produced;
  }
}

function plainLength(text: string): number {
  return visibleWidth(text.replace(/\*\*|__|\*|_|`/g, ""));
}

function parseTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  if (cells.length < 2) return undefined;
  return cells.map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes("-");
}

function parseAlignments(line: string, columns: number): ("left" | "right" | "center")[] {
  const cells = parseTableRow(line) ?? [];
  return Array.from({ length: columns }, (_, index) => {
    const cell = cells[index] ?? "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

export function renderMarkdown(markdown: string, options: MarkdownOptions): string {
  const parser = new MarkdownParser(options);
  const collapser = new LineCollapser();
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    lines.push(...collapser.collapse(parser.pushLine(line)));
  }
  lines.push(...collapser.collapse(parser.flush()));
  return lines.join("\n");
}

/** Suppresses runs of blank lines so streaming output does not drift apart. */
class LineCollapser {
  private lastBlank = true;

  collapse(lines: readonly string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
      const blank = line.trim() === "";
      if (blank && this.lastBlank) continue;
      this.lastBlank = blank;
      out.push(line);
    }
    return out;
  }
}

export class MarkdownStreamRenderer {
  private readonly parser: MarkdownParser;
  private readonly collapser = new LineCollapser();
  private buffer = "";

  constructor(options: MarkdownOptions) {
    this.parser = new MarkdownParser(options);
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      lines.push(...this.collapser.collapse(this.parser.pushLine(line.replace(/\r$/, ""))));
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  flush(): string[] {
    const lines: string[] = [];
    if (this.buffer.trim()) {
      lines.push(...this.collapser.collapse(this.parser.pushLine(this.buffer.replace(/\r$/, ""))));
      this.buffer = "";
    }
    lines.push(...this.collapser.collapse(this.parser.flush()));
    return lines;
  }
}
