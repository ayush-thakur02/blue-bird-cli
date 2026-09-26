import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Screen } from "../src/ui/screen.ts";
import { InputController } from "../src/ui/input.ts";
import { createTheme } from "../src/ui/theme.ts";

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  paused = false;
  setRawMode(value: boolean): this {
    this.raw = value;
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  setEncoding(): this {
    return this;
  }
  type(text: string): void {
    this.emit("data", text);
  }
}

/**
 * Replays the cursor movements in what was written, so a test can assert where
 * the cursor ended up instead of only what the bytes looked like.
 */
function applyCursor(text: string, row: number): number {
  let value = row;
  const pattern = /\n|\u001b\[(\d*)([AB])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    value += (text.slice(last, match.index).match(/\n/g) ?? []).length;
    if (match[0] === "\n") value += 1;
    else if (match[2] === "A") value -= Number(match[1] || 1);
    else value += Number(match[1] || 1);
    last = match.index + match[0].length;
  }
  value += (text.slice(last).match(/\n/g) ?? []).length;
  return value;
}

interface Harness {
  screen: Screen;
  input: InputController;
  stdin: FakeStdin;
  writes: string[];
  row: number;
  interrupts: number;
  exits: number;
}

function createHarness(options: { isBusy?: () => boolean; status?: () => string | undefined; columns?: number } = {}): Harness {
  const theme = createTheme("none", { colorLevel: 0, unicode: true });
  const state: Harness = {
    screen: undefined as unknown as Screen,
    input: undefined as unknown as InputController,
    stdin: new FakeStdin(),
    writes: [],
    row: 20,
    interrupts: 0,
    exits: 0,
  };
  const out = {
    isTTY: true,
    columns: options.columns ?? 80,
    write(text: string) {
      state.writes.push(text);
      state.row = applyCursor(text, state.row);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const screen = new Screen({ out, theme });
  const input = new InputController({
    stdin: state.stdin as unknown as NodeJS.ReadStream,
    screen,
    theme,
    isBusy: options.isBusy ?? (() => false),
    ...(options.status ? { statusLine: options.status } : {}),
    onSubmit: () => {},
    onInterrupt: () => {
      state.interrupts += 1;
    },
    onExit: () => {
      state.exits += 1;
    },
  });
  state.screen = screen;
  state.input = input;
  return state;
}

test("typing does not walk the input box up the screen", () => {
  const harness = createHarness();
  harness.input.start();
  const restingRow = harness.row;

  for (const char of "hello world") {
    harness.stdin.type(char);
    assert.equal(harness.row, restingRow, `the box moved after typing "${char}"`);
  }

  // Backspace, cursor movement and home/end must be just as stable.
  for (const key of ["\u007f", "\u001b[D", "\u001b[H", "\u001b[F"]) {
    harness.stdin.type(key);
    assert.equal(harness.row, restingRow, `the box moved after ${JSON.stringify(key)}`);
  }
});

test("the caret is placed after the typed text, inside the box border", () => {
  const harness = createHarness();
  harness.input.start();
  harness.writes.length = 0;
  harness.stdin.type("hi");

  const output = harness.writes.join("");
  // Border, space, prompt glyph and a space are 4 cells, so column 7 is the cell
  // right after "hi" — one-based, which is what `CSI n G` expects.
  assert.match(output, /\u001b\[7G/, `expected the caret at column 7, got ${JSON.stringify(output)}`);
  assert.match(output, /│ ❯ hi\s+│/, "the text is drawn inside the frame");
});

test("a status line and a completion list stay inside the redrawn block", () => {
  const harness = createHarness({ status: () => "main · gpt-5 · 12k/1M" });
  harness.input.start();
  const restingRow = harness.row;

  harness.stdin.type("\t");
  for (const char of "abc") {
    harness.stdin.type(char);
    assert.equal(harness.row, restingRow, `the footer moved the box after typing "${char}"`);
  }
  assert.match(harness.writes.join(""), /12k\/1M/, "the status line is drawn under the box");
});

test("a permission prompt redraws in place and forgets nothing", async () => {
  const harness = createHarness();
  harness.input.start();
  const caretRow = harness.row;
  const boxTop = caretRow - 1;

  const pending = harness.input.confirm({
    title: "Run this command?",
    options: [
      { value: "yes", label: "Yes", key: "y" },
      { value: "deny", label: "No", key: "n" },
    ],
  });
  assert.match(harness.writes.join(""), /y\) Yes.*n\) No/, "the options are part of the block");
  assert.equal(harness.row, boxTop, "the prompt takes over the rows the box occupied");

  harness.stdin.type("\u001b[D"); // arrow to the first option
  assert.equal(harness.row, boxTop, "moving the selection must not move the box");

  harness.stdin.type("y");
  assert.equal(await pending, "yes");
  assert.equal(harness.row, caretRow, "the input box returns to the row it was on");
});

test("Ctrl+C interrupts a busy turn, and the second press exits", () => {
  let busy = true;
  const harness = createHarness({ isBusy: () => busy });
  harness.input.start();

  harness.stdin.type("\u0003");
  assert.equal(harness.interrupts, 1);
  assert.equal(harness.exits, 0, "one press must not quit a running turn");

  harness.stdin.type("still typing");
  harness.stdin.type("\u0003");
  assert.equal(harness.interrupts, 1, "the second press within the window exits instead of interrupting");

  busy = false;
  const idle = createHarness();
  idle.input.start();
  idle.stdin.type("a draft");
  idle.stdin.type("\u0003");
  assert.equal(idle.exits, 0, "an idle Ctrl+C clears the draft first");
  idle.stdin.type("\u0003");
  assert.equal(idle.exits, 1, "a second Ctrl+C on an empty prompt quits");
});

test("stopping the controller hands the terminal back", () => {
  const harness = createHarness();
  harness.input.start();
  assert.equal(harness.stdin.raw, true, "the session owns raw mode");

  harness.input.stop();
  assert.equal(harness.stdin.raw, false, "raw mode is restored");
  assert.equal(harness.stdin.paused, true, "a resumed TTY would keep the process alive after exit");
});

test("nothing is drawn while a turn is busy", () => {
  let busy = false;
  const harness = createHarness({ isBusy: () => busy });
  harness.input.start();
  const boxTop = harness.row - 1;
  harness.writes.length = 0;

  busy = true;
  harness.stdin.type("queued while streaming");

  assert.equal(harness.writes.length, 1, "the box is cleared once and not redrawn");
  assert.match(harness.writes[0]!, /^\r/, "only the erase sequence is written");
  assert.equal(harness.row, boxTop, "the cursor is left at the top of the erased box");
});
