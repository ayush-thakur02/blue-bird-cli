import type { BlueBirdConfig, Effort, ResolvedConfig, ResolvedModel } from "../config/schema.ts";
import type {
  AgentDefinition,
  HookApi,
  Logger,
  PermissionApi,
  SkillDefinition,
  SubagentApi,
  UiSink,
  Usage,
  WorkspaceState,
  CheckpointApi,
} from "./contracts.ts";
import type { ToolCallOutcome, ToolContext } from "../tools/types.ts";
import { formatToolName } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Provider } from "../providers/types.ts";
import {
  assistantMessage,
  messageText,

  toolResultMessage,
  userMessage,
  type ImageAttachment,
  type Message,
  type ToolCallBlock,
  type ToolResultBlock,
} from "./messages.ts";
import { Session } from "./session.ts";
import { analyzeContext, compactionPrompt, planCompaction, structuralSummary, transcriptForSummary, type ContextStats } from "./context.ts";
import { classifyEffort, onBadge } from "./effort.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { BackgroundTasks } from "../tools/shell.ts";
import { AbortError, BlueBirdError, ProviderError, errorMessage, isAbortError, isRetryable } from "../util/errors.ts";
import { backoffDelay, retryAfterMs, sleep } from "../providers/transport.ts";
import { cacheKeyFor, isContextOverflow } from "../providers/caching.ts";
import { formatCount } from "../util/text.ts";
import { newCheckpointId } from "./checkpoint.ts";
import type { MemoryDiscovery } from "./memory.ts";
import { shortId } from "../util/ids.ts";
import { addUsage, emptyUsage } from "./contracts.ts";

export interface AgentUi {
  turnStart?(info: { turn: number; model: string; effort: Effort; reason?: string }): void;
  textDelta?(delta: string): void;
  thinkingDelta?(delta: string): void;
  assistantMessage?(message: Message): void;
  toolStart?(info: { id: string; name: string; label: string; summary: string; args: Record<string, unknown> }): void;
  toolProgress?(id: string, text: string): void;
  toolEnd?(outcome: ToolCallOutcome): void;
  usage?(usage: Usage, stats: ContextStats): void;
  notice?(text: string, tone?: "default" | "dim" | "muted" | "info" | "accent" | "success" | "warn" | "error"): void;
  compaction?(info: { reason: string; folded: number; summary: string; tokensBefore: number; tokensAfter: number }): void;
  todos?(todos: { content: string; status: "pending" | "in_progress" | "completed" }[]): void;
  /** Progress from a `task` subagent, so a long delegation does not look stalled. */
  subagentEvent?(event: { description: string; status: "start" | "done" | "error"; detail?: string }): void;
  turnEnd?(info: { turn: number; stopReason: string; usage: Usage; toolCalls: number; elapsedMs: number }): void;
  retry?(info: { attempt: number; delayMs: number; reason: string; provider: string }): void;
  /** A partial response is being abandoned (retry or failover); mark it in the transcript. */
  discardOutput?(): void;
  error?(error: unknown): void;
}

export interface AgentOptions {
  session: Session;
  config: ResolvedConfig;
  registry: ToolRegistry;
  provider: Provider;
  providers: { get(model: ResolvedModel): Provider };
  model: ResolvedModel;
  fallbacks: ResolvedModel[];
  permissions: PermissionApi;
  hooks: HookApi;
  checkpoints: CheckpointApi;
  state: WorkspaceState;
  ui: AgentUi;
  sink: UiSink;
  memory: MemoryDiscovery;
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  logger: Logger;
  background?: BackgroundTasks;
  subagents?: SubagentApi;
  planMode?: boolean;
  effort?: Effort;
  effortAuto?: boolean;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /** Extra guidance appended to the system prompt (used by named subagents). */
  rolePrompt?: string;
  /** Prompt mode: interactive, headless or subagent. */
  mode?: "interactive" | "headless" | "subagent";
}

export interface TurnResult {
  text: string;
  thinking: string;
  toolCalls: number;
  usage: Usage;
  stopReason: string;
  turns: number;
  aborted: boolean;
}

const MAX_CONTINUATIONS = 3;
const MAX_PARALLEL_TOOLS = 6;
/** Upper bound on loop-guard bookkeeping so a long headless run stays flat. */
const MAX_TRACKER_ENTRIES = 512;

export class Agent {
  session: Session;
  config: ResolvedConfig;
  model: ResolvedModel;
  provider: Provider;
  planMode: boolean;
  effort: Effort;
  effortAuto: boolean;
  readonly registry: ToolRegistry;
  readonly memory: MemoryDiscovery;
  readonly agents: AgentDefinition[];
  readonly skills: SkillDefinition[];
  readonly background: BackgroundTasks;
  readonly state: WorkspaceState;

