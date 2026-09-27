import { CONFIG_VERSION } from "../version.ts";

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type EffortSetting = Effort | "auto";

export const EFFORT_LEVELS: readonly Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_TITLES: Record<Effort, string> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export const EFFORT_DESCRIPTIONS: Record<Effort, string> = {
  none: "No reasoning pass. Fastest, for lookups and mechanical edits.",
  minimal: "A brief reasoning pass. Good for well-specified single-file changes.",
  low: "Light reasoning. Cheap exploration and small features.",
  medium: "Balanced default for everyday implementation work.",
  high: "Deep reasoning for multi-file features, debugging and design.",
  xhigh: "Extra-deep reasoning. Hard refactors, subtle bugs, architecture.",
  max: "The largest budget the model takes. For problems where a wrong answer costs more than the thinking.",
};

/** Relative ordering, useful for sweeping effort up or down. */
export const EFFORT_INDEX: Record<Effort, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Anthropic extended-thinking budgets per level. */
export const EFFORT_THINKING_BUDGET: Record<Effort, number> = {
  none: 0,
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

/** Reasoning-effort strings understood by OpenAI-style chat/responses endpoints. */
export const EFFORT_OPENAI: Record<Effort, string | undefined> = {
  none: undefined,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isEffortSetting(value: unknown): value is EffortSetting {
  return value === "auto" || isEffort(value);
}

export type ApiFlavor = "openai-completions" | "openai-responses" | "anthropic-messages" | "mock";

export const API_FLAVORS: readonly ApiFlavor[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "mock",
];

/**
 * Context window assumed when neither the model nor the provider declares one.
 * Blue Bird is built to run long sessions, so the default assumption is 1M
 * tokens; declare `contextWindow` on the model to match a smaller provider.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MAX_OUTPUT = 64_000;

export interface Pricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelDef {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: Pricing;
  /** Overrides the provider's api dialect for this model. */
  api?: ApiFlavor;
  /** Set when the model rejects reasoning knobs entirely. */
  supportsEffort?: boolean;
  supportsTools?: boolean;
  supportsImages?: boolean;
  /** Some deployments require a query parameter such as api-version. */
  query?: Record<string, string>;
  /** Set by the resolver when the window was assumed rather than declared. */
  assumedWindow?: boolean;
}

export interface ProviderCompat {
  /** Send `stream_options: { include_usage: true }`. */
  streamUsage?: boolean;
  /** Field name carrying the reasoning level. Defaults to `reasoning_effort`. */
  effortParam?: string | null;
  /** Send `reasoning: { effort }` (responses API) instead of the flat field. */
  effortObject?: boolean;
  /** Field name carrying the output cap. Defaults to `max_tokens`. */
  maxTokensParam?: string;
  /** Send `parallel_tool_calls`. */
  parallelToolCalls?: boolean;
  /** Send `stream: true` on the wire (always true unless disabled for odd proxies). */
  streaming?: boolean;
  /** Chat endpoint path, relative to baseURL. */
  chatPath?: string;
  /** Messages endpoint path (Anthropic dialect), relative to baseURL. */
  messagesPath?: string;
  /** Responses endpoint path (OpenAI responses dialect), relative to baseURL. */
  responsesPath?: string;
  /** Models endpoint path, relative to baseURL. */
  modelsPath?: string;
  /** How the API key travels on the wire. "auto" picks per host. */
  authStyle?: "auto" | "bearer" | "api-key" | "x-api-key";
  /**
   * Prompt caching. "auto" (default) enables cache breakpoints where the
   * dialect supports them and skips provider-specific hints that could be
   * rejected. true forces every supported hint, false disables caching hints.
   */
  promptCache?: boolean | "auto";
  /** Send `prompt_cache_key` (OpenAI) so a session reuses one cache shard. */
  promptCacheKey?: boolean;
  /** Send `prompt_cache_retention`, e.g. "24h". */
  promptCacheRetention?: string;
  /** Send the Anthropic beta header for prompt caching. */
  promptCacheBeta?: boolean;
  /** Responses API: send `store` so the provider keeps server-side state. */
  store?: boolean;
  /** Anthropic: send the beta header for 1M context. */
  context1m?: boolean;
}

export interface ProviderDef {
  displayName?: string;
  api: ApiFlavor;
  baseURL: string;
  apiKey?: string;
  /** Environment variable consulted when apiKey is absent. */
  apiKeyEnv?: string;
  /** Path to a file containing the key. */
  apiKeyFile?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  models?: ModelDef[];
  contextWindow?: number;
  maxOutput?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  retries?: number;
  compat?: ProviderCompat;
  /** Skip TLS verification (local dev servers with self-signed certs). */
  insecure?: boolean;
}

export interface ContextConfig {
  /** Hard ceiling for prompt tokens; defaults to the model's context window. */
  maxTokens?: number;
  /** Window assumed when a model does not declare one. Defaults to 1,000,000. */
  assumeWindow?: number;
  /** Fraction of the window at which automatic compaction kicks in. */
  compactAt: number;
  /** "auto" summarizes old turns, "off" only warns and prunes. */
  compaction: "auto" | "prune" | "off";
  /** Turns kept verbatim after a compaction. */
  keepRecentTurns: number;
  /** Tool results longer than this are truncated in the prompt. */
  maxToolOutputChars: number;
  /** Replace tool output from older turns with a stub. */
  pruneStaleToolOutputs: boolean;
  /** Tokens reserved for the reply. */
  reserveOutputTokens: number;
  /**
   * On a provider context-overflow error, lower the effective window and retry
   * once instead of failing the turn.
   */
  recoverFromOverflow?: boolean;
}

export interface PermissionConfig {
  preset: PermissionPresetValue;
  allow?: string[];
  deny?: string[];
  /** Extra directories the agent may touch outside the workspace. */
  additionalDirectories?: string[];
  /** Allow network tools (web fetch/search). */
  network?: boolean;
  /** Allow commands that are normally blocked as catastrophic. */
  allowDangerous?: boolean;
  /**
   * When false, no mutating or executing action is auto-approved: explicit allow
   * rules and read-only inspection still work, but everything else asks. Use it
   * when running the agent inside a repository you do not trust.
   */
  trusted?: boolean;
}

export type PermissionPresetValue = "read-only" | "ask" | "edits" | "auto" | "danger-full-access";

export interface UiConfig {
  theme: "auto" | "dark" | "light" | "none";
  /** Show reasoning text when the model emits it. */
  showThinking: boolean;
  /** Show the bottom status line. */
  statusLine: boolean;
  /** Show running token/cost counters. */
  showUsage: boolean;
  /** inline = compact +N/-M, full = hunk view, none = hide. */
  diff: "inline" | "full" | "none";
  /** Echo command output live instead of a summary row. */
  verboseToolOutput: boolean;
  /** auto uses the built-in line editor when stdout is a TTY. */
  editor: "auto" | "simple";
  /** Respect .gitignore when listing files. */
  respectGitIgnore: boolean;
  /** Collapse long tool output in the transcript. */
  collapseLines: number;
  /** Behaviour when Enter is pressed while the agent is streaming. */
  busyEnter: "queue" | "ignore";
  /** Show a spinner with elapsed time while streaming. */
  spinner: boolean;
}

export interface AgentConfig {
  maxTurns: number;
  /** Upper bound on tool calls per assistant turn. */
  maxToolCallsPerTurn: number;
  temperature?: number;
  /** Keep going when the model hits the output cap mid-turn. */
  autoContinueOnTruncation: boolean;
  parallelToolCalls: boolean;
  /** Detect repeated identical tool calls and stop looping. */
  loopGuard: boolean;
  /** Retry budget for transient provider failures. */
  retries: number;
  subagents: {
    enabled: boolean;
    maxConcurrent: number;
    maxTurns: number;
    /** Restrict subagents to read-only tools. */
    readOnly: boolean;
    /** Agent/model overrides per named subagent. */
    models?: Record<string, string>;
  };
}

export interface HookConfig {
  event: HookEventValue;
  /** Regex matched against the tool name or prompt text. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
  /** Run inside the project root instead of the current directory. */
  cwd?: string;
}

export type HookEventValue =
  | "session.start"
  | "session.end"
  | "prompt.submit"
  | "tool.before"
  | "tool.after"
  | "turn.end"
  | "compact.before"
  | "notification";

export const HOOK_EVENTS: readonly HookEventValue[] = [
  "session.start",
  "session.end",
  "prompt.submit",
  "tool.before",
  "tool.after",
  "turn.end",
  "compact.before",
  "notification",
];

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** Auto-approve this server's tools instead of asking. */
  trust?: boolean;
  timeoutMs?: number;
}

