import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ToolError } from "../util/errors.ts";
import { containsPath, relativePath, resolveFrom } from "../util/paths.ts";
import { truncate } from "../util/text.ts";
import { optionalBoolean, optionalNumber, optionalString, requiredString } from "./args.ts";
import { defineTool, type ToolContext } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 200_000;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  child: ChildProcess;
  output: string;
  status: "running" | "exited" | "killed";
  exitCode?: number;
  /** Set when the task was stopped because it passed its timeout. */
  timedOut?: boolean;
  listeners: Set<(chunk: string) => void>;
}

export class BackgroundTasks {
  /** Finished tasks kept for polling before the oldest are evicted. */
  private static readonly MAX_TASKS = 50;
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  start(args: { command: string; cwd: string; env: NodeJS.ProcessEnv; shell?: string; timeoutMs?: number }): BackgroundTask {
    const id = `task_${randomBytes(4).toString("hex")}`;
    const child = spawn(args.command, {
      shell: true,
      cwd: args.cwd,
      env: args.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const task: BackgroundTask = {
      id,
      command: args.command,
      cwd: args.cwd,
      startedAt: Date.now(),
      child,
      output: "",
      status: "running",
      listeners: new Set(),
    };

    const append = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      task.output += text;
      if (task.output.length > MAX_OUTPUT_BYTES) {
        task.output = `…[earlier output trimmed]\n${task.output.slice(-MAX_OUTPUT_BYTES)}`;
      }
      for (const listener of task.listeners) listener(text);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code, signal) => {
      task.status = signal ? "killed" : "exited";
      task.exitCode = code ?? undefined;
      this.clearTimeout(id);
      this.evictFinished();
    });
    child.on("error", (error) => {
      task.status = "exited";
      append(Buffer.from(`\n[process error] ${error.message}\n`));
      this.clearTimeout(id);
    });

    // A background command is not immortal: without this, `timeout_ms` was
    // silently ignored and a stuck server outlived the session.
    if (args.timeoutMs && args.timeoutMs > 0) {
      const timer = setTimeout(() => {
        task.timedOut = true;
        append(Buffer.from(`\n[exceeded its ${Math.round(args.timeoutMs! / 1000)}s timeout and was killed]\n`));
        this.kill(id);
      }, args.timeoutMs);
      timer.unref?.();
      this.timeouts.set(id, timer);
    }

    this.tasks.set(id, task);
    this.evictFinished();
    return task;
  }

  private clearTimeout(id: string): void {
    const timer = this.timeouts.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(id);
    }
  }

  /** Drops the oldest finished tasks so a long session cannot grow the map forever. */
  private evictFinished(): void {
    if (this.tasks.size <= BackgroundTasks.MAX_TASKS) return;
    const finished = [...this.tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    while (this.tasks.size > BackgroundTasks.MAX_TASKS && finished.length) {
      const victim = finished.shift()!;
      this.tasks.delete(victim.id);
    }
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  kill(id: string): boolean {
    const task = this.tasks.get(id);
    this.clearTimeout(id);
    if (!task || task.status !== "running") return false;
    try {
      if (process.platform !== "win32" && task.child.pid) {
        process.kill(-task.child.pid, "SIGTERM");
      } else {
        task.child.kill("SIGTERM");
      }
      task.status = "killed";
      return true;
    } catch {
      try {
        task.child.kill("SIGKILL");
        task.status = "killed";
        return true;
      } catch {
        return false;
      }
    }
  }

  killAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") this.kill(task.id);
    }
    for (const id of [...this.timeouts.keys()]) this.clearTimeout(id);
  }
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
}

export interface RunOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes?: number;
  signal: AbortSignal;
  onChunk?: (text: string) => void;
  stdin?: string;
}

