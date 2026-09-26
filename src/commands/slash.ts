import path from "node:path";
import fs from "node:fs";
import type { Runtime } from "../runtime.ts";
import type { Screen } from "../ui/screen.ts";
import type { Theme } from "../ui/theme.ts";
import type { InputController } from "../ui/input.ts";
import type { Renderer } from "../ui/renderer.ts";
import type { Effort, EffortSetting, PermissionPresetValue } from "../config/schema.ts";
import { EFFORT_DESCRIPTIONS, EFFORT_LEVELS } from "../config/schema.ts";
import { PERMISSION_PRESETS } from "../core/contracts.ts";
import { redactConfig, resolveModel } from "../config/load.ts";
import { analyzeContext } from "../core/context.ts";
import { formatBytes, formatCost, formatCount, formatDuration, truncate } from "../util/text.ts";
import { relativePath } from "../util/paths.ts";
import { substituteArguments } from "../core/extensions.ts";
import { formatCacheSummary, cacheMetrics } from "../providers/caching.ts";
import { modelSupportsImages } from "../core/vision.ts";
import { helpText } from "../ui/banner.ts";
import { exportTranscript } from "../core/session.ts";
import { writeFileSync } from "node:fs";

export interface SlashContext {
  runtime: Runtime;
  renderer: Renderer;
  screen: Screen;
  theme: Theme;
  input: InputController;
  exit: () => void;
  /** Replace the session (used by /new, /resume). */
  reload: (options: { resumeId?: string; fresh?: boolean }) => Promise<void>;
  runPrompt: (text: string) => Promise<void>;
  clearTranscript: () => void;
}

export interface SlashResult {
  handled: boolean;
  /** A prompt to send to the model (custom commands and /init forwards). */
  prompt?: string;
  exit?: boolean;
}

const COMMAND_ALIASES: Record<string, string> = {
  q: "quit",
  exit: "quit",
  "?": "help",
  h: "help",
  permission: "permissions",
  perms: "permissions",
  effort: "effort",
  ctx: "context",
  context: "context",
  models: "model",
  plan: "plan",
  history: "sessions",
};

