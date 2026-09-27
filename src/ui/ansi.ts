const env = process.env;

function detectLevel(): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (env.FORCE_COLOR === "0") return 0;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    const parsed = Number(env.FORCE_COLOR);
    return (parsed === 1 ? 1 : parsed === 2 ? 2 : 3) as 1 | 2 | 3;
  }
  if (env.TERM === "dumb") return 0;
  if (!process.stdout.isTTY) return 0;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 3;
  if (env.TERM?.includes("256color")) return 2;
  return 1;
}

// `let` rather than `const`: the CLI sets NO_COLOR after this module has been
// imported (`--no-color`), and ESM live bindings carry that change to every
// reader. A frozen value meant `--no-color` could never work.
export let colorLevel: 0 | 1 | 2 | 3 = detectLevel();
export let colorEnabled = colorLevel > 0;

/** Re-reads NO_COLOR / FORCE_COLOR / TERM. Call after changing the environment. */
export function refreshColor(): void {
  colorLevel = detectLevel();
  colorEnabled = colorLevel > 0;
}

function detectUnicode(): boolean {
  if (env.BLUEBIRD_ASCII === "1") return false;
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  if (env.TERM === "dumb" && !locale) return false;
  return /utf-?8/i.test(locale) || locale === "" || Boolean(env.COLORTERM);
}

export const unicodeOk = detectUnicode();

export const ESC = "\u001b";

export function sgr(...codes: number[]): (text: string) => string {
  if (codes.length === 0) return (text) => text;
  const sequence = `${ESC}[${codes.join(";")}m`;
  // Checked per call so a later `refreshColor()` is respected by the module-level
  // helpers (`fg`, `bg`, `bold`) that are created once at import.
  return (text) => (colorEnabled ? `${sequence}${text}${ESC}[0m` : text);
}

export const reset = (text: string): string => text;
export const bold = sgr(1);
export const dim = sgr(2);
export const italic = sgr(3);
export const underline = sgr(4);
export const strikethrough = sgr(9);
export const inverse = sgr(7);

export const fg = {
  black: sgr(30),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  white: sgr(37),
  gray: sgr(90),
  grey: sgr(90),
  brightRed: sgr(91),
  brightGreen: sgr(92),
  brightYellow: sgr(93),
  brightBlue: sgr(94),
  brightMagenta: sgr(95),
  brightCyan: sgr(96),
  brightWhite: sgr(97),
} as const;

export const bg = {
  black: sgr(40),
  red: sgr(41),
  green: sgr(42),
  yellow: sgr(43),
  blue: sgr(44),
  magenta: sgr(45),
  cyan: sgr(46),
  white: sgr(47),
  gray: sgr(100),
} as const;

