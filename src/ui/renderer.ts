import type { ResolvedConfig, UiConfig } from "../config/schema.ts";
import type { ConfirmPrompt, LogLevel, PromptApi, Tone, UiSink } from "../core/contracts.ts";
import type { ToolCallOutcome } from "../tools/types.ts";
import type { ContextStats } from "../core/context.ts";
import type { Message } from "../core/messages.ts";
import type { Effort } from "../config/schema.ts";
import type { Usage } from "../core/contracts.ts";
import { cacheMetrics } from "../providers/caching.ts";
import { formatCost, formatCount, formatDuration, truncate } from "../util/text.ts";
import { MarkdownStreamRenderer, defaultMarkdownTheme, renderMarkdown } from "./markdown.ts";
import { renderDiff } from "./diff.ts";
import { highlight } from "./highlight.ts";
import type { Screen } from "./screen.ts";
import type { Theme } from "./theme.ts";
import type { InputController } from "./input.ts";
import { strip } from "./ansi.ts";

export interface RendererOptions {
  screen: Screen;
  theme: Theme;
  config: ResolvedConfig;
  ui: UiConfig;
  input?: InputController;
  modelLabel: () => string;
  effortLabel: () => string;
  permissionLabel: () => string;
  contextStats: () => ContextStats;
  sessionUsage: () => Usage;
  gitBranch: () => string | undefined;
  planMode: () => boolean;
}

interface TodoView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export class Renderer implements UiSink, PromptApi {
  private readonly options: RendererOptions;
  private readonly screen: Screen;
  private readonly theme: Theme;
  private streams?: MarkdownStreamRenderer;
  private spinnerTimer?: NodeJS.Timeout;
  private spinnerFrame = 0;
  private activityBase = "Working";
  private activityStart = 0;
  private streamChars = 0;
  private reasoningChars = 0;
  private thinkingOpen = false;
  private toolStarts = new Map<string, { label: string; summary: string; startedAt: number }>();
  private todoItems: TodoView[] = [];
  private readonly statusValues = new Map<string, string>();
  private busy = false;

  constructor(options: RendererOptions) {
    this.options = options;
    this.screen = options.screen;
    this.theme = options.theme;
  }

  setInput(input: InputController): void {
    this.options.input = input;
  }

  // ------------------------------------------------------------------ agent UI

  turnStart(info: { turn: number; model: string; effort: Effort; reason?: string }): void {
    this.busy = true;
    this.streamChars = 0;
    this.reasoningChars = 0;
    this.streams = new MarkdownStreamRenderer({
      width: this.screen.width - 2,
      theme: this.theme,
      lineNumbers: false,
    });
    this.activityBase = info.reason ? `Thinking (${info.reason})` : "Thinking";
    this.activityStart = Date.now();
    this.startSpinner();
    this.options.input?.showQueued(0);
    this.options.input?.setPlaceholder("Streaming — Enter queues your message");
  }

  textDelta(delta: string): void {
    this.streamChars += delta.length;
    if (this.thinkingOpen && this.options.ui.showThinking) {
      this.screen.endStream();
      this.thinkingOpen = false;
    }
    const lines = this.streams?.push(delta) ?? [];
    for (const line of lines) this.screen.line(line);
  }

  thinkingDelta(delta: string): void {
    this.reasoningChars += delta.length;
    if (!this.options.ui.showThinking) return;
    if (!this.thinkingOpen) {
      this.screen.blank();
      this.thinkingOpen = true;
    }
    const cleaned = strip(delta);
    const segments = cleaned.split("\n");
    for (const segment of segments) {
      if (segment.trim()) this.screen.stream(this.theme.thinking(truncate(segment, this.screen.width - 4)));
      if (segment !== segments[segments.length - 1]) this.screen.stream("\n");
    }
  }

  toolStart(info: { id: string; name: string; label: string; summary: string; args: Record<string, unknown> }): void {
    this.endStreamingBlock();
    this.toolStarts.set(info.id, { label: info.label, summary: info.summary, startedAt: Date.now() });
    this.activityBase = `${info.label}${info.summary ? ` ${truncate(info.summary, 40)}` : ""}`;
    this.activityStart = Date.now();
    this.resetSpinnerClock();
  }

