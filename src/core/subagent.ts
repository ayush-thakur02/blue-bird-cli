import type { AgentDefinition, CheckpointApi, HookApi, Logger, PermissionApi, SubagentApi, SubagentRequest, SubagentResult, UiSink } from "./contracts.ts";
import type { ResolvedConfig, ResolvedModel } from "../config/schema.ts";
import type { Provider } from "../providers/types.ts";
import { Agent, type AgentUi } from "./agent.ts";
import { Session } from "./session.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { defaultWorkspaceState, emptyUsage } from "./contracts.ts";
import { resolveModel } from "../config/load.ts";
import { AbortError, ProviderError, ToolError } from "../util/errors.ts";
import { shortId } from "../util/ids.ts";

export interface SubagentRunnerOptions {
  config: ResolvedConfig;
  registry: ToolRegistry;
  providers: { get(model: ResolvedModel): Provider };
  model: ResolvedModel;
  /** Models to fail over to when the primary provider errors. */
  fallbacks?: ResolvedModel[];
  permissions: PermissionApi;
  hooks: HookApi;
  checkpoints: CheckpointApi;
  sink: UiSink;
  logger: Logger;
  agents: AgentDefinition[];
  sessionDir: string;
  parentSessionId: string;
  onEvent?: (event: { type: "start" | "done" | "error"; description: string; detail?: string }) => void;
  maxConcurrent?: number;
}

/**
 * Runs `task` tool requests as isolated agents: their own transcript, their own
 * tool budget, and only a final report returned to the parent context.
 */
export class SubagentRunner implements SubagentApi {
  private active = 0;
  private readonly queue: { run(): void }[] = [];
  private readonly options: SubagentRunnerOptions;

  constructor(options: SubagentRunnerOptions) {
    this.options = options;
  }

  list(): AgentDefinition[] {
    return this.options.agents;
  }

  get running(): number {
    return this.active;
  }

  async run(request: SubagentRequest, signal: AbortSignal): Promise<SubagentResult> {
    await this.acquire(signal);
    try {
      return await this.execute(request, signal);
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    const limit = Math.max(1, this.options.maxConcurrent ?? 4);
    if (this.active < limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        run: () => {
          signal.removeEventListener("abort", onAbort);
          this.active += 1;
          resolve();
        },
      };
      const onAbort = () => {
        // Drop the waiter before rejecting. Leaving it queued would let a later
        // release() consume the slot for a task that never runs, permanently
        // shrinking the pool until subagents deadlock.
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new AbortError("Subagent cancelled while queued"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next.run();
  }

  private async execute(request: SubagentRequest, signal: AbortSignal): Promise<SubagentResult> {
    const definition = request.agent ? this.options.agents.find((agent) => agent.name === request.agent) : undefined;
    const model = this.resolveModel(request.model ?? definition?.model);
    const provider = this.options.providers.get(model);
    const readOnly = request.readOnly ?? definition?.readOnly ?? false;

    const toolFilter = request.tools ?? definition?.tools;
    if (toolFilter) {
      // A typo here used to silently strip the subagent down to nothing.
      const known = new Set(this.options.registry.all().map((tool) => tool.name));
      const unknown = toolFilter.filter((name) => !known.has(name));
      if (unknown.length) {
        throw new ToolError(`Unknown tool(s) requested for this subagent: ${unknown.join(", ")}`, {
          hint: `Available tools: ${[...known].sort().join(", ")}`,
        });
      }
    }
    const registry = new ToolRegistry(
      this.options.registry.all().filter((tool) => {
        if (toolFilter && !toolFilter.includes(tool.name)) return false;
        if (readOnly && !tool.readOnly) return false;
        if (tool.name === "task") return false;
        return true;
      }),
    );

    const session = new Session({
      dir: this.options.sessionDir,
      root: this.options.config.root,
      cwd: this.options.config.cwd,
      model: model.model.id,
      provider: model.providerId,
      effort: "medium",
      id: `${this.options.parentSessionId}-sub-${shortId(5)}`,
      persist: false,
    });

    const childUi: AgentUi = {
      turnStart: (info) => this.options.onEvent?.({ type: "start", description: request.description, detail: `turn ${info.turn} · ${info.effort}` }),
      toolStart: () => {},
      toolEnd: () => {},
      notice: (text, tone) => {
        if (tone === "warn" || tone === "error") this.options.sink.notice(`[${request.description}] ${text}`, tone);
      },
      error: (error) => this.options.logger.debug(`subagent error: ${(error as Error).message}`),
    };

    const agent = new Agent({
      session,
      config: this.options.config,
      registry,
      provider,
      providers: this.options.providers,
      model,
      fallbacks: this.options.fallbacks ?? [],
      permissions: readOnlyPermissionShim(this.options.permissions, readOnly),
      hooks: this.options.hooks,
      checkpoints: this.options.checkpoints,
      state: defaultWorkspaceState(),
      ui: childUi,
      sink: this.options.sink,
      memory: { entries: [], missingImports: [], truncated: false, totalChars: 0 },
      agents: [],
      skills: [],
      logger: this.options.logger.child(`subagent:${request.description}`),
      planMode: readOnly,
      effort: "medium",
      effortAuto: true,
      maxTurns: request.maxTurns ?? this.options.config.raw.agent?.subagents?.maxTurns ?? 40,
      mode: "subagent",
      // Cancelling the parent must stop the child loop, not just its queue slot.
      abortSignal: signal,
      ...(definition?.prompt ? { rolePrompt: definition.prompt } : {}),
    });

    try {
      const result = await agent.submit(request.prompt);
      const text = lastAssistantText(agent) || result.text;
      this.options.onEvent?.({ type: "done", description: request.description, detail: `${result.turns} turns` });
      return {
        text,
        usage: result.usage ?? emptyUsage(),
        turns: result.turns,
        toolCalls: result.toolCalls,
        model: model.label,
        ...(result.aborted ? { aborted: true } : {}),
      };
    } catch (error) {
      this.options.onEvent?.({ type: "error", description: request.description, detail: (error as Error).message });
      throw error;
    }
  }

  private resolveModel(override?: string): ResolvedModel {
    if (!override) return this.options.model;
    try {
      return resolveModel(this.options.config.raw, { model: override, env: process.env }, []);
    } catch (error) {
      throw new ProviderError(`Could not resolve subagent model "${override}": ${(error as Error).message}`, { retryable: false });
    }
  }
}

function lastAssistantText(agent: Agent): string {
  for (let index = agent.session.messages.length - 1; index >= 0; index -= 1) {
    const message = agent.session.messages[index]!;
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

function readOnlyPermissionShim(inner: PermissionApi, readOnly: boolean): PermissionApi {
  if (!readOnly) return inner;
  return {
    preset: inner.preset,
    async check(request, signal) {
      if (request.readOnly) return inner.check(request, signal);
      return { allowed: false, via: "subagent:read-only", reason: "This subagent is read-only" };
    },
  };
}
