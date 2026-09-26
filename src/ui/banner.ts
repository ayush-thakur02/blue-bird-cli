import { APP_NAME, VERSION } from "../version.ts";
import type { Theme } from "./theme.ts";
import { padEndVisible, visibleWidth } from "./ansi.ts";

export interface BannerOptions {
  theme: Theme;
  width: number;
  model: string;
  effort: string;
  provider: string;
  endpoint: string;
  cwd: string;
  configPath?: string;
  permission: string;
  sessionId: string;
  tools: number;
  agents: number;
  skills: number;
  memoryFiles: number;
  planMode: boolean;
  gitBranch?: string;
  resumed?: boolean;
  warnings?: string[];
}

export function renderBanner(options: BannerOptions): string[] {
  const { theme } = options;
  const lines: string[] = [];
  const title = `${theme.primary("Blue Bird")} ${theme.dim(`v${VERSION}`)}`;
  const right = theme.dim(options.cwd.replace(process.env.HOME ?? "~", "~"));
  lines.push(twoColumn(`  ${title}`, right, options.width));
  lines.push("");

  const rows: [string, string][] = [
    ["model", `${options.model}  ${theme.dim(`(${options.provider})`)}`],
    ["endpoint", theme.dim(options.endpoint)],
    ["effort", options.effort],
    ["permissions", options.permission + (options.planMode ? theme.warn(" · plan mode") : "")],
    ["session", theme.dim(options.sessionId) + (options.resumed ? theme.dim(" (resumed)") : "")],
    [
      "context",
      [
        `${options.tools} tools`,
        options.agents ? `${options.agents} subagents` : undefined,
        options.skills ? `${options.skills} skills` : undefined,
        options.memoryFiles ? `${options.memoryFiles} instruction file${options.memoryFiles === 1 ? "" : "s"}` : undefined,
      ]
        .filter(Boolean)
        .join(theme.dim(" · ")),
    ],
  ];
  if (options.gitBranch) rows.push(["branch", theme.dim(options.gitBranch)]);

  for (const [label, value] of rows) {
    lines.push(`  ${theme.dim(padEndVisible(label, 12))}${value}`);
  }

  for (const warning of options.warnings ?? []) {
    lines.push(`  ${theme.warn("!")} ${theme.warn(warning)}`);
  }

  lines.push("");
  lines.push(`  ${theme.dim("Type /help for commands. Ctrl+C interrupts, twice to exit.")}`);
  lines.push("");
  return lines;
}

export function renderHeaderNote(theme: Theme): string {
  return theme.dim(`${APP_NAME} ${VERSION}`);
}

export function twoColumn(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
  if (gap < 1) return left;
  return `${left}${" ".repeat(gap)}${right}`;
}

export function helpText(): string[] {
  return [
    "Commands",
    "  /help              show this list",
    "  /model [name]      show or switch model",
    "  /provider [id]     show or switch provider",
    "  /effort [level]    auto | none | minimal | low | medium | high | xhigh",
    "  /permissions [p]   read-only | ask | edits | auto | danger-full-access",
    "  /plan              toggle plan mode (read-only investigation)",
    "  /compact [note]    summarize the session to free context",
    "  /context           context usage breakdown",
    "  /cost              token and cost totals for this session",
    "  /init              create .bluebird/config.json and BLUEBIRD.md",
    "  /memory            show the instruction files in effect",
    "  /tools [name]      list tools or describe one",
    "  /agents            list subagents",
    "  /skills            list skills",
    "  /sessions          list recent sessions",
    "  /resume <id>       resume a session",
    "  /undo              restore files from the last turn",
    "  /checkpoints       list restore points",
    "  /diff              show files changed in this session",
    "  /status            configuration and context summary",
    "  /export [file]     write the transcript as markdown",
    "  /clear             clear the conversation",
    "  /new               start a fresh session",
    "  /quit              exit (also Ctrl+D)",
    "",
    "Input",
    "  @path/to/file      attach a file to your message",
    "  !command           run a shell command directly",
    "  #note              append a note to BLUEBIRD.md",
    "  \\  at end of line  continue on a new line",
    "  Tab                complete commands and paths",
  ];
}