  private readonly options: AgentOptions;
  private readonly logger: Logger;
  private readonly fallbacks: ResolvedModel[];
  private systemPromptCache = "";
  private systemPromptDirty = true;
  private gitBranch?: string;
  private turnCounter = 0;
  private controller?: AbortController;
  private readonly repeatTracker = new Map<string, number>();
  private readonly failureTracker = new Map<string, number>();
  private compactionInFlight = false;
  /** Session-level window override, set when a provider rejects an oversized prompt. */
  private effectiveWindow?: number;
  private overflowRecoveries = 0;

  constructor(options: AgentOptions) {
    this.options = options;
    this.session = options.session;
    this.config = options.config;
    this.model = options.model;
    this.provider = options.provider;
    this.planMode = options.planMode ?? false;
    this.effort = options.effort ?? "medium";
    this.effortAuto = options.effortAuto ?? false;
    this.registry = options.registry;
    this.memory = options.memory;
    this.agents = options.agents;
    this.skills = options.skills;
    this.background = options.background ?? new BackgroundTasks();
    this.state = options.state;
    this.logger = options.logger;
    // Copied: the loop consumes fallbacks with `shift`, which must not mutate the
    // caller's configuration array.
    this.fallbacks = [...options.fallbacks];
  }

  get turnId(): string {
    return this.currentTurnId;
  }

  /** Wires the interactive UI into this agent (called once the renderer exists). */
  attach(args: { ui?: AgentUi; sink?: UiSink; subagents?: SubagentApi | undefined; session?: Session }): void {
    if (args.ui) this.options.ui = args.ui;
    if (args.sink) this.options.sink = args.sink;
    if (args.subagents !== undefined) this.options.subagents = args.subagents;
    if (args.session) {
      this.options.session = args.session;
      this.session = args.session;
    }
    this.invalidateSystemPrompt();
  }

  private currentTurnId = `turn-${shortId(6)}`;
  private lastStats?: ContextStats;

  invalidateSystemPrompt(): void {
    this.systemPromptDirty = true;
  }

  setGit(branch: string | undefined): void {
    this.gitBranch = branch;
    this.systemPromptDirty = true;
  }

  stats(): ContextStats {
    const system = this.systemPrompt();
    return analyzeContext({
      system,
      messages: this.session.messages,
      contextWindow: this.contextWindow(),
      reserveOutput: this.config.raw.context?.reserveOutputTokens ?? 16_000,
    });
  }

  /** Effective context window: the model's, unless an overflow lowered it. */
  contextWindow(): number {
    const configured = this.config.raw.context?.maxTokens ?? 0;
    if (this.effectiveWindow) return Math.min(this.effectiveWindow, configured || Number.POSITIVE_INFINITY);
    return configured || this.model.contextWindow;
  }

  /** Prompt-cache key shared by every request in this session. */
  get cacheKey(): string {
    return cacheKeyFor(this.session.id, this.model.model.id);
  }

  systemPrompt(): string {
    if (!this.systemPromptDirty && this.systemPromptCache) return this.systemPromptCache;
    const context = this.toolContext({}, new AbortController().signal);
    const tools = this.registry.enabled(context);
    let prompt = buildSystemPrompt({
      config: this.config,
      memory: this.memory,
      tools,
      agents: this.agents,
      skills: this.skills,
      planMode: this.planMode,
      ...(this.gitBranch ? { gitBranch: this.gitBranch } : {}),
      mode: this.options.mode ?? "interactive",
      parentSession: this.options.mode === "subagent" ? this.session.id : undefined,
    });
    if (this.options.rolePrompt) {
      prompt = `${prompt}\n\n# Your role\n${this.options.rolePrompt}`;
    }
    this.systemPromptCache = prompt;
    this.systemPromptDirty = false;
    return prompt;
  }

  toolContext(extra: { turnId?: string } = {}, signal: AbortSignal): ToolContext {
    const context: ToolContext = {
      cwd: this.config.cwd,
      root: this.config.root,
      config: this.config,
      sessionId: this.session.id,
      turnId: extra.turnId ?? this.currentTurnId,
      permissions: this.options.permissions,
      ui: this.options.sink,
      signal,
      state: this.state,
      checkpoints: this.options.checkpoints,
      hooks: this.options.hooks,
      logger: this.logger,
      skills: this.skills,
      background: this.background,
      ...(this.options.subagents ? { subagents: this.options.subagents } : {}),
      emit: (event) => {
        if (event.type === "todos") this.options.ui.todos?.(event.todos);
        if (event.type === "notice") this.options.ui.notice?.(event.text);
        if (event.type === "subagent") {
          this.options.ui.subagentEvent?.({
            description: event.description,
            status: event.status,
            ...(event.detail ? { detail: event.detail } : {}),
          });
        }
      },
    };
    return context;
  }

