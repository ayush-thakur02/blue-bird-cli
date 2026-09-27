import type { ConfirmPrompt } from "../core/contracts.ts";
import { offsetAtColumn, truncateVisible, visibleWidth, wrapColumns } from "./ansi.ts";
import type { Theme } from "./theme.ts";
import type { Screen } from "./screen.ts";
import { registerTerminalRestore } from "./terminal.ts";

export interface Completion {
  items: string[];
  start: number;
  prefix: string;
}

export interface InputOptions {
  stdin: NodeJS.ReadStream;
  screen: Screen;
  theme: Theme;
  isBusy: () => boolean;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onQueue?: (text: string, count: number) => void;
  statusLine?: () => string | undefined;
  complete?: (line: string, cursorIndex: number) => Completion | undefined;
  history?: string[];
  onHistory?: (entry: string) => void;
  placeholder?: string;
  maxVisibleLines?: number;
  busyEnter?: "queue" | "ignore";
}

interface KeyEvent {
  name: string;
  text?: string;
  meta?: boolean;
  ctrl?: boolean;
}

const ESC = "\u001b";
const DEFAULT_VISIBLE_ROWS = 8;

export class InputController {
  private readonly options: InputOptions;
  private buffer = "";
  private caret = 0;
  private historyIndex = -1;
  private draft = "";
  private disposed = false;
  private pasteBuffer: string | undefined;
  private completion?: { items: string[]; index: number; start: number; prefix: string; original: string };
  private readonly history: string[];
  private queued = 0;
  private lastInterrupt = 0;
  private prompt: PromptState | undefined;

  constructor(options: InputOptions) {
    this.options = options;
    this.history = options.history ?? [];
  }

  get value(): string {
    return this.buffer;
  }

  get isActive(): boolean {
    return !this.disposed && Boolean(this.options.stdin.isTTY);
  }

  start(): void {
    if (!this.isActive) return;
    const stdin = this.options.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", this.onData);
    stdin.on("end", this.onEnd);
    stdin.on("close", this.onEnd);
    process.on("SIGWINCH", this.onResize);
    this.write("\u001b[?2004h");
    // Raw mode must not outlive the process, whatever ends it.
    this.unregisterRestore = registerTerminalRestore(() => this.stop());
    this.render();
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterRestore?.();
    this.unregisterRestore = undefined;
    const stdin = this.options.stdin;
    stdin.off("data", this.onData);
    stdin.off("end", this.onEnd);
    stdin.off("close", this.onEnd);
    process.off("SIGWINCH", this.onResize);
    this.write("\u001b[?2004l");
    try {
      stdin.setRawMode?.(false);
    } catch {
      // terminal already restored
    }
    // A resumed TTY keeps the event loop alive, which left an exited session
    // sitting at a dead prompt that no longer answered Ctrl+C.
    stdin.pause();
    this.options.screen.clearInput();
  }

  private onEnd = (): void => {
    if (this.disposed) return;
    this.options.onExit();
  };

  private unregisterRestore?: () => void;

  setValue(text: string, position?: number): void {
    this.buffer = text;
    this.caret = position ?? text.length;
    this.render();
  }

  clear(): void {
    this.buffer = "";
    this.caret = 0;
    this.historyIndex = -1;
    this.render();
  }

  setPlaceholder(text: string | undefined): void {
    this.options.placeholder = text;
    this.render();
  }