export function runCommand(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let killed = false;

    const child = spawn(options.command, {
      shell: true,
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const capture = (target: "out" | "err") => (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      if (target === "out") {
        stdout += text;
        if (stdout.length > maxBytes) {
          truncated = true;
          stdout = stdout.slice(-maxBytes);
        }
      } else {
        stderr += text;
        if (stderr.length > maxBytes) {
          truncated = true;
          stderr = stderr.slice(-maxBytes);
        }
      }
      options.onChunk?.(text);
    };

    child.stdout?.on("data", capture("out"));
    child.stderr?.on("data", capture("err"));

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    const onAbort = () => {
      killed = true;
      killTree(child);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      reject(new ToolError(`Failed to start command: ${error.message}`, { hint: "Check that the binary exists and is executable." }));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: truncated ? `${stdout}\n…[output truncated at ${maxBytes} characters]` : stdout,
        stderr,
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        killed,
      });
    });
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function shellEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(extra ?? {}),
    BLUEBIRD: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    EDITOR: "true",
    VISUAL: "true",
    npm_config_yes: "true",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "",
  };
}

const EXIT_CODE_NOTES: Record<string, string> = {
  grep: "exit 1 means no lines matched",
  rg: "exit 1 means no matches",
  diff: "exit 1 means the files differ",
  cmp: "exit 1 means the files differ",
  test: "exit 1 means the condition was false",
  find: "a non-zero exit code usually means a permission error",
};

export const bashTool = defineTool({
  name: "bash",
  label: "Bash",
  description:
    "Run a shell command in the workspace. Non-interactive, with a timeout and captured output. Set run_in_background for servers, watchers and anything that does not exit; then poll it with bash_output and stop it with kill_shell.",
  tags: ["exec"],
  risk: "high",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      description: { type: "string", description: "Short description of what the command does, shown to the user." },
      cwd: { type: "string", description: "Directory to run in. Defaults to the workspace root." },
      timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
      run_in_background: { type: "boolean", description: "Start the command in the background and return a task id." },
    },
    required: ["command"],
  },
  describe(args) {
    const command = optionalString(args, "command") ?? "?";
    return truncate(command.replace(/\s+/g, " "), 76);
  },
  async prepare(args, ctx) {
    const command = requiredString(args, ["command", "cmd", "script"], "bash");
    const cwd = resolveFrom(ctx.cwd, optionalString(args, "cwd", "directory") ?? ctx.cwd);
    const allowed = [ctx.root, ctx.cwd, ...(ctx.config.raw.permissions?.additionalDirectories ?? []).map((dir) => resolveFrom(ctx.cwd, dir))];
    if (!allowed.some((base) => containsPath(base, cwd))) {
      throw new ToolError(`Refusing to run in ${cwd}: outside the workspace`, {
        hint: "Run from inside the workspace, or add the directory to permissions.additionalDirectories.",
      });
    }
    const timeout = Math.max(1000, Math.min(optionalNumber(args, "timeout_ms", "timeout") ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    return {
      ...args,
      command,
      cwd,
      timeout_ms: timeout,
      run_in_background: optionalBoolean(args, "run_in_background", "background") ?? false,
    };
  },
  async execute(args, ctx) {
    const command = args.command as string;
    const cwd = args.cwd as string;
    const timeoutMs = args.timeout_ms as number;
    const background = Boolean(args.run_in_background);

    if (background) {
      const tasks = backgroundTasksFor(ctx);
      const task = tasks.start({ command, cwd, env: shellEnv(), timeoutMs });
      const display = relativePath(ctx.cwd, cwd) || ".";
      return {
        content: `Started in the background as ${task.id} (cwd ${display}, timeout ${Math.round(timeoutMs / 1000)}s).\nRead output with bash_output({ task_id: "${task.id}" }), stop it with kill_shell({ task_id: "${task.id}" }).`,
        summary: `background · ${task.id}`,
        display: { kind: "text", title: command, text: `running in background (${task.id})` },
        meta: { volatile: true },
      };
    }

    const result = await runCommand({
      command,
      cwd,
      env: shellEnv(),
      timeoutMs,
      signal: ctx.signal,
      onChunk: (text) => ctx.ui.progress(ctx.turnId, text.trim().split("\n").slice(-1)[0] ?? ""),
    });

    const sections: string[] = [];
    if (result.stdout.trim()) sections.push(result.stdout.trimEnd());
    if (result.stderr.trim()) sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.timedOut) {
      sections.push(`[command exceeded its ${Math.round(timeoutMs / 1000)}s timeout and was killed]`);
    }
    if (result.exitCode !== 0 && !result.stdout && !result.stderr) {
      const base = path.basename(command.trim().split(/\s+/)[0] ?? "");
      const note = EXIT_CODE_NOTES[base];
      sections.push(`[exit code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}${note ? ` — ${note}` : ""}]`);
    } else if (result.exitCode !== 0) {
      sections.push(`[exit code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}]`);
    }

    const body = sections.join("\n\n") || "(no output)";
    const isError = result.exitCode !== 0 && !result.timedOut;
    const summaryBits = [`exit ${result.exitCode ?? "?"}`];
    if (result.timedOut) summaryBits.push("timeout");
    summaryBits.push(`${(result.durationMs / 1000).toFixed(1)}s`);

    return {
      content: body,
      isError: isError && Boolean(result.stderr.trim() || result.stdout.trim() === ""),
      summary: summaryBits.join(" · "),
      display: { kind: "text", title: command, text: body.slice(0, 4000), collapseAfter: 18 },
      meta: {
        exitCode: result.exitCode ?? undefined,
        durationMs: result.durationMs,
        volatile: true,
        ...(result.timedOut ? { truncated: true } : {}),
      },
    };
  },
});