export interface MemoryConfig {
  /** Extra instruction files loaded into the system prompt. */
  files?: string[];
  /** Follow BLUEBIRD.md / AGENTS.md / CLAUDE.md up the tree and in the home dir. */
  autoLoad: boolean;
  /** Free-form text appended to the system prompt. */
  instructions?: string;
  /** Persist session learnings into .bluebird/memory/*.md */
  learnings: boolean;
}

export interface ImagesConfig {
  /** Offer the view_image tool and accept image attachments. */
  enabled: boolean;
  /** Largest image accepted, in bytes. */
  maxBytes: number;
  /** Images sent per message; extra images are dropped with a note. */
  maxPerMessage: number;
  /** Detail hint for OpenAI-style providers. */
  detail: "auto" | "low" | "high";
  /** Allow reading images from outside the workspace. */
  allowOutsideWorkspace?: boolean;
}

export interface SessionConfig {
  /** Keep transcripts on disk. */
  persist: boolean;
  /** Days of history to retain; 0 keeps everything. */
  retentionDays: number;
  /** Where project data lives relative to the workspace root. */
  dir: string;
}

export interface UpdateConfig {
  /** Check the registry on startup and install a newer release in the background. */
  auto: boolean;
  /** Hours between registry checks; the answer is cached in ~/.bluebird/update.json. */
  checkIntervalHours: number;
}