  showQueued(count: number): void {
    this.queued = count;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  /**
   * Prints a line above the input box: the box is erased first and redrawn
   * underneath, so an out-of-band notice cannot overwrite what is being typed.
   */
  printAbove(text: string): void {
    if (!this.isActive) {
      this.write(`${text}\n`);
      return;
    }
    this.options.screen.clearInput();
    for (const line of text.split("\n")) this.write(`${line}\n`);
    this.render();
  }

  pushHistory(entry: string): void {
    if (!entry.trim()) return;
    if (this.history[this.history.length - 1] !== entry) this.history.push(entry);
    if (this.history.length > 500) this.history.shift();
    this.historyIndex = -1;
    this.options.onHistory?.(entry);
  }

  historyEntries(): string[] {
    return this.history;
  }

  private write(text: string): void {
    process.stdout.write(text);
  }

  private onResize = (): void => {
    this.render();
  };

  private onData = (chunk: string): void => {
    if (this.prompt) {
      this.handlePromptInput(chunk);
      return;
    }
    const keys = this.parse(chunk);
    for (const key of keys) {
      this.handleKey(key);
      if (this.disposed) return;
    }
  };

  // ---------------------------------------------------------------- rendering

  private render(): void {
    if (!this.isActive) return;
    const screen = this.options.screen;
    screen.clearInput();

    if (this.prompt) {
      this.drawPrompt();
      return;
    }

    if (this.options.isBusy()) return;

    const theme = this.options.theme;
    const maxRows = this.options.maxVisibleLines ?? DEFAULT_VISIBLE_ROWS;
    const inline = this.completion
      ? `  ${theme.dim(this.completion.items.map((item, index) => (index === this.completion!.index ? theme.accent(item) : item)).join("  "))}`
      : undefined;

    const logical = this.buffer.split("\n");
    const rows = wrappedRows(logical, this.textWidth());
    const { caretLine, caretColumnInLine } = layoutLines(logical, this.caret);
    const caretRow = caretRowFor(rows, caretLine, caretColumnInLine);
    const caretColumnInRow = caretColumnInLine - rows[caretRow]!.start;

    // The window follows the caret, so typing at the bottom scrolls the box
    // instead of growing it past `maxRows`.
    const firstVisible = Math.max(0, caretRow - maxRows + 1);
    const window = rows.slice(firstVisible, firstVisible + maxRows);
    const prompt = `${theme.dim(theme.glyphs.prompt)} `;
    const indent = " ".repeat(this.glyphCells() + 1);
    const body = window.map((row, index) => `${firstVisible + index === 0 ? prompt : indent}${row.text}`);

    const status = this.statusText();
    const footer = [inline, status].filter((line): line is string => Boolean(line));
    screen.drawInputBox({
      lines: body,
      ...(footer.length ? { footer } : {}),
      // Row 0 is the top border, so the caret row sits one row further down.
      caret: { row: 1 + (caretRow - firstVisible), column: this.glyphCells() + 4 + caretColumnInRow },
    });
  }

  /** Display cells the prompt glyph takes on a body row, without its trailing space. */
  private glyphCells(): number {
    return Math.max(1, visibleWidth(this.options.theme.glyphs.prompt));
  }

  /** Display columns the text itself has inside the box frame and the marker. */
  private textWidth(): number {
    return Math.max(8, this.options.screen.width - 4 - (this.glyphCells() + 1));
  }

  private statusText(): string | undefined {
    const status = this.options.statusLine?.();
    if (!status) return undefined;
    const queued = this.queued > 0 ? ` · ${this.queued} queued` : "";
    return `  ${this.options.theme.dim(status + queued)}`;
  }

  private handleKey(key: KeyEvent): void {
    const busy = this.options.isBusy();

    switch (key.name) {
      case "return": {
        if (key.meta || this.buffer.endsWith("\\")) {
          const trimmed = this.buffer.endsWith("\\") ? this.buffer.slice(0, -1) : this.buffer;
          this.buffer = `${trimmed}\n`;
          this.caret = this.buffer.length;
          this.render();
          return;
        }
        this.submit();
        return;
      }
      case "newline":
        this.buffer = `${this.buffer}\n`;
        this.caret = this.buffer.length;
        this.render();
        return;
      case "backspace":
        if (this.caret > 0) {
          const start = previousGraphemeStart(this.buffer, this.caret);
          this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.caret);
          this.caret = start;
          this.render();
        }
        return;
      case "delete":
        if (this.caret < this.buffer.length) {
          const end = nextGraphemeEnd(this.buffer, this.caret);
          this.buffer = this.buffer.slice(0, this.caret) + this.buffer.slice(end);
          this.render();
        }
        return;
      case "left":
      case "ctrl-b":
        if (this.caret > 0) {
          this.caret = previousGraphemeStart(this.buffer, this.caret);
          this.render();
        }
        return;
      case "right":
      case "ctrl-f":
        if (this.caret < this.buffer.length) {
          this.caret = nextGraphemeEnd(this.buffer, this.caret);
          this.render();
        }
        return;
      case "word-left": {
        const target = this.buffer.slice(0, this.caret).replace(/\s*\S*$/, "").length;
        this.caret = target;
        this.render();
        return;
      }
      case "word-right": {
        const rest = this.buffer.slice(this.caret);
        this.caret += /^\s*\S*/.exec(rest)?.[0].length ?? 0;
        this.render();
        return;
      }
      case "home":
      case "ctrl-a":
        this.caret = lineStart(this.buffer, this.caret);
        this.render();
        return;
      case "end":
      case "ctrl-e":
        this.caret = lineEnd(this.buffer, this.caret);
        this.render();
        return;
      case "up":
        this.moveVertical(-1);
        return;
      case "down":
        this.moveVertical(1);
        return;
      case "ctrl-p":
        this.historyMove(-1);
        return;
      case "ctrl-n":
        this.historyMove(1);
        return;
      case "ctrl-u": {
        const start = lineStart(this.buffer, this.caret);
        this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.caret);
        this.caret = start;
        this.render();
        return;
      }
      case "ctrl-k":
        this.buffer = this.buffer.slice(0, this.caret);
        this.render();
        return;
      case "ctrl-w":
      case "alt-backspace": {
        const before = this.buffer.slice(0, this.caret);
        const trimmed = before.replace(/[\w./-]*[\s]*$/, "").replace(/\s+$/, "");
        this.buffer = trimmed + this.buffer.slice(this.caret);
        this.caret = trimmed.length;
        this.render();
        return;
      }
      case "ctrl-l":
        this.write("\u001b[2J\u001b[H");
        this.options.screen.clearInput();
        this.render();
        return;
      case "ctrl-c": {
        if (busy) {
          const now = Date.now();
          if (now - this.lastInterrupt < 1500) {
            this.options.onExit();
            return;
          }
          this.lastInterrupt = now;
          this.buffer = "";
          this.caret = 0;
          this.options.onInterrupt();
          return;
        }
        if (this.buffer.trim()) {
          this.clear();
          return;
        }
        this.options.onExit();
        return;
      }
      case "ctrl-d":
        if (!this.buffer) {
          this.options.onExit();
          return;
        }
        if (this.caret < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.caret) + this.buffer.slice(nextGraphemeEnd(this.buffer, this.caret));
          this.render();
        }
        return;
      case "tab":
        this.handleTab();
        return;
      case "paste":
        this.handlePaste(key.text ?? "");
        return;
      case "escape":
        if (this.completion) {
          this.completion = undefined;
          this.render();
          return;
        }
        this.options.onInterrupt();
        return;
      case "pageup":
        this.historyMove(-5);
        return;
      case "pagedown":
        this.historyMove(5);
        return;
      default:
        break;
    }

    if (key.text) {
      if (this.completion && key.name !== "tab") {
        this.completion = undefined;
      }
      this.buffer = this.buffer.slice(0, this.caret) + key.text + this.buffer.slice(this.caret);
      this.caret += key.text.length;
      this.render();
    }
  }

  private submit(): void {
    const text = this.buffer;
    if (!text.trim()) {
      this.buffer = "";
      this.caret = 0;
      this.render();
      return;
    }
    if (this.options.isBusy()) {
      if (this.options.busyEnter === "ignore") {
        this.buffer = "";
        this.render();
        return;
      }
      this.queued += 1;
      this.options.onQueue?.(text, this.queued);
      this.pushHistory(text);
      this.buffer = "";
      this.caret = 0;
      this.render();
      return;
    }
    this.pushHistory(text);
    this.buffer = "";
    this.caret = 0;
    this.queued = 0;
    this.options.screen.clearInput();
    this.options.onSubmit(text);
  }

  private moveVertical(delta: number): void {
    const logical = this.buffer.split("\n");
    const rows = wrappedRows(logical, this.textWidth());
    if (rows.length === 1) {
      this.historyMove(delta);
      return;
    }
    const { caretLine, caretColumnInLine } = layoutLines(logical, this.caret);
    const current = caretRowFor(rows, caretLine, caretColumnInLine);
    const target = current + delta;
    if (target < 0 || target >= rows.length) return;
    const row = rows[target]!;
    // Land in the same column of the target row, clamped to the row's text.
    const column = Math.min(row.start + (caretColumnInLine - rows[current]!.start), visibleWidth(logical[row.line]!));
    this.caret = lineStartOf(this.buffer, row.line) + offsetAtColumn(logical[row.line]!, column);
    this.render();
  }

  private historyMove(delta: number): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1 && delta < 0) {
      this.draft = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex !== -1) {
      this.historyIndex += delta;
    } else {
      return;
    }

    const clamped = Math.max(-1, Math.min(this.history.length, this.historyIndex));
    this.historyIndex = clamped;
    this.buffer = clamped === -1 ? this.draft : (this.history[clamped] ?? "");
    this.caret = this.buffer.length;
    this.render();
  }

  private handleTab(): void {
    const complete = this.options.complete;
    if (!complete) return;

    if (this.completion) {
      this.completion.index = (this.completion.index + 1) % this.completion.items.length;
      const item = this.completion.items[this.completion.index]!;
      this.buffer = this.completion.original.slice(0, this.completion.start) + item + this.completion.original.slice(this.completion.start + this.completion.prefix.length);
      this.caret = this.completion.start + item.length;
      this.render();
      return;
    }

    const result = complete(this.buffer, this.caret);
    if (!result || result.items.length === 0) return;
    if (result.items.length === 1) {
      const item = result.items[0]!;
      this.buffer = this.buffer.slice(0, result.start) + item + this.buffer.slice(this.caret);
      this.caret = result.start + item.length;
      this.render();
      return;
    }
    const shared = commonPrefix(result.items);
    this.completion = {
      items: result.items.slice(0, 8),
      index: 0,
      start: result.start,
      prefix: result.prefix,
      original: this.buffer,
    };
    if (shared.length > result.prefix.length) {
      this.buffer = this.buffer.slice(0, result.start) + shared + this.buffer.slice(this.caret);
      this.caret = result.start + shared.length;
    }
    this.render();
  }

  // ------------------------------------------------------------------ prompts

  async confirm(prompt: ConfirmPrompt): Promise<string> {
    if (!this.isActive) return fallbackConfirm(prompt);
    return new Promise<string>((resolve) => {
      this.prompt = {
        prompt,
        selected: Math.max(0, prompt.options.findIndex((option) => option.value === (prompt.defaultOption ?? prompt.options[0]?.value))),
        resolve,
      };
      this.options.screen.clearInput();
      this.drawPrompt();
    });
  }

  private drawPrompt(): void {
    const state = this.prompt;
    if (!state) return;
    const theme = this.options.theme;
    const { prompt, selected } = state;
    const screen = this.options.screen;
    const lines: string[] = [`${theme.tone(prompt.tone ?? "info", prompt.title)}`];
    if (prompt.detail) lines.push(`  ${prompt.detail}`);
    if (prompt.body) {
      for (const line of prompt.body.split("\n").slice(0, 6)) lines.push(theme.dim(`  ${line}`));
    }
    const optionLine = prompt.options
      .map((option, index) => {
        const label = option.key ? `${option.key}) ${option.label}` : option.label;
        return index === selected ? theme.accent(`▸ ${label}`) : theme.dim(`  ${label}`);
      })
      .join("   ");
    // The options belong to the block: drawn as a footer row, `clearInput`
    // erases them with the box instead of leaving a stale line behind.
    screen.drawInputBox({ lines, footer: [truncateVisible(optionLine, screen.width)] });
  }

  private handlePromptInput(chunk: string): void {
    const state = this.prompt;
    if (!state) return;
    const keys = this.parse(chunk);
    for (const key of keys) {
      const options = state.prompt.options;
      if (key.name === "left" || key.name === "up") {
        state.selected = (state.selected - 1 + options.length) % options.length;
      } else if (key.name === "right" || key.name === "down" || key.name === "tab") {
        state.selected = (state.selected + 1) % options.length;
      } else if (key.name === "return") {
        this.finishPrompt(options[state.selected]!.value);
        return;
      } else if (key.name === "escape") {
        const fallback = options.find((option) => option.value === "deny") ?? options[options.length - 1]!;
        this.finishPrompt(fallback.value);
        return;
      } else if (key.name === "ctrl-c") {
        const fallback = options.find((option) => option.value === "deny") ?? options[options.length - 1]!;
        this.finishPrompt(fallback.value);
        return;
      } else if (key.text) {
        const match = options.find((option) => option.key?.toLowerCase() === key.text!.toLowerCase());
        if (match) {
          this.finishPrompt(match.value);
          return;
        }
        const byLabel = options.find((option) => option.label.toLowerCase().startsWith(key.text!.toLowerCase()));
        if (byLabel) {
          this.finishPrompt(byLabel.value);
          return;
        }
      }
    }
    this.drawPrompt();
  }

  private finishPrompt(value: string): void {
    const state = this.prompt;
    this.prompt = undefined;
    if (state) state.resolve(value);
    this.options.screen.clearInput();
    this.render();
  }

  // ------------------------------------------------------------------ parsing

  private parse(chunk: string): KeyEvent[] {
    if (this.pasteBuffer !== undefined) {
      const end = chunk.indexOf("\u001b[201~");
      if (end === -1) {
        this.pasteBuffer += chunk;
        return [];
      }
      this.pasteBuffer += chunk.slice(0, end);
      const text = this.pasteBuffer;
      this.pasteBuffer = undefined;
      const rest = this.parse(chunk.slice(end + 6));
      return [{ name: "paste", text }, ...rest];
    }

    if (chunk.includes("\u001b[200~")) {
      const start = chunk.indexOf("\u001b[200~");
      const before = this.parse(chunk.slice(0, start));
      const remainder = chunk.slice(start + 6);
      const end = remainder.indexOf("\u001b[201~");
      if (end === -1) {
        this.pasteBuffer = remainder;
        return before;
      }
      const text = remainder.slice(0, end);
      return [...before, { name: "paste", text }, ...this.parse(remainder.slice(end + 6))];
    }

    const events: KeyEvent[] = [];
    let index = 0;
    while (index < chunk.length) {
      const char = chunk[index]!;
      if (char === ESC) {
        const rest = chunk.slice(index);
        const csi = /^\u001b\[([0-9;]*)([A-Za-z~])/.exec(rest);
        if (csi) {
          events.push({ name: csiName(csi[2]!, csi[1]!) });
          index += csi[0].length;
          continue;
        }
        const ss3 = /^\u001bO([A-Za-z])/.exec(rest);
        if (ss3) {
          events.push({ name: csiName(ss3[1]!, "") });
          index += ss3[0].length;
          continue;
        }
        if (rest.length >= 2) {
          const next = rest[1]!;
          if (next === "\r" || next === "\n") {
            events.push({ name: "return", meta: true });
          } else if (next === "\u007f") {
            events.push({ name: "alt-backspace" });
          } else if (next === "b") {
            events.push({ name: "word-left" });
          } else if (next === "f") {
            events.push({ name: "word-right" });
          } else {
            events.push({ name: "meta", text: next, meta: true });
          }
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        events.push({ name: "return" });
        index += 1;
        continue;
      }
      if (char === "\t") {
        events.push({ name: "tab" });
        index += 1;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 32) {
        events.push({ name: ctrlName(code) });
        index += 1;
        continue;
      }
      if (code === 127) {
        events.push({ name: "backspace" });
        index += 1;
        continue;
      }
      const nextControl = findNextControl(chunk, index + 1);
      events.push({ name: "char", text: chunk.slice(index, nextControl) });
      index = nextControl;
    }
    return events;
  }

  private handlePaste(text: string): void {
    const normalized = text.replace(/\r\n?/g, "\n");
    this.buffer = this.buffer.slice(0, this.caret) + normalized + this.buffer.slice(this.caret);
    this.caret += normalized.length;
    this.render();
  }
}

function findNextControl(chunk: string, from: number): number {
  for (let index = from; index < chunk.length; index += 1) {
    const code = chunk.charCodeAt(index);
    if (code < 32 || code === 127 || code === 27) return index;
  }
  return chunk.length;
}

function ctrlName(code: number): string {
  if (code === 1) return "ctrl-a";
  if (code === 2) return "ctrl-b";
  if (code === 3) return "ctrl-c";
  if (code === 4) return "ctrl-d";
  if (code === 5) return "ctrl-e";
  if (code === 6) return "ctrl-f";
  if (code === 8) return "backspace";
  if (code === 11) return "ctrl-k";
  if (code === 12) return "ctrl-l";
  if (code === 14) return "ctrl-n";
  if (code === 16) return "ctrl-p";
  if (code === 21) return "ctrl-u";
  if (code === 23) return "ctrl-w";
  if (code === 27) return "escape";
  return "control";
}

function csiName(final: string, params: string): string {
  // `CSI 1;5C` is Ctrl+Right, `CSI 1;3C` is Alt+Right.
  const modifier = params.split(";")[1];
  if ((final === "C" || final === "D") && (modifier === "5" || modifier === "3")) {
    return final === "C" ? "word-right" : "word-left";
  }
  switch (final) {
    case "A":
      return "up";
    case "B":
      return "down";
    case "C":
      return "right";
    case "D":
      return "left";
    case "H":
      return "home";
    case "F":
      return "end";
    case "Z":
      return "shift-tab";
    case "~": {
      switch (params) {
        case "1":
        case "7":
          return "home";
        case "3":
          return "delete";
        case "4":
        case "8":
          return "end";
        case "5":
          return "pageup";
        case "6":
          return "pagedown";
        default:
          return "unknown";
      }
    }
    default:
      return "unknown";
  }
}

function lineStart(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index - 1);
  return newline === -1 ? 0 : newline + 1;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline;
}