export function rgb(r: number, g: number, b: number): (text: string) => string {
  if (colorLevel === 3) return sgr(38, 2, clamp255(r), clamp255(g), clamp255(b));
  if (colorLevel === 2) {
    const index = 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
    return sgr(38, 5, index);
  }
  if (colorLevel === 1) {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 160 ? sgr(97) : sgr(37);
  }
  return (text) => text;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

const ANSI_PATTERN = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b\\[[0-9;?]*[ -/]*[@-~]",
    "\\u001b[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

export function strip(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Emoji-presentation code points outside the main emoji blocks. */
const EMOJI_PRESENTATION: [number, number][] = [
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];

function inRanges(codePoint: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff) return 0;
  if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return 0;
  if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return 0;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0;
  if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return 0;
  if (inRanges(codePoint, EMOJI_PRESENTATION)) return 2;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      // Every astral emoji block, including the transport, flag, chess and
      // symbol ranges that were previously measured as width 1 and skewed
      // every table, box and wrap that contained one.
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

const VARIATION_SELECTOR_16 = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;

function isCombiningMark(codePoint: number | undefined): boolean {
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200b ||
    codePoint === 0xfeff
  );
}

interface Cluster {
  text: string;
  width: number;
}

/**
 * Splits text into terminal cells. A grapheme cluster — base plus variation
 * selector, combining marks, or a ZWJ join — is one unit, so a family emoji
 * counts 2 columns rather than 6 and slicing never splits it down the middle.
 */
function clusters(plain: string): Cluster[] {
  const points = [...plain];
  const out: Cluster[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const codePoint = first.codePointAt(0) ?? 0;
    if (codePoint === ZERO_WIDTH_JOINER) {
      out.push({ text: first, width: 0 });
      continue;
    }
    let text = first;
    let width = charWidth(codePoint);
    if (points[index + 1]?.codePointAt(0) === VARIATION_SELECTOR_16) {
      text += points[index + 1]!;
      index += 1;
      width = Math.max(width, 2);
    }
    while (points[index + 1]?.codePointAt(0) === ZERO_WIDTH_JOINER && points[index + 2] !== undefined) {
      text += points[index + 1]! + points[index + 2]!;
      index += 2;
      if (points[index + 1]?.codePointAt(0) === VARIATION_SELECTOR_16) {
        text += points[index + 1]!;
        index += 1;
        width = Math.max(width, 2);
      }
    }
    while (isCombiningMark(points[index + 1]?.codePointAt(0))) {
      text += points[index + 1]!;
      index += 1;
    }
    out.push({ text, width });
  }
  return out;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(strip(text))) width += cluster.width;
  return width;
}

interface Segment {
  text: string;
  width: number;
  isAnsi: boolean;
}

function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  ANSI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_PATTERN.exec(text)) !== null) {
    if (match.index > index) pushPlain(segments, text.slice(index, match.index));
    segments.push({ text: match[0], width: 0, isAnsi: true });
    index = match.index + match[0].length;
  }
  if (index < text.length) pushPlain(segments, text.slice(index));
  return segments;
}

function pushPlain(segments: Segment[], text: string): void {
  for (const cluster of clusters(text)) {
    segments.push({ text: cluster.text, width: cluster.width, isAnsi: false });
  }
}

export function sliceVisible(text: string, start: number, end: number): string {
  let column = 0;
  let out = "";
  let started = false;
  for (const seg of segment(text)) {
    if (seg.isAnsi) {
      if (started) out += seg.text;
      continue;
    }
    const next = column + seg.width;
    if (next > start && column < end) {
      out += seg.text;
      started = true;
    }
    column = next;
    if (column >= end) break;
  }
  return out;
}

export function truncateVisible(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (width <= ellipsisWidth) return sliceVisible(text, 0, width);
  return `${sliceVisible(text, 0, width - ellipsisWidth)}${ellipsis}`;
}