export interface BlueBirdConfig {
  $schema?: string;
  version: number;

  /** Convenience fields: the single-endpoint form written by `bluebird init`. */
  endpoint?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  api?: ApiFlavor;
  model?: string;
  provider?: string;
  /** Context window for the endpoint form; defaults to 1,000,000 tokens. */
  contextWindow?: number;
  /** Output cap for the endpoint form. */
  maxOutput?: number;
  /** Ordered fallback targets, "provider" or "provider/model". */
  fallbacks?: string[];

  providers?: Record<string, ProviderDef>;
  effort?: EffortSetting;
  permissions?: PermissionConfig;
  context?: ContextConfig;
  ui?: UiConfig;
  agent?: AgentConfig;
  hooks?: HookConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  memory?: MemoryConfig;
  sessions?: SessionConfig;
  images?: ImagesConfig;
  update?: UpdateConfig;

  /** Extra directories added to the tool sandbox. */
  includeDirectories?: string[];
}

export const DEFAULT_CONTEXT: ContextConfig = {
  assumeWindow: DEFAULT_CONTEXT_WINDOW,
  compactAt: 0.82,
  compaction: "auto",
  keepRecentTurns: 6,
  maxToolOutputChars: 24_000,
  pruneStaleToolOutputs: true,
  reserveOutputTokens: 16_000,
  recoverFromOverflow: true,
};

export const DEFAULT_UI: UiConfig = {
  theme: "auto",
  showThinking: true,
  statusLine: true,
  showUsage: true,
  diff: "inline",
  verboseToolOutput: false,
  editor: "auto",
  respectGitIgnore: true,
  collapseLines: 14,
  busyEnter: "queue",
  spinner: true,
};

export const DEFAULT_AGENT: AgentConfig = {
  maxTurns: 120,
  maxToolCallsPerTurn: 24,
  autoContinueOnTruncation: true,
  parallelToolCalls: true,
  loopGuard: true,
  retries: 3,
  subagents: {
    enabled: true,
    maxConcurrent: 4,
    maxTurns: 40,
    readOnly: false,
  },
};

export const DEFAULT_PERMISSIONS: PermissionConfig = {
  preset: "ask",
  network: true,
  trusted: true,
};

export const DEFAULT_MEMORY: MemoryConfig = {
  autoLoad: true,
  learnings: true,
};

export const DEFAULT_SESSIONS: SessionConfig = {
  persist: true,
  retentionDays: 30,
  dir: ".bluebird",
};

export const DEFAULT_IMAGES: ImagesConfig = {
  enabled: true,
  maxBytes: 5_000_000,
  maxPerMessage: 8,
  detail: "auto",
};

export const DEFAULT_UPDATE: UpdateConfig = {
  auto: true,
  checkIntervalHours: 24,
};

export const DEFAULT_CONFIG: BlueBirdConfig = {
  version: CONFIG_VERSION,
  effort: "auto",
  permissions: DEFAULT_PERMISSIONS,
  context: DEFAULT_CONTEXT,
  ui: DEFAULT_UI,
  agent: DEFAULT_AGENT,
  memory: DEFAULT_MEMORY,
  sessions: DEFAULT_SESSIONS,
  update: DEFAULT_UPDATE,
};

export interface ResolvedModel {
  providerId: string;
  provider: ProviderDef;
  model: ModelDef;
  api: ApiFlavor;
  baseURL: string;
  apiKey?: string;
  apiKeySource: "inline" | "env" | "file" | "none";
  contextWindow: number;
  maxOutput: number;
  pricing?: Pricing;
  label: string;
}

export interface ResolvedConfig {
  /** Fully merged configuration. */
  raw: BlueBirdConfig;
  cwd: string;
  /** Workspace root that owns .bluebird/ */
  root: string;
  configPath?: string;
  globalConfigPath: string;
  home: string;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  model: ResolvedModel;
  effort: EffortSetting;
  /** Environment values that overrode file config. */
  envOverrides: string[];
  warnings: string[];
}