function lineStartOf(text: string, line: number): number {
  let position = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = text.indexOf("\n", position);
    if (newline === -1) return position;
    position = newline + 1;
  }
  return position;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Marks and joiners that render as part of the glyph before them. */
function attachesToPrevious(code: number): boolean {
  return (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0xfeff
  );
}

function stepBack(text: string, index: number): number {
  if (index <= 0) return 0;
  if (isLowSurrogate(text.charCodeAt(index - 1)) && index >= 2) return index - 2;
  return index - 1;
}

function stepForward(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (isHighSurrogate(text.charCodeAt(index)) && index + 1 < text.length) return index + 2;
  return index + 1;
}

/**
 * Start of the grapheme before `index`. Editing by code units split surrogate
 * pairs, so backspacing an emoji left a lone surrogate in the buffer.
 */
export function previousGraphemeStart(text: string, index: number): number {
  let position = stepBack(text, index);
  while (position > 0) {
    const previous = text.charCodeAt(position - 1);
    if (isLowSurrogate(previous)) {
      position -= 1;
      continue;
    }
    if (attachesToPrevious(previous)) {
      position -= 1;
      continue;
    }
    // A ZWJ joins the preceding glyph into the same cluster (👨‍👩‍👧).
    if (previous === 0x200d) {
      position = stepBack(text, position - 1);
      continue;
    }
    break;
  }
  return position;
}