  abort(reason = "cancelled by user"): void {
    this.controller?.abort(new AbortError(reason));
  }

  /** Links an external cancellation source (a signal handler, a host app) to the loop. */
  setAbortSignal(signal: AbortSignal | undefined): void {
    this.options.abortSignal = signal;
  }

  handleInput(input: string): void {
    if (input === "escape") this.abort();
  }

  async submit(prompt: string, options: { display?: string; images?: ImageAttachment[] } = {}): Promise<TurnResult> {
    // `prompt.submit` hooks are the documented place to gate a request (for
    // example requiring approval before a "deploy" prompt), so they run before
    // anything is appended to the session.
    const gates = await this.options.hooks.run(
      "prompt.submit",
      { event: "prompt.submit", sessionId: this.session.id, cwd: this.config.cwd, text: prompt },
      this.options.abortSignal ?? new AbortController().signal,
    );
    const blocked = gates.find((outcome) => outcome.blocked);
    if (blocked) {
      throw new BlueBirdError("hook", `A prompt.submit hook blocked this request: ${blocked.reason ?? "no reason given"}`, {
        hint: "Adjust the hook in your config (hooks[].command) if this was unintended.",
      });
    }
    const injected = gates.map((outcome) => outcome.output).filter((value): value is string => Boolean(value));
    const finalPrompt = injected.length ? `${prompt}\n\n[hook context]\n${injected.join("\n")}` : prompt;

    const message = userMessage(finalPrompt);
    if (options.display && options.display !== prompt) {
      message.meta = { ...(message.meta ?? {}), synthetic: false };
    }
    if (options.images?.length) {
      for (const image of options.images) message.blocks.push({ type: "image", image });
    }
    this.session.append(message);
    return this.runLoop();
  }

  /** Re-runs the loop without appending a user message (used by retry/resume). */
  async resumeLoop(): Promise<TurnResult> {
    return this.runLoop();
  }