export async function handleSlashCommand(line: string, ctx: SlashContext): Promise<SlashResult> {
  const trimmed = line.trim();
  const spaceIndex = trimmed.search(/\s/);
  const rawName = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase();
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
  const name = COMMAND_ALIASES[rawName] ?? rawName;
  const { runtime, screen, theme } = ctx;
  const print = (text: string) => screen.line(text);

  switch (name) {
    case "help": {
      for (const line of helpText()) print(line);
      const custom = runtime.commands.length
        ? ["", "Project commands", ...runtime.commands.map((command) => `  /${command.name.padEnd(17)} ${command.description}`)]
        : [];
      for (const entry of custom) print(entry);
      return { handled: true };
    }

    case "quit":
    case "exit": {
      ctx.exit();
      return { handled: true, exit: true };
    }

    case "effort": {
      const agent = runtime.agent;
      if (!args) {
        print(`${theme.dim("current")}  ${agent.effortsBadge()}`);
        print("");
        for (const level of EFFORT_LEVELS) {
          print(`  ${level.padEnd(8)} ${theme.dim(EFFORT_DESCRIPTIONS[level])}`);
        }
        print(`  ${"auto".padEnd(8)} ${theme.dim("pick per request from the prompt (default)")}`);
        return { handled: true };
      }
      const value = args.toLowerCase() as EffortSetting;
      if (value !== "auto" && !EFFORT_LEVELS.includes(value as Effort)) {
        print(theme.error(`Unknown effort "${args}". Use auto, ${EFFORT_LEVELS.join(", ")}.`));
        return { handled: true };
      }
      agent.setEffort(value);
      print(`${theme.success("✓")} effort set to ${theme.accent(value)}${value === "auto" ? theme.dim(` (currently ${agent.effortsBadge()})`) : ""}`);
      return { handled: true };
    }

    case "model": {
      const available = availableModels(runtime);
      if (!args) {
        print(`${theme.dim("current")}  ${runtime.model.label} ${theme.dim(`(${runtime.model.api})`)}`);
        if (available.length) {
          print("");
          for (const entry of available) {
            const marker = entry.label === runtime.model.label ? theme.accent("●") : theme.dim("○");
            print(`  ${marker} ${entry.label}`);
          }
        }
        return { handled: true };
      }
      const target = available.find((entry) => entry.label === args || entry.model === args || entry.label.endsWith(`/${args}`));
      if (!target) {
        print(theme.error(`Unknown model "${args}".`));
        if (available.length) print(theme.dim(`Available: ${available.map((entry) => entry.label).join(", ")}`));
        return { handled: true };
      }
      try {
        const resolved = resolveModel(runtime.config.raw, { provider: target.provider, model: target.model }, []);
        runtime.switchModel(resolved);
        print(`${theme.success("✓")} model switched to ${theme.accent(resolved.label)} ${theme.dim(`(${resolved.api})`)}`);
      } catch (error) {
        print(theme.error((error as Error).message));
      }
      return { handled: true };
    }

    case "provider": {
      const providers = Object.keys(runtime.config.raw.providers ?? {});
      if (!args) {
        print(`${theme.dim("current")}  ${runtime.model.providerId}`);
        for (const id of providers) {
          const def = runtime.config.raw.providers![id]!;
          print(`  ${id === runtime.model.providerId ? theme.accent("●") : theme.dim("○")} ${id} ${theme.dim(`(${def.api})`)}`);
          print(`      ${theme.dim(def.baseURL)}`);
        }
        return { handled: true };
      }
      if (!providers.includes(args)) {
        print(theme.error(`Unknown provider "${args}".`));
        return { handled: true };
      }
      try {
        const resolved = resolveModel(runtime.config.raw, { provider: args }, []);
        runtime.switchModel(resolved);
        print(`${theme.success("✓")} provider switched to ${theme.accent(args)} using ${resolved.model.id}`);
      } catch (error) {
        print(theme.error((error as Error).message));
      }
      return { handled: true };
    }

    case "permissions": {
      const engine = runtime.permissions;
      if (!args) {
        const rules = engine.rules();
        print(`${theme.dim("current")}  ${engine.preset}`);
        for (const preset of PERMISSION_PRESETS) print(`  ${preset === engine.preset ? theme.accent("●") : theme.dim("○")} ${preset}`);
        if (rules.allow.length) print(`  ${theme.dim("allow")} ${rules.allow.join(", ")}`);
        if (rules.deny.length) print(`  ${theme.dim("deny ")} ${rules.deny.join(", ")}`);
        return { handled: true };
      }
      const [sub, ...rest] = args.split(/\s+/);
      if (sub === "allow" || sub === "deny") {
        const rule = rest.join(" ");
        if (!rule) {
          print(theme.error(`Usage: /permissions ${sub} <Tool(pattern)>`));
          return { handled: true };
        }
        engine.addRule(sub, rule);
        print(`${theme.success("✓")} ${sub} rule added: ${rule}`);
        return { handled: true };
      }
      if (!PERMISSION_PRESETS.includes(sub as PermissionPresetValue)) {
        print(theme.error(`Unknown preset "${sub}".`));
        return { handled: true };
      }
      engine.setPreset(sub as PermissionPresetValue);
      print(`${theme.success("✓")} permission mode set to ${theme.accent(sub)}`);
      return { handled: true };
    }

    case "plan": {
      const next = args ? ["on", "true", "yes", "1"].includes(args.toLowerCase()) : !runtime.agent.planMode;
      runtime.agent.setPlanMode(next);
      print(
        next
          ? `${theme.warn("plan mode on")} — the agent investigates and proposes, it will not modify files.`
          : `${theme.success("✓")} plan mode off — the agent can modify files again.`,
      );
      return { handled: true };
    }

    case "compact": {
      await runtime.agent.compact({ reason: "manual", ...(args ? { instructions: args } : {}) });
      return { handled: true };
    }

    case "context": {
      const stats = runtime.agent.stats();
      const session = runtime.session.info();
      const window = runtime.agent.contextWindow();
      print(`${theme.dim("context window")}  ${formatCount(window)} tokens ${theme.dim(`(${runtime.model.model.id}${runtime.model.model.assumedWindow ? ", assumed — declare contextWindow to pin it" : ""})`)}`);
      print(`  system      ${formatCount(stats.systemTokens)}`);
      print(`  messages    ${formatCount(stats.messageTokens)} ${theme.dim(`(${formatCount(stats.toolResultTokens)} in tool output)`)}`);
      print(`  used        ${theme.accent(`${(stats.ratio * 100).toFixed(1)}%`)} of the budget ${theme.dim(`(compaction at ${((runtime.config.raw.context?.compactAt ?? 0.82) * 100).toFixed(0)}%)`)}`);
      print(`  remaining   ${formatCount(stats.remainingTokens)}`);
      print(`  history     ${session.messages} messages in ${stats.turns} turn(s)`);
      const cache = formatCacheSummary(runtime.sessionUsage());
      if (cache) print(`  caching     ${cache}`);
      return { handled: true };
    }

    case "cost": {
      const usage = runtime.sessionUsage();
      print(`tokens      ${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out · ${formatCount(usage.totalTokens ?? 0)} total`);
      const metrics = cacheMetrics(usage);
      if (metrics.readTokens || metrics.writeTokens) {
        print(
          `cache       ${formatCount(metrics.readTokens)} read ${theme.dim(`(${(metrics.hitRatio * 100).toFixed(0)}% of prompt tokens)`)}` +
            (metrics.writeTokens ? ` · ${formatCount(metrics.writeTokens)} written` : ""),
        );
      } else {
        print(`cache       ${theme.dim("no cache activity recorded yet")}`);
      }
      if (usage.reasoningTokens) print(`reasoning   ${formatCount(usage.reasoningTokens)}`);
      print(`cost        ${usage.costUsd ? formatCost(usage.costUsd) : theme.dim("unknown (no pricing configured for this model)")}`);
      if (runtime.model.pricing) {
        const { input, output } = runtime.model.pricing;
        print(theme.dim(`pricing     $${input}/M in · $${output}/M out`));
      }
      return { handled: true };
    }

    case "memory": {
      const memory = runtime.memory;
      if (!memory.entries.length) {
        print(theme.dim("No instruction files loaded. Create BLUEBIRD.md at the project root, or run /init."));
        return { handled: true };
      }
      print(`${theme.dim(`${memory.entries.length} file(s), ${formatBytes(memory.totalChars)}`)}`);
      for (const entry of memory.entries) {
        print(`  ${theme.accent(entry.scope.padEnd(9))} ${entry.label} ${theme.dim(`${entry.content.split("\n").length} lines`)}`);
      }
      return { handled: true };
    }

    case "tools": {
      const context = runtime.agent.toolContext({}, new AbortController().signal);
      const tools = runtime.registry.enabled(context);
      if (!args) {
        for (const tool of tools) {
          print(`  ${theme.accent(tool.name.padEnd(14))} ${theme.dim(tool.readOnly ? "read-only" : "writes")}  ${truncate(tool.description, 90)}`);
        }
        print(theme.dim(`\n  ${tools.length} tools enabled`));
        return { handled: true };
      }
      const tool = runtime.registry.get(args);
      if (!tool) {
        print(theme.error(`Unknown tool "${args}".`));
        return { handled: true };
      }
      print(`${theme.accent(tool.name)}${tool.readOnly ? theme.dim(" (read-only)") : ""}`);
      print(tool.description);
      print(theme.dim(`\nparameters: ${JSON.stringify(tool.parameters, null, 2).split("\n").slice(0, 24).join("\n")}`));
      return { handled: true };
    }

    case "agents": {
      for (const agent of runtime.agents) {
        print(`  ${theme.accent(agent.name.padEnd(10))} ${theme.dim(agent.source === "builtin" ? "builtin" : relativePath(runtime.config.root, agent.source))}`);
        print(`      ${truncate(agent.description, 100)}`);
      }
      return { handled: true };
    }

    case "skills": {
      if (!runtime.skills.length) {
        print(theme.dim("No skills installed. Add .bluebird/skills/<name>/SKILL.md"));
        return { handled: true };
      }
      for (const skill of runtime.skills) {
        print(`  ${theme.accent(skill.name.padEnd(16))} ${truncate(skill.description, 90)}`);
      }
      return { handled: true };
    }

    case "sessions": {
      const sessions = runtime.listSessions(15);
      if (!sessions.length) {
        print(theme.dim("No saved sessions for this project yet."));
        return { handled: true };
      }
      for (const entry of sessions) {
        const active = entry.id === runtime.session.id ? theme.accent("●") : theme.dim("○");
        print(
          `  ${active} ${entry.id} ${theme.dim(
            `${new Date(entry.updatedAt).toLocaleString()} · ${entry.messages} messages · ${entry.model}`,
          )}`,
        );
        if (entry.title) print(`      ${truncate(entry.title, 90)}`);
      }
      return { handled: true };
    }

    case "resume": {
      if (!args) {
        print(theme.error("Usage: /resume <session-id>"));
        return { handled: true };
      }
      await ctx.reload({ resumeId: args });
      return { handled: true };
    }

    case "new": {
      await ctx.reload({ fresh: true });
      return { handled: true };
    }

    case "clear": {
      runtime.session.replace([]);
      runtime.agent.resetTrackers();
      ctx.clearTranscript();
      print(theme.dim("Conversation cleared."));
      return { handled: true };
    }

    case "undo": {
      const checkpoints = runtime.checkpoints.list(5);
      const target = checkpoints[0];
      if (!target) {
        print(theme.dim("Nothing to undo in this session."));
        return { handled: true };
      }
      const result = await runtime.checkpoints.restore(target.id);
      print(`${theme.success("✓")} restored ${result.restored.length} file(s) from "${target.label}"`);
      for (const file of result.restored) print(`  ${theme.dim(relativePath(runtime.config.cwd, file))}`);
      if (result.missing.length) print(theme.warn(`  could not restore: ${result.missing.join(", ")}`));
      return { handled: true };
    }

    case "checkpoints": {
      const list = runtime.checkpoints.list(10);
      if (!list.length) {
        print(theme.dim("No checkpoints yet — they are created before each file modification."));
        return { handled: true };
      }
      for (const entry of list) {
        print(
          `  ${theme.accent(entry.id)} ${theme.dim(`${new Date(entry.ts).toLocaleTimeString()} · turn ${entry.turn} · ${entry.label}`)}`,
        );
        for (const file of entry.files.slice(0, 6)) {
          print(`      ${relativePath(runtime.config.cwd, file.path)} ${theme.dim(file.existed ? "modified" : "created")}`);
        }
      }
      return { handled: true };
    }

    case "diff": {
      const writes = [...runtime.agent.state.writes.values()];
      if (!writes.length) {
        print(theme.dim("No files changed in this session."));
        return { handled: true };
      }
      for (const entry of writes) {
        print(
          `  ${relativePath(runtime.config.cwd, entry.path)} ${theme.dim(`${entry.writes} write(s) · +${entry.addedLines} −${entry.removedLines}`)}`,
        );
      }
      return { handled: true };
    }

    case "status": {
      const stats = runtime.agent.stats();
      const info = runtime.session.info();
      print(`${theme.dim("model")}       ${runtime.model.label} ${theme.dim(`(${runtime.model.providerId} · ${runtime.model.api})`)}`);
      print(`${theme.dim("endpoint")}    ${runtime.model.baseURL}`);
      print(`${theme.dim("api key")}     ${runtime.model.apiKeySource === "none" ? theme.warn("not set") : runtime.model.apiKeySource}`);
      print(`${theme.dim("effort")}      ${runtime.agent.effortsBadge()}`);
      print(`${theme.dim("permission")}  ${runtime.permissions.preset}${runtime.agent.planMode ? theme.warn(" · plan mode") : ""}`);
      print(
        `${theme.dim("context")}     ${(stats.ratio * 100).toFixed(1)}% of ${formatCount(runtime.agent.contextWindow())}` +
          `${runtime.model.model.assumedWindow ? theme.dim(" (assumed window)") : ""}`,
      );
      const cache = formatCacheSummary(runtime.sessionUsage());
      print(`${theme.dim("caching")}     ${cache ?? theme.dim("automatic prefix caching")}`);
      print(`${theme.dim("vision")}      ${modelSupportsImages(runtime.model) ? "images supported" : theme.dim("text only")}`);
      print(`${theme.dim("session")}     ${runtime.session.id} ${theme.dim(`(${info.messages} messages, ${info.turns} turns)`)}`);
      print(`${theme.dim("cwd")}         ${runtime.config.cwd}`);
      print(`${theme.dim("config")}      ${runtime.config.sources.join(", ") || "(defaults)"}`);
      print(`${theme.dim("session dir")} ${runtime.paths.sessionDir}`);
      const files = runtime.memory.entries.length;
      print(`${theme.dim("instructions")} ${files} file(s) · ${runtime.skills.length} skills · ${runtime.agents.length} subagents`);
      return { handled: true };
    }

    case "export": {
      const target = args || path.join(runtime.config.cwd, `bluebird-session-${runtime.session.id}.md`);
      const content = exportTranscript(runtime.session.messages, runtime.session.info());
      writeFileSync(target, content);
      print(`${theme.success("✓")} wrote ${relativePath(runtime.config.cwd, path.resolve(target))} ${theme.dim(formatBytes(content.length))}`);
      return { handled: true };
    }

    case "config": {
      if (!args) {
        print(theme.dim(JSON.stringify(redactConfig(runtime.config.raw), null, 2)));
        return { handled: true };
      }
      print(theme.dim("Use `bluebird config set <key> <value>` from the shell to change settings."));
      return { handled: true };
    }

    case "verbose": {
      const current = runtime.config.raw.ui?.verboseToolOutput ?? false;
      runtime.config.raw.ui = { ...(runtime.config.raw.ui ?? ({} as never)), verboseToolOutput: !current };
      print(`${theme.success("✓")} verbose tool output ${!current ? "on" : "off"}`);
      return { handled: true };
    }

    case "init": {
      print(theme.dim("Run `bluebird init` in your shell to change the endpoint, model or key."));
      return { handled: true };
    }

    default: {
      const custom = runtime.commands.find((command) => command.name === name || command.name === rawName);
      if (custom) {
        const prompt = substituteArguments(custom.template, args);
        return { handled: true, prompt };
      }
      print(theme.error(`Unknown command /${rawName}. Try /help.`));
      return { handled: true };
    }
  }
}

