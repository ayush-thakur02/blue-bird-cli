import fs from "node:fs";
import path from "node:path";
import { Runtime } from "../runtime.ts";
import type { PromptApi } from "../core/contracts.ts";
import { createTheme } from "../ui/theme.ts";
import { Screen } from "../ui/screen.ts";
import { InputController } from "../ui/input.ts";
import { Renderer } from "../ui/renderer.ts";
import { renderBanner } from "../ui/banner.ts";
import { cursor as ansiCursor } from "../ui/ansi.ts";
import { registerTerminalRestore } from "../ui/terminal.ts";
import { handleSlashCommand } from "./slash.ts";
import { Session, readTranscript } from "../core/session.ts";
import { runCommand, stripAnsi } from "../tools/shell.ts";
import { AbortError, ConfigError, errorMessage, isAbortError } from "../util/errors.ts";
import { isInside, relativePath, resolveFrom } from "../util/paths.ts";
import { formatBytes } from "../util/text.ts";
import { isImagePath, loadImage } from "../util/images.ts";
import { shouldAttachImages } from "../core/vision.ts";
import type { ImageAttachment } from "../core/messages.ts";
import { BLUEBIRD_MEMORY_FILENAME } from "../core/memory.ts";
import { runInit } from "./init.ts";
import type { ParsedArgs } from "../cli/args.ts";
import { flagBool, flagString } from "../cli/args.ts";
import type { LoadConfigOverrides } from "../config/load.ts";

const MAX_MENTION_BYTES = 200_000;

export interface ChatOptions {
  cwd: string;
  args: ParsedArgs;
  initialPrompt?: string;
  resumeId?: string;
  planMode?: boolean;
}

export function collectOverrides(args: ParsedArgs): LoadConfigOverrides {
  const model = flagString(args, "model");
  const provider = flagString(args, "provider");
  const effort = flagString(args, "effort");
  const permissions = flagString(args, "permission");
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(effort ? { effort } : {}),
    ...(permissions ? { permissions } : {}),
  };
}

export async function runChat(options: ChatOptions): Promise<number> {
  const session = await ChatSession.create(options);
  return session.start();
}

class ChatSession {
  private readonly options: ChatOptions;
  private readonly theme;
  private readonly screen: Screen;
  private runtime: Runtime;
  private readonly renderer: Renderer;
  private readonly input: InputController;
  private readonly queue: string[] = [];
  private processing = false;
  private exiting = false;
  private resolveExit?: (code: number) => void;
  private unregisterRestore?: () => void;

  private constructor(runtime: Runtime, options: ChatOptions) {
    this.runtime = runtime;
    this.options = options;
    this.theme = createTheme(runtime.config.raw.ui?.theme ?? "auto");
    this.screen = new Screen({ out: process.stdout, theme: this.theme });

    this.renderer = new Renderer({
      screen: this.screen,
      theme: this.theme,
      config: runtime.config,
      ui: runtime.config.raw.ui!,
      // Read from the agent, not the configured model: after a provider failover
      // the status line has to name the model actually being used.
      modelLabel: () => this.runtime.agent.model.model.id,
      effortLabel: () => this.runtime.agent.effortsBadge(),
      permissionLabel: () => (this.runtime.permissions.preset === "ask" ? "" : this.runtime.permissions.preset),
      contextStats: () => this.runtime.agent.stats(),
      sessionUsage: () => this.runtime.sessionUsage(),
      gitBranch: () => this.runtime.git.branch,
      planMode: () => this.runtime.agent.planMode,
    });

    this.input = new InputController({
      stdin: process.stdin,
      screen: this.screen,
      theme: this.theme,
      isBusy: () => this.processing,
      busyEnter: runtime.config.raw.ui?.busyEnter ?? "queue",
      history: loadHistory(),
      onHistory: (entry) => saveHistory(entry),
      statusLine: () => this.renderer.statusLine(),
      complete: (line, cursor) => this.complete(line, cursor),
      onSubmit: (text) => {
        void this.submit(text);
      },
      onQueue: (text, count) => {
        this.queue.push(text);
        this.input.showQueued(count);
      },
      onInterrupt: () => {
        if (!this.processing) return;
        this.runtime.agent.abort("interrupted");
        this.screen.clearActivity();
        this.screen.line(this.theme.dim("  interrupting…"));
      },
      onExit: () => this.finish(0),
    });

    this.renderer.setInput(this.input);
  }

  static async create(options: ChatOptions): Promise<ChatSession> {
    const runtime = await openRuntime(options);
    return new ChatSession(runtime, options);
  }

