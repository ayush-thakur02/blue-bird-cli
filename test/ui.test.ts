import assert from "node:assert/strict";
import test from "node:test";
import { charWidth, padEndVisible, strip, truncateVisible, visibleWidth, wrapVisible, boxify } from "../src/ui/ansi.ts";
import { createTheme } from "../src/ui/theme.ts";
import { renderInline, renderMarkdown, MarkdownStreamRenderer } from "../src/ui/markdown.ts";
import { detectLanguageFromPath, highlight, normalizeLanguage } from "../src/ui/highlight.ts";

const theme = createTheme("none");

test("visibleWidth counts wide characters and ignores ANSI", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("\u001b[31mhello\u001b[0m"), 5);
  assert.equal(visibleWidth("日本"), 4);
  assert.equal(charWidth("a".codePointAt(0)!), 1);
  assert.equal(charWidth("あ".codePointAt(0)!), 2);
});

test("truncateVisible respects the budget and keeps ANSI intact", () => {
  const line = "\u001b[31mabcdefghij\u001b[0m";
  const cut = truncateVisible(line, 5);
  assert.equal(visibleWidth(cut), 5);
  assert.ok(strip(cut).endsWith("…"));
});

test("wrapVisible never loses characters", () => {
  const text = "Tools on the wire: read, write, edit, multi_edit, glob, grep, bash, bash_output, kill_shell, task";
  const lines = wrapVisible(text, 40);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, `line too long: ${line}`);
  assert.equal(lines.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("wrapVisible re-applies color on continuation lines", () => {
  const lines = wrapVisible("\u001b[1mabcdef ghijkl mnopqr stuvwx\u001b[0m", 10);
  assert.ok(lines.length >= 2);
  assert.ok(lines[1]!.startsWith("\u001b[1m"));
});

test("boxify pads lines to a consistent width", () => {
  const box = boxify(["a", "longer line"], { width: 20 });
  assert.equal(box.length, 4);
  const widths = new Set(box.map((line) => visibleWidth(line)));
  assert.equal(widths.size, 1);
  assert.equal(padEndVisible("a", 3), "a  ");
});

test("renderInline styles code, bold and links without touching identifiers", () => {
  const out = strip(renderInline("call `multi_edit` and snake_case_name plus **bold** and [link](https://x.dev)", theme));
  assert.equal(out, "call multi_edit and snake_case_name plus bold and link");
});

test("renderMarkdown renders headings, lists, code, tables and quotes", () => {
  const markdown = [
    "# Title",
    "",
    "A paragraph with **bold**.",
    "",
    "- one",
    "- two",
    "  - nested",
    "",
    "```ts",
    "const x = 1; // note",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> quoted",
  ].join("\n");

  const rendered = strip(renderMarkdown(markdown, { width: 60, theme }));
  const lines = rendered.split("\n");
  assert.ok(lines.some((line) => line.includes("Title")), rendered);
  assert.ok(lines.some((line) => line.includes("• one")), rendered);
  assert.ok(lines.some((line) => line.includes("const x = 1")), rendered);
  assert.ok(lines.some((line) => line.includes("│") && line.includes("quoted")), rendered);
  assert.ok(lines.some((line) => line.includes("a") && line.includes("b") && line.includes("│")), rendered);
  const codeIndex = lines.findIndex((line) => line.includes("const x = 1"));
  const headerIndex = lines.findIndex((line) => line.trim() === "ts" || line.includes("ts"));
  assert.ok(codeIndex > -1);
  assert.ok(headerIndex === -1 || headerIndex <= codeIndex, "code fence label must precede the code");
  for (const line of lines) assert.ok(visibleWidth(line) <= 60, `too wide: ${line}`);
});

test("streaming markdown output matches the one-shot renderer", () => {
  const markdown = "# Head\n\nBody text that is long enough to wrap around the configured width for sure.\n\n```js\nlet a = 1;\n```\n";
  const streamed: string[] = [];
  const renderer = new MarkdownStreamRenderer({ width: 46, theme });
  for (const chunk of markdown.match(/[\s\S]{1,7}/g) ?? []) streamed.push(...renderer.push(chunk));
  streamed.push(...renderer.flush());
  const oneShot = renderMarkdown(markdown, { width: 46, theme }).split("\n");
  assert.deepEqual(trimTrailingBlanks(streamed).map(strip), trimTrailingBlanks(oneShot).map(strip));
});

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

test("language detection maps common extensions", () => {
  assert.equal(detectLanguageFromPath("src/app.ts"), "javascript");
  assert.equal(detectLanguageFromPath("main.py"), "python");
  assert.equal(detectLanguageFromPath("Dockerfile"), "dockerfile");
  assert.equal(detectLanguageFromPath("Makefile"), "makefile");
  assert.equal(normalizeLanguage("rs"), "rust");
  assert.equal(normalizeLanguage("not-a-language"), undefined);
});

test("highlight returns the original text when styling is disabled", () => {
  const code = "const x = 1;";
  assert.equal(highlight(code, "ts"), code);
  assert.ok(highlight(code, "ts", { theme: createTheme("dark") }).length >= code.length);
});