export function padEndVisible(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

export function padStartVisible(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${" ".repeat(gap)}${text}` : text;
}

export function wrapVisible(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let active = "";
  let pending = "";
  let pendingWidth = 0;

  const pushLine = (): void => {
    lines.push(active ? `${line.replace(/\s+$/, "")}${ESC}[0m` : line.replace(/\s+$/, ""));
    line = active;
    lineWidth = 0;
  };

  for (const seg of segment(text)) {
    if (seg.isAnsi) {
      active = applySgr(active, seg.text);
      pending += seg.text;
      continue;
    }
    if (seg.text === "\n") {
      line += pending;
      pending = "";
      pendingWidth = 0;
      pushLine();
      continue;
    }
    if (seg.text === " ") {
      line += pending;
      lineWidth += pendingWidth;
      pending = "";
      pendingWidth = 0;
      if (lineWidth > 0) {
        line += " ";
        lineWidth += 1;
      }
      continue;
    }
    if (lineWidth + pendingWidth + seg.width > width && lineWidth > 0) {
      pushLine();
    }
    if (pendingWidth + seg.width > width && lineWidth === 0 && pendingWidth > 0) {
      lines.push(active ? `${line + pending}${ESC}[0m` : line + pending);
      line = active;
      lineWidth = 0;
      pending = "";
      pendingWidth = 0;
    }
    pending += seg.text;
    pendingWidth += seg.width;
  }

  line += pending;
  lines.push(active ? `${line.replace(/\s+$/, "")}${ESC}[0m` : line.replace(/\s+$/, ""));
  return lines;
}

function applySgr(active: string, sequence: string): string {
  const resetIndex = sequence.lastIndexOf("[0m");
  if (resetIndex === -1) return `${active}${sequence}`;
  return sequence.slice(resetIndex + 3);
}

export interface ColumnRow {
  text: string;
  /** Display column inside the source text where this row starts. */
  start: number;
}

/**
 * Splits plain text into rows of at most `width` display columns. Rows break on
 * grapheme boundaries, so a wide character is never cut in half, and each row
 * reports the column it starts at — enough to map a caret back to a row.
 */
export function wrapColumns(text: string, width: number): ColumnRow[] {
  if (width < 1) return [{ text, start: 0 }];
  const rows: ColumnRow[] = [];
  let row = "";
  let rowWidth = 0;
  let start = 0;
  for (const cluster of clusters(text)) {
    if (rowWidth > 0 && rowWidth + cluster.width > width) {
      rows.push({ text: row, start });
      start += rowWidth;
      row = "";
      rowWidth = 0;
    }
    row += cluster.text;
    rowWidth += cluster.width;
  }
  rows.push({ text: row, start });
  return rows;
}

/**
 * Code-unit offset of a display column inside `text`. A column pointing into a
 * wide cluster snaps to the cluster's start, because a caret cannot sit in the
 * middle of a character.
 */
export function offsetAtColumn(text: string, column: number): number {
  let width = 0;
  let offset = 0;
  for (const cluster of clusters(text)) {
    if (width + cluster.width > column) break;
    width += cluster.width;
    offset += cluster.text.length;
  }
  return offset;
}

export function hrule(width: number, char = "─"): string {
  if (!unicodeOk) char = "-";
  const repeat = Math.max(0, width);
  return char.repeat(repeat).slice(0, repeat);
}

export function hyperlink(text: string, url: string): string {
  if (!colorEnabled || env.BLUEBIRD_NO_LINKS === "1") return text;
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

export function boxify(
  lines: string[],
  opts: {
    width?: number;
    padding?: number;
    title?: string;
    titleAlign?: "left" | "center";
    paint?: (text: string) => string;
    border?: (text: string) => string;
  } = {},
): string[] {
  const padding = opts.padding ?? 1;
  const innerWidth =
    opts.width ?? Math.max(...lines.map((line) => visibleWidth(line)), opts.title ? visibleWidth(opts.title) + 2 : 0) + padding * 2;
  const paint = opts.paint ?? ((text: string) => text);
  const border = opts.border ?? ((text: string) => text);
  const titleText = opts.title ? ` ${opts.title} ` : "";
  const titleWidth = visibleWidth(titleText);
  const leftTitle = opts.titleAlign === "center" ? Math.max(0, Math.floor((innerWidth - titleWidth) / 2)) : 0;
  const top = border(
    `╭${hrule(leftTitle)}${titleText ? paint(titleText) : ""}${hrule(Math.max(0, innerWidth - leftTitle - titleWidth))}╮`,
  );
  const bottom = border(`╰${hrule(innerWidth)}╯`);
  const body = lines.map((line) => {
    const content = padEndVisible(truncateVisible(line, innerWidth - padding * 2), innerWidth - padding * 2);
    return `${border("│")}${" ".repeat(padding)}${content}${" ".repeat(padding)}${border("│")}`;
  });
  return [top, ...body, bottom];
}

export const cursor = {
  up(count = 1): string {
    return count > 0 ? `${ESC}[${count}A` : "";
  },
  down(count = 1): string {
    return count > 0 ? `${ESC}[${count}B` : "";
  },
  toColumn(column: number): string {
    return `${ESC}[${Math.max(1, column)}G`;
  },
  clearLine(): string {
    return `${ESC}[2K`;
  },
  clearDown(): string {
    return `${ESC}[0J`;
  },
  hide(): string {
    return `${ESC}[?25l`;
  },
  show(): string {
    return `${ESC}[?25h`;
  },
  save(): string {
    return `${ESC}7`;
  },
  restore(): string {
    return `${ESC}8`;
  },
};

export function measure(text: string): { width: number; lines: number } {
  const plainLines = strip(text).split("\n");
  return {
    width: Math.max(0, ...plainLines.map((line) => visibleWidth(line))),
    lines: plainLines.length,
  };
}