  async start(): Promise<number> {
    const { runtime, screen, theme, renderer, input } = this;

    runtime.attachUi({
      agentUi: renderer,
      sink: renderer,
      promptApi: renderer as unknown as PromptApi,
    });

    process.on("SIGTERM", () => this.finish(0));
    process.on("SIGHUP", () => this.finish(0));
    // An external SIGINT (kill -INT, or Ctrl+C outside raw mode) must exit the
    // session cleanly rather than skip teardown.
    process.on("SIGINT", () => this.finish(130));

    for (const line of renderBanner({
      theme,
      width: screen.width,
      model: runtime.model.model.id,
      effort: runtime.agent.effortsBadge(),
      provider: runtime.model.providerId,
      endpoint: runtime.model.baseURL,
      cwd: runtime.config.cwd,
      permission: runtime.permissions.preset,
      sessionId: runtime.session.id,
      tools: runtime.registry.all().length,
      agents: runtime.agents.length,
      skills: runtime.skills.length,
      memoryFiles: runtime.memory.entries.length,
      planMode: runtime.agent.planMode,
      resumed: Boolean(this.options.resumeId),
      ...(runtime.git.branch ? { gitBranch: runtime.git.branch } : {}),
      warnings: runtime.config.warnings,
    })) {
      screen.line(line);
    }

    if (runtime.model.apiKeySource === "none" && runtime.model.api !== "mock") {
      screen.line(
        `  ${theme.warn("!")} no API key resolved for ${theme.accent(runtime.model.providerId)} — set the environment variable named in .bluebird/config.json, or run \`bluebird init\`.`,
      );
      screen.blank();
    }

    if (runtime.session.messages.length) {
      screen.line(theme.dim(`  resumed ${runtime.session.messages.length} messages from ${runtime.session.id}`));
      screen.blank();
    }

    const exitPromise = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });

    // Only meaningful on a TTY, and always undone by the restore hook.
    this.unregisterRestore = registerTerminalRestore(() => {
      if (process.stdout.isTTY) process.stdout.write(ansiCursor.show());
    });
    if (process.stdout.isTTY) process.stdout.write(ansiCursor.hide());
    input.start();

    if (this.options.initialPrompt) {
      await this.enqueue(this.options.initialPrompt);
    }

    if (!process.stdin.isTTY) {
      const piped = await readPipedInput();
      if (piped.trim()) await this.enqueue(piped);
      await this.waitIdle();
      this.finish(0);
    }

    const code = await exitPromise;
    this.cleanup(code);
    return code;
  }

  private async submit(text: string): Promise<void> {
    if (this.exiting) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      await this.handleSlash(trimmed);
      this.drainQueue();
      return;
    }
    await this.enqueue(trimmed);
  }

  private async enqueue(text: string): Promise<void> {
    this.queue.push(text);
    await this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    while (this.queue.length > 0 && !this.exiting) {
      const next = this.queue.shift()!;
      await this.runTurn(next);
      this.input.showQueued(this.queue.length);
    }
  }

  private async runTurn(raw: string): Promise<void> {
    this.processing = true;
    try {
      const runtime = this.runtime;
      const prepared = await preprocess(raw, runtime, this.screen, this.theme);
      if (!prepared.prompt.trim()) return;
      if (!runtime.session.info().title) runtime.session.setTitle(raw.split("\n")[0]!.slice(0, 100));
      await runtime.agent.submit(prepared.prompt, prepared.images.length ? { images: prepared.images } : {});
    } catch (error) {
      if (isAbortError(error) || error instanceof AbortError) {
        this.screen.line(this.theme.dim("  turn cancelled"));
      } else {
        this.renderer.error(error);
      }
    } finally {
      this.processing = false;
      this.runtime.session.flush(true);
      this.runtime.agent.resetTrackers();
    }
  }

  private async handleSlash(line: string): Promise<void> {
    this.processing = true;
    try {
      const result = await handleSlashCommand(line, {
        runtime: this.runtime,
        renderer: this.renderer,
        screen: this.screen,
        theme: this.theme,
        input: this.input,
        exit: () => this.finish(0),
        reload: async (opts) => {
          const session = await this.createSession(opts);
          this.runtime.changeSession(session);
          this.screen.line(this.theme.dim(`  switched to session ${session.id}`));
        },
        runPrompt: async (text) => {
          await this.runTurn(text);
        },
        clearTranscript: () => {
          if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
          else this.screen.line("");
        },
      });
      if (result.prompt) await this.runTurn(result.prompt);
    } catch (error) {
      this.renderer.error(error);
    } finally {
      this.processing = false;
    }
  }

  private async createSession(options: { resumeId?: string; fresh?: boolean }): Promise<Session> {
    const runtime = this.runtime;
    if (options.resumeId) {
      const found = runtime.listSessions(100).find((entry) => entry.id === options.resumeId);
      if (!found) throw new Error(`No session ${options.resumeId} in this project`);
      const session = new Session({
        dir: runtime.paths.sessionDir,
        root: runtime.config.root,
        cwd: runtime.config.cwd,
        model: found.model,
        provider: found.provider,
        effort: found.effort,
        id: found.id,
        globalIndex: runtime.paths.globalIndex,
      });
      session.messages = readTranscript(path.join(runtime.paths.sessionDir, `${found.id}.messages.jsonl`));
      return session;
    }
    return new Session({
      dir: runtime.paths.sessionDir,
      root: runtime.config.root,
      cwd: runtime.config.cwd,
      model: runtime.model.model.id,
      provider: runtime.model.providerId,
      effort: runtime.config.effort,
      globalIndex: runtime.paths.globalIndex,
    });
  }

  private complete(line: string, cursor: number): { items: string[]; start: number; prefix: string } | undefined {
    const before = line.slice(0, cursor);
    const runtime = this.runtime;

    if (before.startsWith("/") && !before.includes(" ")) {
      const names = [
        "help", "model", "provider", "effort", "permissions", "plan", "compact", "context", "cost",
        "init", "memory", "tools", "agents", "skills", "sessions", "resume", "new", "clear", "undo",
        "checkpoints", "diff", "status", "export", "verbose", "quit",
        ...runtime.commands.map((command) => command.name),
      ];
      const prefix = before.slice(1);
      const items = names.filter((name) => name.startsWith(prefix)).map((name) => `/${name}`);
      return items.length ? { items, start: 0, prefix: before } : undefined;
    }

    const match = /(?:^|\s)(@[\w./-]*)$/.exec(before);
    if (match?.[1]) {
      const prefix = match[1].slice(1);
      const start = before.length - match[1].length;
      const directory = prefix.includes("/") ? path.dirname(prefix) : ".";
      const base = path.join(runtime.config.cwd, directory);
      let items: string[] = [];
      try {
        items = fs
          .readdirSync(base, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith(path.basename(prefix)))
          .slice(0, 20)
          .map((entry) => `@${path.posix.join(directory === "." ? "" : directory, entry.name)}${entry.isDirectory() ? "/" : ""}`);
      } catch {
        items = [];
      }
      return items.length ? { items, start, prefix: match[1] } : undefined;
    }

    return undefined;
  }

  private async waitIdle(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private finish(code: number): void {
    if (this.exiting) return;
    this.exiting = true;
    this.resolveExit?.(code);
  }

  private cleanup(code: number): void {
    this.unregisterRestore?.();
    this.unregisterRestore = undefined;
    try {
      this.input.stop();
    } catch {
      // terminal may already be gone
    }
    if (process.stdout.isTTY) process.stdout.write(ansiCursor.show());
    this.renderer.shutdown();
    this.runtime.dispose();
    if (code === 0) {
      this.screen.line("");
      this.screen.line(
        this.theme.dim(
          `  session ${this.runtime.session.id} · resume with \`bluebird resume ${this.runtime.session.id}\``,
        ),
      );
      this.screen.line("");
    }
  }
}

