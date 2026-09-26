import { spawn } from "node:child_process";
import type { HookApi, HookEvent, HookOutcome, HookPayload, Logger } from "./contracts.ts";
import type { HookConfig } from "../config/schema.ts";

export interface HookRunnerOptions {
  hooks: HookConfig[];
  cwd: string;
  logger: Logger;
  /** Extra environment values exposed to hooks. */
  env?: Record<string, string>;
}

/**
 * Runs user-configured shell hooks around the agent lifecycle. Hooks receive a
 * JSON payload on stdin and may print JSON on stdout to influence the run:
 *   { "blocked": true, "reason": "..." }  veto the action
 *   { "context": "..." }                  inject text into the tool result
 */
export class HookRunner implements HookApi {
  private readonly options: HookRunnerOptions;

  constructor(options: HookRunnerOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.hooks.length > 0;
  }

  async run(event: HookEvent, payload: HookPayload, signal: AbortSignal): Promise<HookOutcome[]> {
    const matching = this.options.hooks.filter((hook) => hook.event === event && matches(hook.matcher, payload));
    if (matching.length === 0) return [];

    const outcomes: HookOutcome[] = [];
    for (const hook of matching) {
      try {
        const result = await this.execute(hook, payload, signal);
        if (result.outcome) outcomes.push(result.outcome);
      } catch (error) {
        this.options.logger.warn(`Hook failed for ${event}: ${(error as Error).message}`);
        outcomes.push({ reason: `hook error: ${(error as Error).message}` });
      }
    }
    return outcomes;
  }

  private async execute(
    hook: HookConfig,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<{ outcome?: HookOutcome }> {
    const timeoutMs = hook.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const child = spawn(hook.command, {
        shell: true,
        cwd: hook.cwd ?? this.options.cwd,
        env: {
          ...process.env,
          ...(this.options.env ?? {}),
          BLUEBIRD_HOOK_EVENT: payload.event,
          BLUEBIRD_SESSION_ID: payload.sessionId,
          BLUEBIRD_CWD: this.options.cwd,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`hook timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 1_000_000) stdout = stdout.slice(0, 1_000_000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 100_000) stderr = stderr.slice(0, 100_000);
      });
      // A hook that never reads its payload (anything as simple as `echo`)
      // closes stdin first; without these handlers the resulting EPIPE surfaces
      // as an uncaught exception and takes the whole CLI down.
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
      const stdin = child.stdin;
      stdin?.on("error", () => {});

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (stderr.trim()) this.options.logger.debug(`hook stderr: ${stderr.trim().slice(0, 500)}`);
        const parsed = parseHookOutput(stdout);
        if (parsed) {
          resolve({
            outcome: {
              ...(parsed.blocked ? { blocked: true } : {}),
              ...(parsed.reason ? { reason: parsed.reason } : {}),
              ...(parsed.context ? { output: parsed.context } : {}),
            },
          });
          return;
        }
        if (stdout.trim()) resolve({ outcome: { output: stdout.trim() } });
        else if (code !== 0) resolve({ outcome: { reason: `hook exited with code ${code}` } });
        else resolve({});
      });

      try {
        stdin?.end(JSON.stringify(payload));
      } catch {
        // stdin already closed
      }
    });
  }
}

function matches(matcher: string | undefined, payload: HookPayload): boolean {
  if (!matcher) return true;
  let pattern: RegExp;
  try {
    pattern = new RegExp(matcher);
  } catch {
    return false;
  }
  switch (payload.event) {
    case "tool.before":
    case "tool.after":
      return pattern.test(payload.tool ?? "");
    case "prompt.submit":
      return pattern.test(payload.text ?? "");
    case "turn.end":
      return pattern.test(payload.model ?? "");
    case "compact.before":
    case "notification":
      return pattern.test(payload.text ?? "");
    default:
      // session.start / session.end carry nothing to match against; the config
      // validator warns when a matcher is set on one of those.
      return true;
  }
}

export function parseHookOutput(stdout: string): { blocked?: boolean; reason?: string; context?: string } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      ...(value.blocked === true ? { blocked: true } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.context === "string"
        ? { context: value.context }
        : typeof value.output === "string"
          ? { context: value.output }
          : {}),
    };
  } catch {
    return undefined;
  }
}

export const noopHookRunner: HookApi = {
  async run() {
    return [];
  },
};