  private async runLoop(): Promise<TurnResult> {
    const controller = new AbortController();
    this.controller = controller;
    const external = this.options.abortSignal;
    if (external?.aborted) throw new AbortError();
    // `AbortSignal.any` forwards a caller-driven abort into the loop without
    // installing listeners that would have to be torn down on every turn.
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    const startedAt = Date.now();
    const totals = emptyUsage();
    let turns = 0;
    let toolCalls = 0;
    let stopReason = "end_turn";
    let lastText = "";
    let lastThinking = "";
    let continuations = 0;
    const maxTurns = this.options.maxTurns ?? this.config.raw.agent?.maxTurns ?? 120;
    const planStartTurns = this.planMode ? 1 : 0;

    try {
      while (turns < maxTurns) {
        if (signal.aborted) throw new AbortError();
        turns += 1;
        this.turnCounter += 1;
        this.currentTurnId = `turn-${shortId(6)}`;

        const decision = this.resolveEffort();
        this.options.ui.turnStart?.({ turn: turns, model: this.model.label, effort: decision.effort, ...(decision.reason ? { reason: decision.reason } : {}) });

        if (this.shouldCompact()) {
          await this.compact({ reason: "context limit" });
        }

        let turn: Awaited<ReturnType<Agent["streamTurn"]>>;
        try {
          turn = await this.streamTurn(signal, turns);
        } catch (error) {
          if (!(await this.recoverFromOverflow(error))) throw error;
          continue;
        }
        const accumulated = addUsage(totals, turn.usage);
        totals.inputTokens = accumulated.inputTokens;
        totals.outputTokens = accumulated.outputTokens;
        totals.totalTokens = accumulated.totalTokens;
        totals.costUsd = accumulated.costUsd;
        totals.cacheReadTokens = accumulated.cacheReadTokens;
        totals.cacheWriteTokens = accumulated.cacheWriteTokens;
        totals.reasoningTokens = accumulated.reasoningTokens;
        lastText = turn.text;
        lastThinking = turn.thinking;
        toolCalls += turn.toolCalls.length;
        stopReason = turn.stopReason;
        if (stopReason === "refusal") {
          // Ending silently here looks like a broken turn; say what happened.
          this.options.ui.notice?.("The model declined to continue this request (refusal).", "warn");
        }

        this.session.countTurn();
        this.session.addUsage(turn.usage);
        this.session.flush(true);

        if (this.planMode && turns > planStartTurns && turn.toolCalls.length === 0) {
          stopReason = "end_turn";
        }

        if (turn.toolCalls.length === 0) {
          if (stopReason === "max_tokens" && continuations < MAX_CONTINUATIONS && this.config.raw.agent?.autoContinueOnTruncation !== false) {
            continuations += 1;
            this.session.append(
              userMessage("Your previous reply hit the output limit. Continue exactly where you stopped — do not repeat what you already wrote.", {
                synthetic: true,
              }),
            );
            continue;
          }
          break;
        }

        const maxCallsPerTurn = this.config.raw.agent?.maxToolCallsPerTurn ?? 24;
        if (turn.toolCalls.length > maxCallsPerTurn) {
          this.options.ui.notice?.(
            `The model requested ${turn.toolCalls.length} tool calls in one turn; running the first ${maxCallsPerTurn} and deferring the rest.`,
            "warn",
          );
        }

        // Armed before the tools run so every mutation in this turn is captured,
        // and committed in `finally` so a failed turn cannot leak into `pending`.
        const turnId = this.currentTurnId;
        this.options.checkpoints.arm(turnId, summarizeToolCalls(turn.toolCalls), this.turnCounter);
        try {
          await this.executeTools(turn.toolCalls, signal, { maxCalls: maxCallsPerTurn });
        } finally {
          this.options.checkpoints.commit(turnId);
        }

        if (signal.aborted) throw new AbortError();

        this.systemPromptDirty = true;
      }
    } catch (error) {
      if (isAbortError(error) && !(error instanceof AbortError)) throw new AbortError();
      throw error;
    } finally {
      this.session.flush(true);
      this.options.ui.turnEnd?.({
        turn: turns,
        stopReason,
        usage: totals,
        toolCalls,
        elapsedMs: Date.now() - startedAt,
      });
      this.controller = undefined;
      try {
        await this.options.hooks.run(
          "turn.end",
          {
            event: "turn.end",
            sessionId: this.session.id,
            cwd: this.config.cwd,
            model: this.model.model.id,
            effort: this.effort,
            text: `${turns} turn(s), ${stopReason}, ${toolCalls} tool call(s)`,
          },
          new AbortController().signal,
        );
      } catch (error) {
        // A failing notification hook must not mask the turn's real outcome.
        this.logger.warn(`turn.end hook failed: ${errorMessage(error)}`);
      }
    }

    return {
      text: lastText,
      thinking: lastThinking,
      toolCalls,
      usage: totals,
      stopReason,
      turns,
      aborted: signal.aborted,
    };
  }

  /**
   * When a provider refuses the prompt because it exceeds the model's real
   * context window, shrink the effective window, compact hard, and let the loop
   * retry. This keeps a 1M-token assumption safe on models that cannot honour it.
   */
  private async recoverFromOverflow(error: unknown): Promise<boolean> {
    if (this.config.raw.context?.recoverFromOverflow === false) return false;
    if (this.overflowRecoveries >= 3) return false;
    const message = errorMessage(error);
    const status = error instanceof ProviderError ? error.status : undefined;
    if (!isContextOverflow(message, status)) return false;

    const current = this.contextWindow();
    const next = Math.max(32_000, Math.floor(current / 2));
    if (next >= current) return false;

    this.overflowRecoveries += 1;
    this.effectiveWindow = next;
    this.options.ui.notice?.(
      `The provider rejected the prompt as too long (${formatCount(current)} token window assumed). Retrying with ${formatCount(next)} and a harder compaction.`,
      "warn",
    );
    this.logger.warn(`Context overflow: shrinking window to ${next} tokens`, { error: message.slice(0, 300) });
    await this.compact({ reason: "provider context overflow", keepRecentTurns: 2 });
    return true;
  }

  private resolveEffort(): { effort: Effort; reason: string } {
    if (!this.effortAuto) return { effort: this.effort, reason: "set explicitly" };
    const lastUser = [...this.session.messages].reverse().find((message) => message.role === "user" && !message.meta?.synthetic);
    const text = lastUser ? messageText(lastUser) : "";
    const decision = classifyEffort({
      prompt: text,
      historyLength: this.session.messages.length,
      toolCount: this.registry.all().length,
      planMode: this.planMode,
      continuation: this.session.messages.some((message) => message.role === "tool"),
      repeatedFailures: [...this.failureTracker.values()].reduce((sum, value) => sum + value, 0),
      touchedFiles: this.state.touched.size,
    });
    this.effort = decision.effort;
    return decision;
  }