async function openRuntime(options: ChatOptions): Promise<Runtime> {
  const create = async (): Promise<Runtime> =>
    Runtime.create({
      cwd: options.cwd,
      overrides: collectOverrides(options.args),
      ...(flagString(options.args, "config") ? { configPath: flagString(options.args, "config")! } : {}),
      ...(options.resumeId ? { resumeId: options.resumeId } : {}),
      ...(options.planMode ? { planMode: true } : {}),
      ...(flagBool(options.args, "no-memory") ? { disableMemory: true } : {}),
      ...(flagBool(options.args, "no-subagents") ? { disableSubagents: true } : {}),
      logFile: path.join(runtimeHome(), "logs", "bluebird.log"),
    });

  try {
    return await create();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stdout.write(`\n  ${error.message}\n`);
    if (error.hint) process.stdout.write(`  ${error.hint.split("\n").join("\n  ")}\n`);
    if (!(process.stdin.isTTY && process.stdout.isTTY)) return Promise.reject(error);
    process.stdout.write("\n");
    await runInit({ cwd: options.cwd });
    return create();
  }
}

export interface PreparedInput {
  prompt: string;
  images: ImageAttachment[];
}

async function preprocess(raw: string, runtime: Runtime, screen: Screen, theme: ReturnType<typeof createTheme>): Promise<PreparedInput> {
  if (raw.startsWith("!")) {
    const command = raw.slice(1).trim();
    screen.line(theme.dim(`  $ ${command}`));
    const result = await runCommand({
      command,
      cwd: runtime.config.cwd,
      timeoutMs: 120_000,
      signal: new AbortController().signal,
    });
    const output = stripAnsi(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`).trimEnd();
    for (const line of output.split("\n").slice(0, 60)) screen.line(`  ${theme.dim(line)}`);
    if (result.exitCode !== 0) screen.line(`  ${theme.dim(`exit ${result.exitCode}`)}`);
    return { prompt: "", images: [] };
  }

  if (raw.startsWith("#")) {
    const note = raw.slice(1).trim();
    if (!note) return { prompt: "", images: [] };
    const file = path.join(runtime.config.root, BLUEBIRD_MEMORY_FILENAME);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# ${path.basename(runtime.config.root)}\n`;
    const separator = existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(file, `${existing}${separator}\n- ${note}\n`);
    screen.line(`${theme.success("✓")} noted in ${relativePath(runtime.config.cwd, file)}`);
    runtime.agent.invalidateSystemPrompt();
    return { prompt: "", images: [] };
  }

  const { prompt, attachments, images, warnings } = await expandMentions(raw, runtime);
  for (const attachment of attachments) {
    screen.line(theme.dim(`  attached ${attachment.path} ${formatBytes(attachment.bytes)}`));
  }
  for (const warning of warnings) {
    screen.line(`${theme.warn("!")} ${theme.dim(warning)}`);
  }
  return { prompt, images };
}

export async function expandMentions(
  raw: string,
  runtime: Runtime,
): Promise<{ prompt: string; attachments: { path: string; bytes: number }[]; images: ImageAttachment[]; warnings: string[] }> {
  const mentions = [...raw.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1]!).filter(Boolean);
  const attachments: { path: string; bytes: number }[] = [];
  const images: ImageAttachment[] = [];
  const warnings: string[] = [];
  if (mentions.length === 0) return { prompt: raw, attachments, images, warnings };

  const blocks: string[] = [];
  let budget = MAX_MENTION_BYTES;
  for (const mention of mentions.slice(0, 20)) {
    const absolute = resolveFrom(runtime.config.cwd, mention);
    if (!isInside(runtime.config.root, absolute) && !isInside(runtime.config.cwd, absolute)) continue;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    if (isImagePath(absolute)) {
      if (runtime.config.raw.images?.enabled === false) {
        warnings.push(`${mention}: image input is disabled (images.enabled)`);
        continue;
      }
      if (!shouldAttachImages(runtime.model)) {
        warnings.push(`${mention}: ${runtime.model.model.id} is declared text-only, so the image was skipped`);
        continue;
      }
      try {
        const image = loadImage(absolute, {
          maxBytes: runtime.config.raw.images?.maxBytes,
          detail: runtime.config.raw.images?.detail,
          label: relativePath(runtime.config.cwd, absolute),
        });
        images.push(image);
        attachments.push({ path: relativePath(runtime.config.cwd, absolute), bytes: image.bytes });
      } catch (error) {
        warnings.push(`${mention}: ${(error as Error).message}`);
      }
      continue;
    }

    if (stats.size > budget) continue;
    const content = fs.readFileSync(absolute, "utf8");
    budget -= content.length;
    attachments.push({ path: relativePath(runtime.config.cwd, absolute), bytes: content.length });
    blocks.push(`<file path="${relativePath(runtime.config.cwd, absolute)}">\n${content}\n</file>`);
  }

  const parts = [raw];
  if (blocks.length) parts.push("", blocks.join("\n\n"));
  if (images.length) {
    parts.push(
      "",
      images.length === 1
        ? `[An image is attached: ${images[0]!.label}]`
        : `[${images.length} images are attached: ${images.map((image) => image.label).join(", ")}]`,
    );
  }
  return { prompt: parts.join("\n").trim(), attachments, images, warnings };
}

function historyFile(): string {
  return path.join(runtimeHome(), "history.json");
}

function loadHistory(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile(), "utf8")) as string[];
    return Array.isArray(parsed) ? parsed.slice(-500) : [];
  } catch {
    return [];
  }
}

function saveHistory(entry: string): void {
  try {
    const existing = fs.existsSync(historyFile()) ? (JSON.parse(fs.readFileSync(historyFile(), "utf8")) as string[]) : [];
    const next = [...existing.filter((line) => line !== entry), entry].slice(-500);
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify(next, null, 2));
  } catch {
    // history is a convenience; never fail the session over it
  }
}

function runtimeHome(): string {
  return process.env.BLUEBIRD_HOME ?? path.join(process.env.HOME ?? ".", ".bluebird");
}

async function readPipedInput(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export { errorMessage };