/** End of the grapheme starting at `index`. */
export function nextGraphemeEnd(text: string, index: number): number {
  let position = stepForward(text, index);
  while (position < text.length) {
    const code = text.charCodeAt(position);
    if (isLowSurrogate(code) || attachesToPrevious(code)) {
      position += 1;
      continue;
    }
    if (code === 0x200d) {
      position = stepForward(text, position + 1);
      continue;
    }
    break;
  }
  return position;
}

export function layoutLines(logical: string[], caret: number): { caretLine: number; caretColumnInLine: number } {
  const text = logical.join("\n");
  const before = text.slice(0, caret);
  const caretLine = before.split("\n").length - 1;
  const start = lineStartOf(text, caretLine);
  // A display column, not a code-unit offset: the caret is positioned in
  // terminal cells, so wide characters before it must count as two.
  return { caretLine, caretColumnInLine: visibleWidth(text.slice(start, caret)) };
}

interface DisplayRow {
  text: string;
  /** Display column inside its logical line where the row starts. */
  start: number;
  /** Index of the logical line the row belongs to. */
  line: number;
}

/** Every logical line split into the rows it occupies inside the box. */
function wrappedRows(logical: string[], width: number): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const [line, text] of logical.entries()) {
    for (const row of wrapColumns(text, width)) rows.push({ ...row, line });
  }
  return rows;
}

/** The row the caret sits on: the last row of its line that starts at or before it. */
function caretRowFor(rows: DisplayRow[], caretLine: number, caretColumnInLine: number): number {
  let index = 0;
  for (const [at, row] of rows.entries()) {
    if (row.line === caretLine && row.start <= caretColumnInLine) index = at;
  }
  return index;
}

export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < item.length && prefix[index] === item[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix;
}

interface PromptState {
  prompt: ConfirmPrompt;
  selected: number;
  resolve: (value: string) => void;
}

async function fallbackConfirm(prompt: ConfirmPrompt): Promise<string> {
  const fallback =
    prompt.options.find((option) => option.value === prompt.defaultOption) ??
    prompt.options.find((option) => option.value === "deny") ??
    prompt.options[prompt.options.length - 1]!;
  process.stderr.write(`\n${prompt.title}\n`);
  if (prompt.detail) process.stderr.write(`  ${prompt.detail}\n`);
  process.stderr.write(`  (no interactive terminal: defaulting to "${fallback.label}")\n`);
  return fallback.value;
}
