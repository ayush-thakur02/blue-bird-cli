import path from "node:path";
import type { ConfirmPrompt, PromptApi, Usage } from "../core/contracts.ts";
import type { AgentUi } from "../core/agent.ts";
import { Runtime } from "../runtime.ts";
import { createTheme } from "../ui/theme.ts";
import { Renderer } from "../ui/renderer.ts";
import { Screen } from "../ui/screen.ts";
import { formatCost, formatCount, formatDuration } from "../util/text.ts";
import { isAbortError } from "../util/errors.ts";
import { collectOverrides, expandMentions } from "./chat.ts";
import type { ParsedArgs } from "../cli/args.ts";
import { flagBool, flagNumber, flagString } from "../cli/args.ts";

export interface RunOptions {
  cwd: string;
  args: ParsedArgs;
  prompt: string;
  outputFormat: "text" | "json" | "stream-json";
  quiet?: boolean;
}

export interface RunResult {
  text: string;
  usage: Usage;
  sessionId: string;
  turns: number;
  toolCalls: number;
  stopReason: string;
  durationMs: number;
  filesChanged: string[];
}

export async function runHeadless(options: RunOptions): Promise<number> {
  const json = options.outputFormat === "json" || options.outputFormat === "stream-json";
  const streamJson = options.outputFormat === "stream-json";
  const theme = createTheme(json || options.quiet ? "none" : "auto");
  const screen = new Screen({ out: process.stdout, theme });
  const autoApprove = flagBool(options.args, "yes") || flagBool(options.args, "danger");
  // Anything that is not the result belongs on stderr in machine-readable mode,
  // otherwise a single `attached x.ts` line makes the output unparseable.
  const diagnostic = (text: string): void => {
    if (options.quiet) return;
    if (json) process.stderr.write(`${text}\n`);
    else screen.line(text);
  };

  let runtime: Runtime;
  try {
    runtime = await Runtime.create({
      cwd: options.cwd,
      overrides: collectOverrides(options.args),
      ...(flagString(options.args, "config") ? { configPath: flagString(options.args, "config")! } : {}),
      headless: true,
      ...(flagBool(options.args, "plan") ? { planMode: true } : {}),
      ...(flagBool(options.args, "no-memory") ? { disableMemory: true } : {}),
      ...(flagBool(options.args, "no-subagents") ? { disableSubagents: true } : {}),
      ...(flagNumber(options.args, "max-turns") ? { maxTurns: flagNumber(options.args, "max-turns")! } : {}),
      logFile: path.join(options.cwd, ".bluebird", "logs", "headless.log"),
    });
  } catch (error) {
    process.stderr.write(`bluebird: ${(error as Error).message}\n`);
    return 1;
  }

  // Bound to the agent below, so Ctrl+C during a headless run actually cancels
  // the request instead of installing a handler that only suppresses the default
  // termination.
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  const promptApi: PromptApi = {
    async confirm(prompt: ConfirmPrompt) {
      const allow = autoApprove || ["yes", "session", "persist"].includes(prompt.defaultOption ?? "");
      return allow ? "yes" : "deny";
    },
  };

  const renderer = new Renderer({
    screen,
    theme,
    config: runtime.config,
    ui: { ...runtime.config.raw.ui!, spinner: false, statusLine: false },
    // Read from the agent: a provider failover switches what is actually used.
    modelLabel: () => runtime.agent.model.model.id,
    effortLabel: () => runtime.agent.effortsBadge(),
    permissionLabel: () => "",
    contextStats: () => runtime.agent.stats(),
    sessionUsage: () => runtime.sessionUsage(),
    gitBranch: () => runtime.git.branch,
    planMode: () => runtime.agent.planMode,
  });

  const ui: AgentUi = json
    ? {
        textDelta: (delta) => {
          if (streamJson) emit({ type: "text", delta });
        },
        thinkingDelta: () => {},
        toolStart: (info) => {
          if (streamJson) emit({ type: "tool_start", name: info.name, summary: info.summary });
        },
        toolEnd: (outcome) => {
          if (streamJson) {
            emit({
              type: "tool_end",
              name: outcome.name,
              isError: outcome.isError,
              summary: outcome.summary,
              durationMs: outcome.durationMs,
            });
          }
        },
        notice: (text) => {
          if (streamJson) emit({ type: "notice", text });
        },
        retry: (info) => {
          if (streamJson) emit({ type: "retry", attempt: info.attempt, delay_ms: info.delayMs, reason: info.reason });
        },
        subagentEvent: (event) => {
          if (streamJson) emit({ type: "subagent", description: event.description, status: event.status, detail: event.detail ?? null });
        },
        turnEnd: (info) => {
          if (streamJson) emit({ type: "turn_end", usage: info.usage, stopReason: info.stopReason });
        },
      }
    : {
        turnStart: () => screen.endStream(),
        textDelta: (delta) => screen.stream(delta),
        thinkingDelta: () => {},
        toolStart: (info) => {
          screen.endStream();
          if (!options.quiet) screen.line(`${theme.dim("·")} ${info.label} ${theme.dim(info.summary)}`);
        },
        toolEnd: (outcome) => {
          if (outcome.isError && !options.quiet) screen.line(`  ${theme.error(outcome.content.split("\n")[0] ?? "failed")}`);
        },
        notice: (text, tone) => {
          if (!options.quiet && tone !== "dim") {
            screen.endStream();
            screen.line(`  ${theme.dim(text)}`);
          }
        },
        discardOutput: () => {
          // The terminal cannot un-print the abandoned attempt, so name it.
          if (!options.quiet) {
            screen.endStream();
            screen.line(`  ${theme.warn("!")} the partial reply above was abandoned and is being retried`);
          }
        },
        subagentEvent: (event) => {
          if (!options.quiet && event.status !== "start") {
            const detail = event.detail ? ` · ${event.detail}` : "";
            screen.line(`  ${theme.dim(`subagent ${event.description} ${event.status}${detail}`)}`);
          }
        },
      };

  runtime.attachUi({ agentUi: ui, sink: renderer, promptApi });
  runtime.agent.setAbortSignal(controller.signal);

  const started = Date.now();
  let result: RunResult;
  try {
    // Headless runs honour the same @file and @image attachment syntax.
    const prepared = await expandMentions(options.prompt, runtime);
    for (const attachment of prepared.attachments) {
      diagnostic(theme.dim(`attached ${attachment.path}`));
    }
    for (const warning of prepared.warnings) {
      diagnostic(`${theme.warn("!")} ${theme.dim(warning)}`);
    }
    if (!prepared.prompt.trim()) {
      process.stderr.write(`${theme.error("nothing to do: the prompt was empty after expanding attachments")}\n`);
      runtime.dispose();
      return 1;
    }

    const turn = await runtime.agent.submit(
      prepared.prompt,
      prepared.images.length ? { images: prepared.images } : {},
    );
    const text = lastAssistantText(runtime) || turn.text;
    result = {
      text,
      usage: turn.usage,
      sessionId: runtime.session.id,
      turns: turn.turns,
      toolCalls: turn.toolCalls,
      stopReason: turn.stopReason,
      durationMs: Date.now() - started,
      filesChanged: [...runtime.agent.state.writes.keys()],
    };
  } catch (error) {
    if (isAbortError(error)) {
      if (json) emit({ type: "error", message: "aborted" });
      else process.stderr.write(`${theme.error("aborted")}\n`);
      runtime.dispose();
      return 130;
    }
    const message = (error as Error).message;
    if (json) emit({ type: "error", message });
    else process.stderr.write(`${theme.error(`error: ${message}`)}\n`);
    runtime.dispose();
    return 1;
  }

  if (json) {
    emit({
      type: "result",
      result: result.text,
      session_id: result.sessionId,
      usage: result.usage,
      turns: result.turns,
      tool_calls: result.toolCalls,
      stop_reason: result.stopReason,
      duration_ms: result.durationMs,
      files_changed: result.filesChanged,
      cost_usd: result.usage.costUsd ?? null,
    });
  } else {
    screen.endStream();
    if (!options.quiet) {
      const bits = [
        formatDuration(result.durationMs),
        `${formatCount(result.usage.inputTokens)} in / ${formatCount(result.usage.outputTokens)} out`,
        result.usage.costUsd ? formatCost(result.usage.costUsd) : undefined,
        `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}`,
      ].filter(Boolean);
      process.stderr.write(`\n${theme.dim(bits.join(" · "))}\n`);
    }
  }

  runtime.dispose();
  return 0;

  function emit(value: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function lastAssistantText(runtime: Runtime): string {
  for (let index = runtime.session.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.session.messages[index]!;
    if (message.role !== "assistant") continue;
    const text = message.blocks
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