export const bashOutputTool = defineTool({
  name: "bash_output",
  label: "BashOutput",
  description:
    "Read the output of a background command started with bash. Use wait_ms to block until more output arrives or the process exits.",
  tags: ["exec"],
  readOnly: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id returned by bash with run_in_background." },
      wait_ms: { type: "number", description: "Wait up to this long for new output (default 0)." },
      tail: { type: "number", description: "Only return the last N lines." },
    },
    required: ["task_id"],
  },
  describe(args) {
    return optionalString(args, "task_id") ?? "?";
  },
  async execute(args, ctx) {
    const id = requiredString(args, ["task_id", "id"], "bash_output");
    const tasks = backgroundTasksFor(ctx);
    const task = tasks.get(id);
    if (!task) {
      throw new ToolError(`No background task ${id}`, {
        hint: "List running tasks with `bash` (each background start prints its id) or start a new one.",
      });
    }

    const waitMs = Math.max(0, Math.min(optionalNumber(args, "wait_ms", "wait") ?? 0, 300_000));
    if (waitMs > 0 && task.status === "running") {
      await new Promise<void>((resolve) => {
        // Both handlers are torn down on either path: leaving the `exit`
        // listener attached made repeated polls accumulate emitters.
        const cleanup = () => {
          clearTimeout(timer);
          task.listeners.delete(listener);
          task.child.removeListener("exit", listener);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, waitMs);
        const listener = () => {
          cleanup();
          resolve();
        };
        task.listeners.add(listener);
        task.child.once("exit", listener);
      });
    }

    const tailCount = optionalNumber(args, "tail");
    let output = task.output;
    if (tailCount && tailCount > 0) {
      output = output.split("\n").slice(-tailCount).join("\n");
    }

    const header = `${task.id} · ${task.status}${task.exitCode !== undefined ? ` (exit ${task.exitCode})` : ""} · ${(
      (Date.now() - task.startedAt) /
      1000
    ).toFixed(1)}s`;
    return {
      content: `${header}\n\n${output.trim() || "(no output yet)"}`,
      summary: task.status,
      display: { kind: "text", title: task.command, text: output.trim().slice(0, 4000), collapseAfter: 18 },
      meta: { volatile: true, ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}) },
    };
  },
});

export const killShellTool = defineTool({
  name: "kill_shell",
  label: "KillShell",
  description: "Stop a background command started with bash run_in_background. Omit task_id to stop every background task.",
  tags: ["exec"],
  risk: "medium",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task to stop. Omit to stop all background tasks." },
    },
  },
  describe(args) {
    return optionalString(args, "task_id") ?? "all background tasks";
  },
  async execute(args, ctx) {
    const tasks = backgroundTasksFor(ctx);
    const id = optionalString(args, "task_id", "id");
    if (!id) {
      const running = tasks.list().filter((task) => task.status === "running");
      tasks.killAll();
      return { content: `Stopped ${running.length} background task(s).`, summary: `${running.length} stopped` };
    }
    const ok = tasks.kill(id);
    return {
      content: ok ? `Stopped ${id}.` : `Task ${id} is not running.`,
      isError: !ok,
      summary: ok ? "stopped" : "not running",
    };
  },
});

function backgroundTasksFor(ctx: ToolContext): BackgroundTasks {
  return ctx.background;
}