export interface ModelEntry {
  label: string;
  provider: string;
  model: string;
}

export function availableModels(runtime: Runtime): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const [providerId, def] of Object.entries(runtime.config.raw.providers ?? {})) {
    for (const model of def.models ?? []) {
      entries.push({ label: `${providerId}/${model.id}`, provider: providerId, model: model.id });
    }
  }
  if (runtime.config.raw.endpoint && runtime.config.raw.model) {
    if (!entries.some((entry) => entry.model === runtime.config.raw.model)) {
      entries.unshift({ label: runtime.config.raw.model, provider: "default", model: runtime.config.raw.model });
    }
  }
  if (entries.length === 0 && runtime.model) {
    entries.push({ label: runtime.model.label, provider: runtime.model.providerId, model: runtime.model.model.id });
  }
  return entries;
}

export function sessionSummaryLine(runtime: Runtime): string {
  const info = runtime.session.info();
  const usage = runtime.sessionUsage();
  return `${info.id} · ${info.messages} messages · ${formatCount(usage.totalTokens ?? 0)} tokens · ${formatDuration(Date.now() - info.createdAt)}`;
}

export function configFileFor(runtime: Runtime): string {
  return runtime.config.configPath ?? path.join(runtime.config.root, ".bluebird", "config.json");
}

export function readConfigText(runtime: Runtime): string {
  const file = configFileFor(runtime);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function contextSummary(runtime: Runtime): string {
  const stats = analyzeContext({
    system: runtime.agent.systemPrompt(),
    messages: runtime.session.messages,
    contextWindow: runtime.model.contextWindow,
    reserveOutput: runtime.config.raw.context?.reserveOutputTokens ?? 16_000,
  });
  return `${(stats.ratio * 100).toFixed(0)}% of context used`;
}