  private shouldCompact(): boolean {
    const stats = this.stats();
    this.lastStats = stats;
    const threshold = this.config.raw.context?.compactAt ?? 0.82;
    const mode = this.config.raw.context?.compaction ?? "auto";
    if (mode === "off") return false;
    return stats.ratio >= threshold && !this.compactionInFlight;
  }

  private async streamTurn(signal: AbortSignal, turn: number): Promise<{
    text: string;
    thinking: string;
    toolCalls: ToolCallBlock[];
    usage: Usage;
    stopReason: string;
  }> {
    const context = this.toolContext({}, signal);
    const toolsEnabled = this.planMode ? this.registry.enabled(context).filter((tool) => tool.readOnly || tool.name === "todo_write") : this.registry.enabled(context);
    const specs = toolsEnabled.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));

    const maxAttempts = Math.max(1, (this.config.raw.agent?.retries ?? 3) + 1);
    let attempt = 0;
    let model = this.model;
    let provider = this.provider;
    let attemptedOutput = false;

    while (true) {
      attempt += 1;
      attemptedOutput = false;
      try {
        const request = {
          sessionId: this.session.id,
          model,
          effort: this.effort,
          system: this.systemPrompt(),
          messages: this.session.messages,
          tools: specs,
          toolChoice: "auto" as const,
          ...(this.config.raw.agent?.temperature !== undefined ? { temperature: this.config.raw.agent.temperature } : {}),
          parallelToolCalls: this.config.raw.agent?.parallelToolCalls !== false,
          signal,
          logger: this.logger,
          cacheKey: this.cacheKey,
        };

        let text = "";
        let thinking = "";
        let thinkingSignature: string | undefined;
        const toolCalls: ToolCallBlock[] = [];
        let usage: Usage = emptyUsage();
        let stopReason = "end_turn";

        for await (const event of provider.stream(request)) {
          if (signal.aborted) throw new AbortError();
          switch (event.type) {
            case "start":
              break;
            case "text":
              text += event.delta;
              if (event.delta) attemptedOutput = true;
              this.options.ui.textDelta?.(event.delta);
              break;
            case "thinking":
              thinking += event.delta;
              if (event.delta) attemptedOutput = true;
              this.options.ui.thinkingDelta?.(event.delta);
              break;
            case "tool_call":
              toolCalls.push(event.call);
              break;
            case "usage":
              usage = event.usage;
              break;
            case "notice":
              this.options.ui.notice?.(event.text, "warn");
              break;
            case "done": {
              text = event.text || text;
              thinking = event.thinking || thinking;
              if (event.thinkingSignature) thinkingSignature = event.thinkingSignature;
              stopReason = event.stopReason;
              if (event.toolCalls.length) {
                toolCalls.length = 0;
                toolCalls.push(...event.toolCalls);
              }
              if (event.usage.inputTokens || event.usage.outputTokens) usage = event.usage;
              break;
            }
            case "error":
              throw new ProviderError(event.message, { retryable: event.retryable, provider: provider.id });
          }
        }

        const assistant = assistantMessage(
          [
            ...(thinking ? [{ type: "thinking" as const, text: thinking, ...(thinkingSignature ? { signature: thinkingSignature } : {}) }] : []),
            ...(text ? [{ type: "text" as const, text }] : []),
            ...toolCalls,
          ],
          {
            model: model.model.id,
            providerId: model.providerId,
            effort: this.effort,
            usage,
            elapsedMs: 0,
          },
        );
        this.session.append(assistant);
        this.options.ui.assistantMessage?.(assistant);
        if (this.lastStats) this.options.ui.usage?.(usage, this.stats());
        this.trackRepeats(toolCalls);

        return { text, thinking, toolCalls, usage, stopReason: stopReason === "tool_use" || toolCalls.length ? "tool_use" : stopReason };
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw new AbortError();

        const retryable = error instanceof ProviderError ? error.retryable : isRetryable(error);
        const hasFallback = this.fallbacks.length > 0;
        const retriesExhausted = attempt >= maxAttempts;
        // Retry a transient failure first; switch provider once retrying here is
        // pointless — either the attempts are used up or the error is not one
        // that another attempt could fix.
        const shouldFailover = hasFallback && isFailoverWorthy(error) && (retriesExhausted || !retryable);

        // Only a failure that produced tokens is worth reporting as abandoned;
        // the terminal cannot un-print it, so say so plainly instead of letting
        // the retry look like a fresh duplicate answer.
        if (attemptedOutput && (shouldFailover || retryable)) {
          this.options.ui.discardOutput?.();
        }

        if (shouldFailover) {
          const next = this.fallbacks.shift()!;
          this.options.ui.notice?.(`Switching to fallback model ${next.label} after a provider failure.`, "warn");
          model = next;
          provider = this.options.providers.get(next);
          // Kept in step with the request so summarization and session metadata
          // do not keep pointing at the provider that just failed.
          this.model = next;
          this.provider = provider;
          this.session.update({ model: next.model.id, provider: next.providerId });
          attempt = 0;
          continue;
        }

        if (retryable && attempt < maxAttempts) {
          const serverDelay = retryAfterMs(error instanceof ProviderError ? error.headers : undefined);
          const delay = serverDelay ?? backoffDelay(attempt, 700, 12_000);
          this.options.ui.retry?.({ attempt, delayMs: delay, reason: errorMessage(error), provider: provider.id });
          this.logger.warn(`Provider error, retrying in ${delay}ms: ${errorMessage(error)}`);
          await sleep(delay, signal);
          continue;
        }

        throw error;
      }
    }
  }

  private trackRepeats(toolCalls: ToolCallBlock[]): void {
    if (!toolCalls.length || this.config.raw.agent?.loopGuard === false) return;
    // A headless run never calls resetTrackers, so cap the maps instead of
    // letting one entry per distinct tool call accumulate for the whole process.
    if (this.repeatTracker.size > MAX_TRACKER_ENTRIES) this.repeatTracker.clear();
    for (const call of toolCalls) {
      const key = `${call.name}:${stableJson(call.args)}`;
      const count = (this.repeatTracker.get(key) ?? 0) + 1;
      this.repeatTracker.set(key, count);
      if (count === 3) {
        this.session.append(
          userMessage(
            `You have called ${call.name} with identical arguments ${count} times without progress. Stop repeating: read the result you already have, or change approach. If the task is blocked, report the blocker.`,
            { synthetic: true },
          ),
        );
        this.options.ui.notice?.(`Loop guard: repeated ${call.name} call detected.`, "warn");
      }
    }
  }

  async executeTools(calls: ToolCallBlock[], signal: AbortSignal, options: { parallel?: boolean; maxCalls?: number } = {}): Promise<ToolResultBlock[]> {
    const context = this.toolContext({}, signal);
    const results: ToolResultBlock[] = new Array(calls.length);
    const parallel = options.parallel !== false && this.config.raw.agent?.parallelToolCalls !== false;
    // A cap of 0 means unlimited; anything else stops a tool-call storm before it runs.
    const maxCalls = options.maxCalls && options.maxCalls > 0 ? options.maxCalls : Number.POSITIVE_INFINITY;

    let index = 0;
    while (index < calls.length) {
      if (signal.aborted) throw new AbortError();

      if (index >= maxCalls) {
        // Every tool_use needs a matching tool_result, so the deferred calls are
        // answered explicitly rather than dropped from the wire.
        for (let deferred = index; deferred < calls.length; deferred += 1) {
          const call = calls[deferred]!;
          results[deferred] = {
            type: "tool_result",
            id: call.id,
            name: call.name,
            content: `Not executed: this turn hit the ${maxCalls}-call ceiling. Call it again in your next turn if it is still needed.`,
            isError: true,
          };
        }
        break;
      }

      const call = calls[index]!;
      const tool = this.registry.get(call.name);

      if (!tool) {
        const outcome = await this.registry.run(call, context);
        this.reportToolOutcome(call, outcome);
        results[index] = toResultBlock(outcome);
        index += 1;
        continue;
      }

      const permission = await this.options.permissions.check(this.registry.permissionRequest(tool, call.args, context), signal);
      if (!permission.allowed) {
        this.announceTool(call, tool, context);
        const outcome: ToolCallOutcome = {
          callId: call.id,
          name: call.name,
          args: call.args,
          content: `Permission denied: ${permission.reason ?? "the user did not approve this action"}.`,
          isError: true,
          durationMs: 0,
          denied: true,
        };
        this.reportToolOutcome(call, outcome);
        results[index] = toResultBlock(outcome);
        index += 1;
        continue;
      }

      const canParallelize = parallel && Boolean(tool.readOnly && tool.concurrencySafe);
      if (!canParallelize) {
        this.announceTool(call, tool, context);
        const outcome = await this.runTool(call, context);
        this.reportToolOutcome(call, outcome);
        results[index] = toResultBlock(outcome);
        index += 1;
        continue;
      }

      const batch: ToolCallBlock[] = [];
      while (index + batch.length < calls.length && batch.length < MAX_PARALLEL_TOOLS && index + batch.length < maxCalls) {
        const candidate = calls[index + batch.length]!;
        const candidateTool = this.registry.get(candidate.name);
        if (!candidateTool || !candidateTool.readOnly || !candidateTool.concurrencySafe) break;
        const verdict = await this.options.permissions.check(this.registry.permissionRequest(candidateTool, candidate.args, context), signal);
        if (!verdict.allowed) break;
        batch.push(candidate);
      }

      if (batch.length <= 1) {
        this.announceTool(call, tool, context);
        const outcome = await this.runTool(call, context);
        this.reportToolOutcome(call, outcome);
        results[index] = toResultBlock(outcome);
        index += 1;
        continue;
      }

      for (const entry of batch) {
        this.announceTool(entry, this.registry.get(entry.name), context);
      }
      const outcomes = await Promise.all(batch.map((entry) => this.runTool(entry, context)));
      for (const [offset, outcome] of outcomes.entries()) {
        this.reportToolOutcome(batch[offset]!, outcome);
        results[index + offset] = toResultBlock(outcome);
      }
      index += batch.length;
    }

    const blocks = results.filter(Boolean);
    this.session.append(toolResultMessage(blocks));
    return blocks;
  }

  private announceTool(call: ToolCallBlock, tool: ReturnType<ToolRegistry["get"]>, context: ToolContext): void {
    const label = tool?.label ?? formatToolName(call.name);
    const summary = tool ? this.registry.describe(tool, call.args, context) : "";
    this.options.ui.toolStart?.({ id: call.id, name: call.name, label, summary, args: call.args });
  }

  private async runTool(call: ToolCallBlock, context: ToolContext): Promise<ToolCallOutcome> {
    const start = Date.now();
    const before = await this.options.hooks.run(
      "tool.before",
      { event: "tool.before", sessionId: this.session.id, cwd: this.config.cwd, tool: call.name, args: call.args },
      context.signal,
    );
    const blocked = before.find((outcome) => outcome.blocked);
    if (blocked) {
      return {
        callId: call.id,
        name: call.name,
        args: call.args,
        content: `Blocked by a hook: ${blocked.reason ?? "no reason given"}`,
        isError: true,
        durationMs: Date.now() - start,
      };
    }

    const injected = before.map((outcome) => outcome.output).filter((value): value is string => Boolean(value));
    const outcome = await this.registry.run(call, context);
    if (injected.length) {
      outcome.content = `${outcome.content}\n\n[hook context]\n${injected.join("\n")}`;
    }

    if (outcome.isError) {
      const failures = (this.failureTracker.get(call.name) ?? 0) + 1;
      this.failureTracker.set(call.name, failures);
    }

    await this.options.hooks.run(
      "tool.after",
      {
        event: "tool.after",
        sessionId: this.session.id,
        cwd: this.config.cwd,
        tool: call.name,
        args: call.args,
        result: outcome.content.slice(0, 4000),
        isError: outcome.isError,
      },
      context.signal,
    );

    return outcome;
  }

  private reportToolOutcome(call: ToolCallBlock, outcome: ToolCallOutcome): void {
    this.options.ui.toolEnd?.(outcome);
    if (outcome.isError) {
      this.logger.debug(`Tool ${call.name} failed: ${outcome.content.slice(0, 200)}`);
    }
  }

  async compact(options: { reason: string; instructions?: string; keepRecentTurns?: number } = { reason: "manual" }): Promise<void> {
    const keepTurns = options.keepRecentTurns ?? this.config.raw.context?.keepRecentTurns ?? 6;
    const plan = planCompaction(this.session.messages, { keepRecentTurns: keepTurns });
    if (plan.fold.length === 0) {
      // An automatic compaction that finds nothing to fold (a single turn larger
      // than the budget, with everything inside keepRecentTurns) must not repeat
      // the notice on every subsequent turn. Only a manual /compact reports it.
      if (options.reason === "manual") this.options.ui.notice?.("Nothing to compact yet.", "dim");
      return;
    }

    this.compactionInFlight = true;
    const before = this.stats().totalTokens;
    try {
      const hooks = await this.options.hooks.run(
        "compact.before",
        { event: "compact.before", sessionId: this.session.id, cwd: this.config.cwd, text: options.reason },
        this.controller?.signal ?? new AbortController().signal,
      );
      const extra = hooks.map((outcome) => outcome.output).filter((value): value is string => Boolean(value));

      let summary: string;
      try {
        summary = await this.summarize(plan.fold, options.instructions, extra, this.controller?.signal);
      } catch (error) {
        // A cancel must stop the turn, not silently degrade into a fixed summary.
        if (isAbortError(error)) throw new AbortError();
        this.logger.warn(`Model summarization failed, using a structural summary: ${errorMessage(error)}`);
        summary = structuralSummary(plan.fold);
      }
      if (!summary.trim()) summary = structuralSummary(plan.fold);

      const firstUser = plan.fold.find((message) => message.role === "user" && !message.meta?.synthetic);
      const summaryMessage = userMessage(
        [
          "<session-summary>",
          `The conversation was compacted to stay inside the context window (${plan.fold.length} earlier messages folded).`,
          "",
          summary.trim(),
          "</session-summary>",
        ].join("\n"),
        { synthetic: true, compacted: true, folded: plan.fold.length },
      );

      const kept = [...(firstUser ? [firstUser] : []), summaryMessage, ...plan.keep.filter((message) => message !== firstUser)];
      this.session.replace(kept);
      this.invalidateSystemPrompt();
      const after = this.stats().totalTokens;
      this.options.ui.compaction?.({ reason: options.reason, folded: plan.fold.length, summary, tokensBefore: before, tokensAfter: after });
      this.options.ui.notice?.(`Compacted ${plan.fold.length} messages (${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens).`, "dim");
    } finally {
      this.compactionInFlight = false;
    }
  }

  private async summarize(messages: Message[], instructions: string | undefined, extra: string[], parentSignal?: AbortSignal): Promise<string> {
    const transcript = transcriptForSummary(messages);
    const prompt = [compactionPrompt(transcript), ...(instructions ? ["", `Additional focus: ${instructions}`] : []), ...(extra.length ? ["", extra.join("\n")] : [])].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    // Linked to the turn so a user cancel stops the summarization request too.
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    try {
      let text = "";
      for await (const event of this.provider.stream({
        sessionId: this.session.id,
        model: this.model,
        effort: "minimal",
        system: "You compress coding sessions into precise handover notes. Reply with the note only.",
        messages: [userMessage(prompt)],
        tools: [],
        maxTokens: Math.min(4000, this.model.maxOutput),
        parallelToolCalls: false,
        signal,
        logger: this.logger,
      })) {
        if (event.type === "text") text += event.delta;
        if (event.type === "error") throw new ProviderError(event.message, { retryable: false });
      }
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  setModel(model: ResolvedModel, provider: Provider): void {
    this.model = model;
    this.provider = provider;
    // The overflow override belonged to the old model's window; keeping it would
    // silently cap a model that can hold far more.
    this.effectiveWindow = undefined;
    this.overflowRecoveries = 0;
    this.session.update({ model: model.model.id, provider: model.providerId });
    this.invalidateSystemPrompt();
  }

  setEffort(effort: Effort | "auto"): void {
    if (effort === "auto") {
      this.effortAuto = true;
      return;
    }
    this.effortAuto = false;
    this.effort = effort;
  }

  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
    this.invalidateSystemPrompt();
  }

  effortsBadge(): string {
    return this.effortAuto ? `auto (${onBadge(this.effort)})` : onBadge(this.effort);
  }

  contextStats(): ContextStats {
    return this.lastStats ?? this.stats();
  }

  resetTrackers(): void {
    this.repeatTracker.clear();
    this.failureTracker.clear();
  }

  configSnapshot(): BlueBirdConfig {
    return this.config.raw;
  }
}

function toResultBlock(outcome: ToolCallOutcome): ToolResultBlock {
  return {
    type: "tool_result",
    id: outcome.callId,
    name: outcome.name,
    content: outcome.content,
    ...(outcome.isError ? { isError: true } : {}),
    ...(outcome.images?.length ? { images: outcome.images } : {}),
  };
}

/**
 * Failures where another provider is more likely to succeed than another
 * attempt against this one: bad credentials, missing model, quota, or a
 * protocol failure. A malformed request would be rejected everywhere, so that
 * is excluded rather than burning every fallback.
 */
function isFailoverWorthy(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const status = error.status;
  if (status === 400 || status === 413 || status === 422) return false;
  return true;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function summarizeToolCalls(calls: ToolCallBlock[]): string {
  if (calls.length === 1) return `${calls[0]!.name}`;
  return `${calls.length} tool calls`;
}

export { newCheckpointId };