  toolProgress(id: string, text: string): void {
    const entry = this.toolStarts.get(id);
    if (!entry || !text.trim()) return;
    entry.summary = truncate(text.trim(), 60);
    this.activityBase = `${entry.label} ${truncate(text.trim(), 60)}`;
  }

  toolEnd(outcome: ToolCallOutcome): void {
    const start = this.toolStarts.get(outcome.callId);
    this.toolStarts.delete(outcome.callId);
    if (start) this.activityBase = start.label;

    const elapsed = outcome.durationMs;
    const label = start?.label ?? outcome.name;
    const detail = outcome.summary ?? summarizeOutcome(outcome);
    const left = `${this.theme.tone(outcome.isError ? "error" : "accent", this.theme.glyphs.tool)} ${label}${start?.summary ? this.theme.dim(`(${truncate(start.summary, 56)})`) : ""}`;
    const right = [detail, formatDuration(elapsed)].filter(Boolean).join(" · ");
    this.screen.line(this.screen.twoColumn(left, right));
    this.renderToolDetails(outcome);
  }

  usage(_usage: Usage, _stats: ContextStats): void {
    // The status line reads session usage directly; nothing to cache here.
  }

  notice(text: string, tone: Tone = "default"): void {
    this.endStreamingBlock();
    const prefix = tone === "warn" ? `${this.theme.warn("!")} ` : tone === "error" ? `${this.theme.error("✗")} ` : "  ";
    const paint = tone === "warn" ? this.theme.warn : tone === "error" ? this.theme.error : tone === "success" ? this.theme.success : this.theme.dim;
    for (const line of text.split("\n")) this.screen.line(`${prefix}${paint(line)}`);
  }

  compaction(info: { reason: string; folded: number; summary: string; tokensBefore: number; tokensAfter: number }): void {
    this.endStreamingBlock();
    this.screen.line(
      `${this.theme.info("⌁")} compacted ${info.folded} messages ${this.theme.dim(
        `(${formatCount(info.tokensBefore)} → ${formatCount(info.tokensAfter)} tokens)`,
      )}`,
    );
  }

  todos(todos: TodoView[]): void {
    const changed = todos.length !== this.todoItems.length || todos.some((todo, index) => this.todoItems[index]?.status !== todo.status);
    this.todoItems = todos;
    if (!changed) return;
    this.endStreamingBlock();
    for (const todo of todos) {
      const glyph = todo.status === "completed" ? this.theme.success("☑") : todo.status === "in_progress" ? this.theme.accent("▶") : this.theme.dim("☐");
      const text = todo.status === "completed" ? this.theme.dim(todo.content) : todo.content;
      this.screen.line(`  ${glyph} ${text}`);
    }
    this.screen.blank();
  }

  turnEnd(info: { turn: number; stopReason: string; usage: Usage; toolCalls: number; elapsedMs: number }): void {
    this.endStreamingBlock();
    this.stopSpinner();
    this.busy = false;
    this.toolStarts.clear();
    this.options.input?.setPlaceholder(undefined);
    this.options.input?.refresh();

    if (info.usage.costUsd) {
      this.statusValues.set("cost", formatCost(info.usage.costUsd));
    }
  }

  retry(info: { attempt: number; delayMs: number; reason: string; provider: string }): void {
    this.endStreamingBlock();
    this.screen.line(
      `  ${this.theme.warn("↻")} ${this.theme.dim(`${info.provider}: ${truncate(info.reason, 120)} — retrying in ${Math.round(info.delayMs / 100) / 10}s (attempt ${info.attempt + 1})`)}`,
    );
  }

  discardOutput(): void {
    // Output already written to the terminal cannot be rolled back, so mark the
    // boundary instead of letting the retry look like a duplicated answer.
    this.endStreamingBlock();
    this.screen.line(`  ${this.theme.warn("!")} ${this.theme.dim("the partial reply above was abandoned and is being retried")}`);
  }

