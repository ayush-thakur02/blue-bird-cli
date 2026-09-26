import { cursor, padEndVisible, strip, truncateVisible, visibleWidth } from "./ansi.ts";
import type { Theme } from "./theme.ts";

export interface ScreenOptions {
  out: NodeJS.WriteStream;
  theme: Theme;
}

export interface InputBoxRender {
  /** Body rows, one per line of input. */
  lines: string[];
  /** Rows drawn under the box: the completion list and the status line. */
  footer?: string[];
  /** Where to leave the caret, as a row inside the block plus a 1-based column. */
  caret?: { row: number; column: number };
}

/**
 * Owns every byte written to stdout. Rendering is centralised here so the
 * streaming transcript, the activity line and the input box never fight over
 * the cursor.
 */
export class Screen {
  private readonly out: NodeJS.WriteStream;
  private readonly theme: Theme;
  private activityVisible = false;
  private activityText = "";
  private inputBlockLines = 0;
  private inputFrame = "";
  /** Row inside the input block the cursor was left on (0 = top border). */
  private inputCursorRow = 0;
  private streamColumn = 0;
  private streamedAny = false;
  private previousLine = "";

  constructor(options: ScreenOptions) {
    this.out = options.out;
    this.theme = options.theme;
  }

  get width(): number {
    const columns = this.out.columns || Number(process.env.COLUMNS) || 0;
    return columns >= 20 ? columns : 100;
  }

  get isTTY(): boolean {
    return Boolean(this.out.isTTY);
  }

  private write(text: string): void {
    this.out.write(text);
  }

  clearActivity(): void {
    if (!this.activityVisible) return;
    this.write(`\r${cursor.clearLine()}`);
    this.activityVisible = false;
    this.activityText = "";
  }

  setActivity(text: string | undefined): void {
    if (!this.isTTY) return;
    if (!text) {
      this.clearActivity();
      return;
    }
    const line = truncateVisible(text, this.width - 1);
    if (this.activityVisible && line === this.activityText) return;
    this.write(`\r${cursor.clearLine()}${line}`);
    this.activityVisible = true;
    this.activityText = line;
  }

  /** Prints a complete line of output. */
  line(text = ""): void {
    this.clearActivity();
    const safe = text.length > 20_000 ? `${text.slice(0, 20_000)}… [line truncated]` : text;
    this.write(`${safe}\n`);
    this.previousLine = strip(safe);
  }

  lines(lines: readonly string[]): void {
    for (const line of lines) this.line(line);
  }

  blank(): void {
    if (this.previousLine === "") return;
    this.line("");
  }

  /** Streams assistant text without line buffering (used for prose). */
  stream(text: string): void {
    if (!text) return;
    this.clearActivity();
    this.write(text);
    this.streamedAny = true;
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline !== -1) {
      this.streamColumn = visibleWidth(text.slice(lastNewline + 1));
      this.previousLine = "";
    } else {
      this.streamColumn += visibleWidth(text);
    }
  }

  /** Ends the current streamed run, terminating the line if needed. */
  endStream(): void {
    if (!this.streamedAny) return;
    if (this.streamColumn > 0) this.write("\n");
    this.streamedAny = false;
    this.streamColumn = 0;
    this.previousLine = "";
  }

  twoColumn(left: string, right: string, indent = 0): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const padding = " ".repeat(indent);
    const available = this.width - indent - leftWidth - rightWidth - 2;
    if (available < 1) return `${padding}${truncateVisible(left, Math.max(4, this.width - indent - rightWidth - 2))} ${right}`;
    return `${padding}${left}${" ".repeat(available + 1)}${this.theme.dim(right)}`;
  }

  /**
   * Draws the framed input box at the bottom of the screen and leaves the cursor
   * on `caret.row` inside that block (row 0 is the top border; the default is the
   * top). `clearInput` erases upwards by exactly that offset, so redrawing never
   * walks the box up the screen.
   */
  drawInputBox(render: InputBoxRender): void {
    if (!this.isTTY) return;
    this.clearInput();
    const inner = this.width - 2;
    const top = this.theme.border(`╭${"─".repeat(inner)}╮`);
    const bottom = this.theme.border(`╰${"─".repeat(inner)}╯`);
    const body = render.lines.map((line) => {
      const content = padEndVisible(truncateVisible(line, inner - 2), inner - 2);
      return `${this.theme.border("│")} ${content} ${this.theme.border("│")}`;
    });
    const footer = (render.footer ?? []).map((line) => truncateVisible(line, this.width));
    const rows = [top, ...body, bottom, ...footer];
    this.inputBlockLines = rows.length;
    this.inputCursorRow = render.caret ? Math.max(0, Math.min(render.caret.row, rows.length - 1)) : 0;
    this.inputFrame = rows.join("\n");
    this.write(this.inputFrame);
    this.write(cursor.up(rows.length - 1 - this.inputCursorRow));
    if (render.caret) this.write(cursor.toColumn(render.caret.column));
  }

  updateInputBox(render: InputBoxRender): void {
    this.drawInputBox(render);
  }

  clearInput(): void {
    if (!this.isTTY) return;
    const lines = this.inputBlockLines || countLinesInFrame(this.inputFrame);
    if (lines > 0) {
      this.write(`\r${cursor.up(this.inputCursorRow)}${cursor.clearDown()}`);
    }
    this.inputBlockLines = 0;
    this.inputCursorRow = 0;
    this.inputFrame = "";
  }

  /** Removes the live UI so an external process can own the terminal. */
  suspend(): void {
    this.clearActivity();
    this.clearInput();
    this.write(cursor.show());
  }

  resume(): void {
    this.write(cursor.hide());
  }

  error(text: string): void {
    this.line(this.theme.error(text));
  }

  warn(text: string): void {
    this.line(this.theme.warn(text));
  }

  info(text: string): void {
    this.line(this.theme.info(text));
  }

  dim(text: string): void {
    this.line(this.theme.dim(text));
  }
}

function countLinesInFrame(frame: string): number {
  if (!frame) return 0;
  return frame.split("\n").length;
}
