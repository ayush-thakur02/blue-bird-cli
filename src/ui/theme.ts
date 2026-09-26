import type { Tone } from "../core/contracts.ts";
import { colorLevel, dim as dimStyle, fg, italic, rgb, sgr, unicodeOk } from "./ansi.ts";

export interface Theme {
  name: "dark" | "light" | "none";
  primary(text: string): string;
  accent(text: string): string;
  dim(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warn(text: string): string;
  error(text: string): string;
  info(text: string): string;
  code(text: string): string;
  heading(text: string, level: number): string;
  thinking(text: string): string;
  border(text: string): string;
  diffAdd(text: string): string;
  diffDel(text: string): string;
  diffHunk(text: string): string;
  diffMeta(text: string): string;
  link(text: string): string;
  tone(tone: Tone, text: string): string;
  readonly spinner: readonly string[];
  readonly glyphs: {
    prompt: string;
    tool: string;
    user: string;
    assistant: string;
    bullet: string;
    check: string;
    cross: string;
    arrow: string;
    dot: string;
    warning: string;
    info: string;
  };
}

export function resolveThemeName(name: "auto" | "dark" | "light" | "none"): "dark" | "light" | "none" {
  if (name !== "auto") return name;
  if (colorLevel === 0) return "none";
  const background = process.env.COLORFGBG?.split(";").pop();
  if (background && Number(background) >= 7) return "light";
  return "dark";
}

export function createTheme(
  name: "auto" | "dark" | "light" | "none",
  opts: { colorLevel?: 0 | 1 | 2 | 3; unicode?: boolean } = {},
): Theme {
  const resolved = resolveThemeName(name);
  const unicode = opts.unicode ?? unicodeOk;
  const level = opts.colorLevel ?? colorLevel;
  const plain = (text: string) => text;
  const paint = (codes: number[]): ((text: string) => string) => (level === 0 ? plain : sgr(...codes));
  const color = (truecolor: [number, number, number], fallback: (text: string) => string) =>
    level === 3 ? rgb(...truecolor) : level === 0 ? plain : fallback;

  const dark = resolved === "dark";
  const none = resolved === "none";

  const primary = none
    ? plain
    : dark
      ? color([122, 162, 247], fg.brightBlue)
      : color([52, 84, 138], fg.blue);
  const accent = none ? plain : dark ? color([125, 207, 255], fg.cyan) : color([10, 110, 160], fg.cyan);
  const success = none ? plain : dark ? color([115, 218, 155], fg.green) : color([26, 122, 71], fg.green);
  const warn = none ? plain : dark ? color([224, 175, 104], fg.yellow) : color([150, 96, 0], fg.yellow);
  const error = none ? plain : dark ? color([247, 118, 142], fg.red) : color([176, 35, 63], fg.red);
  const info = none ? plain : dark ? color([125, 207, 255], fg.cyan) : color([10, 110, 160], fg.blue);

  const spinner = unicode
    ? (["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const)
    : (["|", "/", "-", "\\"] as const);

  const glyphs = {
    prompt: unicode ? "❯" : ">",
    tool: unicode ? "⏺" : "*",
    user: unicode ? "›" : ">",
    assistant: unicode ? "✻" : "*",
    bullet: unicode ? "•" : "-",
    check: unicode ? "✓" : "+",
    cross: unicode ? "✗" : "x",
    arrow: unicode ? "→" : "->",
    dot: unicode ? "·" : ".",
    warning: unicode ? "!" : "!",
    info: unicode ? "i" : "i",
  };

  const tone = (value: Tone, text: string): string => {
    switch (value) {
      case "dim":
        return dimStyle(text);
      case "muted":
        return dimStyle(text);
      case "info":
        return info(text);
      case "accent":
        return accent(text);
      case "success":
        return success(text);
      case "warn":
        return warn(text);
      case "error":
        return error(text);
      default:
        return text;
    }
  };

  return {
    name: resolved,
    primary,
    accent,
    dim: dimStyle,
    muted: (text) => dimStyle(text),
    success,
    warn,
    error,
    info,
    code: (text) => (none ? text : dark ? color([154, 215, 255], fg.cyan)(text) : color([12, 96, 143], fg.cyan)(text)),
    heading: (text, headingLevel) => {
      if (none) return text;
      if (headingLevel <= 1) return primary(paint([1])(text));
      if (headingLevel === 2) return primary(text);
      return paint([1])(text);
    },
    thinking: (text) => (none ? text : italic(dimStyle(text))),
    border: (text) => (none ? text : dark ? color([61, 89, 161], fg.gray)(text) : color([150, 160, 175], fg.gray)(text)),
    diffAdd: none ? plain : dark ? color([115, 218, 155], fg.green) : color([26, 122, 71], fg.green),
    diffDel: none ? plain : dark ? color([247, 118, 142], fg.red) : color([176, 35, 63], fg.red),
    diffHunk: none ? plain : dark ? color([125, 207, 255], fg.cyan) : color([10, 110, 160], fg.cyan),
    diffMeta: none ? plain : dark ? color([115, 218, 155], fg.green) : color([26, 122, 71], fg.green),
    link: none ? plain : dark ? color([125, 207, 255], fg.cyan) : color([10, 110, 160], fg.blue),
    tone,
    spinner,
    glyphs,
  };
}