  subagentEvent(event: { description: string; status: "start" | "done" | "error"; detail?: string }): void {
    if (event.status === "start") {
      // Keeps the spinner meaningful while a delegation runs for minutes.
      this.activityBase = `Subagent ${truncate(event.description, 40)}${event.detail ? ` · ${event.detail}` : ""}`;
      this.activityStart = Date.now();
      return;
    }
    if (event.status !== "error") return;
    this.endStreamingBlock();
    this.screen.line(`  ${this.theme.error(`subagent ${event.description} failed${event.detail ? `: ${event.detail}` : ""}`)}`);
  }

  error(error: unknown): void {
    this.endStreamingBlock();
    const message = error instanceof Error ? error.message : String(error);
    this.screen.line(`${this.theme.error("✗")} ${this.theme.error(message)}`);
    if (error instanceof Error && error.stack && process.env.BLUEBIRD_DEBUG) {
      this.screen.dim(error.stack);
    }
  }

  assistantMessage(message: Message): void {
    const text = message.blocks
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text) this.lastAssistantText = text;
  }

  private lastAssistantText = "";

  get assistantText(): string {
    return this.lastAssistantText;
  }

  // --------------------------------------------------------------------- sink

  progress(id: string, text: string): void {
    this.toolProgress(id, text);
  }

  status(key: string, value: string | undefined): void {
    if (value === undefined) this.statusValues.delete(key);
    else this.statusValues.set(key, value);
    this.options.input?.refresh();
  }

  log(level: LogLevel, message: string): void {
    if (level === "debug" && !process.env.BLUEBIRD_DEBUG) return;
    this.notice(message, level === "error" ? "error" : level === "warn" ? "warn" : "dim");
  }

  // ------------------------------------------------------------------- prompt

  async confirm(prompt: ConfirmPrompt): Promise<string> {
    this.endStreamingBlock();
    this.stopSpinner();
    if (this.options.input?.isActive) {
      const answer = await this.options.input.confirm(prompt);
      this.startSpinner();
      return answer;
    }
    const fallback = prompt.options.find((option) => option.value === "deny") ?? prompt.options[prompt.options.length - 1]!;
    this.notice(`${prompt.title} — ${prompt.detail ?? ""} (no terminal for confirmation, defaulting to "${fallback.label}")`, "warn");
    return fallback.value;
  }

  // ------------------------------------------------------------------ helpers

  statusLine(): string {
    const parts: string[] = [];
    const branch = this.options.gitBranch();
    if (branch) parts.push(branch);
    parts.push(this.options.modelLabel());
    parts.push(`effort:${this.options.effortLabel()}`);
    const permission = this.options.permissionLabel();
    if (permission) parts.push(permission);
    if (this.options.planMode()) parts.push(this.theme.warn("plan"));
    const stats = this.options.contextStats();
    if (this.options.ui.showUsage) {
      parts.push(`${formatCount(stats.totalTokens)}/${formatCount(stats.contextWindow)}`);
      const usage = this.options.sessionUsage();
      if (usage.costUsd) parts.push(formatCost(usage.costUsd));
      const cache = cacheMetrics(usage);
      if (cache.readTokens > 5000) parts.push(this.theme.dim(`cache ${(cache.hitRatio * 100).toFixed(0)}%`));
    }
    for (const [, value] of this.statusValues) {
      parts.push(value);
    }
    return parts.join(" · ");
  }

  private renderToolDetails(outcome: ToolCallOutcome): void {
    const display = outcome.display;
    if (!display) {
      if (outcome.isError) this.printErrorText(outcome.content);
      return;
    }

    if (display.kind === "diff" && display.diff) {
      if (this.options.ui.diff === "none") return;
      const full = this.options.ui.diff === "full";
      const body = full ? display.diff : compactDiff(display.diff, this.options.ui.collapseLines + 6);
      const rendered = renderDiff(body, {
        theme: this.theme,
        width: this.screen.width,
        maxLines: full ? 60 : 16,
      });
      for (const line of rendered.split("\n")) this.screen.line(`  ${line}`);
      return;
    }

    if (outcome.isError) {
      this.printErrorText(display.text ?? outcome.content);
      return;
    }

    const text = display.text ?? "";
    if (!text.trim()) return;
    if (display.collapseAfter === 0 && !this.options.ui.verboseToolOutput) return;
    const verbose = this.options.ui.verboseToolOutput;
    const limit = verbose ? 400 : this.options.ui.collapseLines;
    const lines = text.split("\n");
    if (limit > 0 && lines.length > limit && display.kind === "text") {
      // Show a useful preview plus a count. Returning here silently meant tool
      // output over the collapse threshold was never displayed at all.
      for (const line of lines.slice(0, limit)) {
        this.screen.line(`  ${this.theme.dim(truncate(line, this.screen.width - 2))}`);
      }
      this.screen.line(`  ${this.theme.dim(`… ${lines.length - limit} more lines (ui.verboseToolOutput = true to show all)`)}`);
      return;
    }
    for (const line of lines.slice(0, 40)) this.screen.line(`  ${this.theme.dim(truncate(line, this.screen.width - 2))}`);
  }

  private printErrorText(text: string): void {
    for (const line of text.split("\n").slice(0, 12)) {
      this.screen.line(`  ${this.theme.error(line)}`);
    }
  }

  private endStreamingBlock(): void {
    if (this.thinkingOpen) {
      this.screen.endStream();
      this.thinkingOpen = false;
      this.screen.blank();
    }
    const remaining = this.streams?.flush() ?? [];
    for (const line of remaining) this.screen.line(line);
    this.streams = undefined;
    this.screen.endStream();
  }

  renderMarkdownBlock(text: string): void {
    this.screen.line(renderMarkdown(text, { width: this.screen.width - 2, theme: this.theme }));
  }

  codeBlock(code: string, lang?: string): void {
    this.screen.line(highlight(code, lang, { theme: this.theme }));
  }

  markdownTheme() {
    return defaultMarkdownTheme(this.theme);
  }

  private startSpinner(): void {
    if (!this.options.ui.spinner || !this.screen.isTTY) return;
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.theme.spinner.length;
      const elapsed = Date.now() - this.activityStart;
      const tokens = Math.round((this.streamChars + this.reasoningChars) / 4);
      const meta = [formatDuration(elapsed), tokens > 0 ? `${formatCount(tokens)} tok` : undefined].filter(Boolean).join(" · ");
      const frame = this.theme.accent(this.theme.spinner[this.spinnerFrame]!);
      this.screen.setActivity(`  ${frame} ${this.theme.dim(`${this.activityBase} · ${meta}`)}`);
    }, 120);
    this.spinnerTimer.unref?.();
  }

  private resetSpinnerClock(): void {
    this.activityStart = Date.now();
    this.spinnerFrame = 0;
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.screen.clearActivity();
  }

  shutdown(): void {
    this.stopSpinner();
    this.screen.clearInput();
  }

  get isBusy(): boolean {
    return this.busy;
  }
}

function summarizeOutcome(outcome: ToolCallOutcome): string {
  const meta = outcome.meta ?? {};
  const bits: string[] = [];
  if (meta.exitCode !== undefined) bits.push(`exit ${meta.exitCode}`);
  if (meta.addedLines || meta.removedLines) bits.push(`+${meta.addedLines ?? 0} −${meta.removedLines ?? 0}`);
  if (outcome.isError) bits.push("failed");
  return bits.join(" · ");
}

/** Drops context lines so a diff fits the transcript without losing the changes. */
export function compactDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n").filter((line) => {
    if (line.startsWith("---") || line.startsWith("+++")) return true;
    if (line.startsWith("@@")) return true;
    if (line.startsWith("+") || line.startsWith("-")) return true;
    return false;
  });
  if (lines.length <= maxLines) return lines.join("\n");
  const kept = [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more changed lines (ui.diff = "full" to see everything)`];
  return kept.join("\n");
}
