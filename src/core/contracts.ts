import type { ToolDisplay } from "./display.ts";

/** Token accounting for a single model exchange. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) || undefined,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
    totalTokens: (a.totalTokens ?? a.inputTokens + a.outputTokens) + (b.totalTokens ?? b.inputTokens + b.outputTokens),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export type Tone = "default" | "dim" | "muted" | "info" | "accent" | "success" | "warn" | "error";

/**
 * Narrow surface tools use to talk to the interface. Tools never write to
 * stdout directly so that rendering stays consistent and testable.
 */
export interface UiSink {
  /** Transient one-line status shown under the tool row while it runs. */
  progress(id: string, text: string): void;
  /** Append a permanent line to the transcript. */
  notice(text: string, tone?: Tone): void;
  /** Update a segment of the persistent status line (undefined removes it). */
  status(key: string, value: string | undefined): void;
  log(level: LogLevel, message: string): void;
}

export const nullUiSink: UiSink = {
  progress() {},
  notice() {},
  status() {},
  log() {},
};

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionPreset = "read-only" | "ask" | "edits" | "auto" | "danger-full-access";

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  "read-only",
  "ask",
  "edits",
  "auto",
  "danger-full-access",
];

export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
  /** Human readable description of exactly what will happen. */
  summary: string;
  risk: "low" | "medium" | "high";
  readOnly: boolean;
  /** Absolute paths the action touches, when known. */
  paths?: string[];
  /** Shell command text, when the action spawns a process. */
  command?: string;
  /** Extra context shown in the confirmation prompt. */
  detail?: string;
}

export interface PermissionVerdict {
  allowed: boolean;
  /** Rule or preset that produced the verdict, for auditing. */
  via?: string;
  reason?: string;
}

export interface PermissionApi {
  check(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionVerdict>;
  readonly preset: PermissionPreset;
}

export interface PermissionRule {
  pattern: string;
  decision: Exclude<PermissionDecision, "ask">;
}

export interface ConfirmOption {
  value: string;
  label: string;
  description?: string;
  /** Single keypress that activates the option. */
  key?: string;
  danger?: boolean;
}

export interface ConfirmPrompt {
  title: string;
  detail?: string;
  body?: string;
  tone?: Tone;
  options: ConfirmOption[];
  defaultOption?: string;
  signal?: AbortSignal;
}

export interface PromptApi {
  confirm(prompt: ConfirmPrompt): Promise<string>;
}

export interface SessionRef {
  id: string;
  cwd: string;
  dir: string;
  title?: string;
}

export type HookEvent =
  | "session.start"
  | "session.end"
  | "prompt.submit"
  | "tool.before"
  | "tool.after"
  | "turn.end"
  | "compact.before"
  | "notification";

export interface HookPayload {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  text?: string;
  model?: string;
  effort?: string;
}

export interface HookOutcome {
  /** A hook may veto the action (tool.before / prompt.submit). */
  blocked?: boolean;
  reason?: string;
  /** stdout from the hook, injected into context for tool.before hooks. */
  output?: string;
}

export interface HookApi {
  run(event: HookEvent, payload: HookPayload, signal: AbortSignal): Promise<HookOutcome[]>;
}

export const nullHookApi: HookApi = {
  async run() {
    return [];
  },
};

export interface FileReadRecord {
  path: string;
  mtimeMs: number;
  size: number;
  lines?: number;
  offset?: number;
  limit?: number;
}

export interface FileEditRecord {
  path: string;
  writes: number;
  addedLines: number;
  removedLines: number;
}

/** Tracks what the agent has seen and changed, mirroring how careful engineers work. */
export interface WorkspaceState {
  markRead(path: string, record: Omit<FileReadRecord, "path">): void;
  getRead(path: string): FileReadRecord | undefined;
  hasRead(path: string): boolean;
  /** True when the file changed on disk after the agent last read it. */
  isStale(path: string, currentMtimeMs: number): boolean;
  recordWrite(path: string, delta: { addedLines: number; removedLines: number }): void;
  readonly reads: Map<string, FileReadRecord>;
  readonly writes: Map<string, FileEditRecord>;
  readonly touched: Set<string>;
}

export interface CheckpointInfo {
  id: string;
  label: string;
  sessionId: string;
  ts: number;
  files: { path: string; existed: boolean; additions?: number; deletions?: number }[];
  turn: number;
}

export interface CheckpointApi {
  /** Arm a checkpoint for the given turn; must be called before the first mutation of a turn. */
  arm(turnId: string, label: string, turn: number): void;
  /** Capture the pre-edit content of a file (idempotent per turn). */
  capture(turnId: string, path: string): void;
  /** Record the line delta of a mutation so /checkpoints can show its size. */
  setDelta(turnId: string, path: string, delta: { added: number; removed: number }): void;
  /**
   * Persist an armed turn and release it from memory. Must be called for every
   * armed turn — including turns that mutated nothing — or the pending map grows.
   */
  commit(turnId: string): CheckpointInfo | undefined;
  list(limit?: number): CheckpointInfo[];
  restore(id: string): Promise<{ restored: string[]; missing: string[] }>;
  drop(id: string): Promise<void>;
}

export const nullCheckpointApi: CheckpointApi = {
  arm() {},
  capture() {},
  setDelta() {},
  commit() {
    return undefined;
  },
  list() {
    return [];
  },
  async restore() {
    return { restored: [], missing: [] };
  },
  async drop() {},
};

export interface SubagentRequest {
  description: string;
  prompt: string;
  /** Named agent definition from .bluebird/agents/*.md */
  agent?: string;
  model?: string;
  /** Restrict the subagent to a subset of tools. */
  tools?: string[];
  readOnly?: boolean;
  maxTurns?: number;
}

export interface SubagentResult {
  text: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  model: string;
  aborted?: boolean;
}

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  readOnly?: boolean;
  source: string;
}

export interface SubagentApi {
  run(request: SubagentRequest, signal: AbortSignal): Promise<SubagentResult>;
  list(): AgentDefinition[];
}

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  /** Body with $ARGUMENTS / $1..$9 placeholders resolved by the caller. */
  template: string;
  source: string;
  model?: string;
  effort?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  body: string;
  dir: string;
  files: string[];
  source: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
  isError?: boolean;
  summary?: string;
  display?: ToolDisplay;
  bytes?: number;
}

export function defaultWorkspaceState(): WorkspaceState {
  const reads = new Map<string, FileReadRecord>();
  const writes = new Map<string, FileEditRecord>();
  const touched = new Set<string>();
  return {
    reads,
    writes,
    touched,
    markRead(path, record) {
      reads.set(path, { path, ...record });
      touched.add(path);
    },
    getRead(path) {
      return reads.get(path);
    },
    hasRead(path) {
      return reads.has(path);
    },
    isStale(path, currentMtimeMs) {
      const record = reads.get(path);
      if (!record) return false;
      return currentMtimeMs > record.mtimeMs + 1;
    },
    recordWrite(path, delta) {
      const current = writes.get(path) ?? { path, writes: 0, addedLines: 0, removedLines: 0 };
      writes.set(path, {
        path,
        writes: current.writes + 1,
        addedLines: current.addedLines + delta.addedLines,
        removedLines: current.removedLines + delta.removedLines,
      });
      touched.add(path);
      reads.delete(path);
    },
  };
}
