import type {
  CheckpointApi,
  HookApi,
  Logger,
  PermissionApi,
  SkillDefinition,
  SubagentApi,
  UiSink,
  WorkspaceState,
} from "../core/contracts.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ImageAttachment } from "../core/messages.ts";
import type { ToolDisplay, ToolDisplayResult, ToolResultMeta } from "../core/display.ts";
import type { BackgroundTasks } from "./shell.ts";

export interface JsonSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict?: boolean;
}

export interface ToolContext {
  readonly cwd: string;
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly sessionId: string;
  /** Identifier of the assistant turn currently executing tools. */
  readonly turnId: string;
  readonly permissions: PermissionApi;
  readonly ui: UiSink;
  readonly signal: AbortSignal;
  readonly state: WorkspaceState;
  readonly checkpoints: CheckpointApi;
  readonly hooks: HookApi;
  readonly logger: Logger;
  readonly skills: SkillDefinition[];
  /** Background process registry shared by bash, bash_output and kill_shell. */
  readonly background: BackgroundTasks;
  readonly subagents?: SubagentApi;
  /** Emit a structured event into the transcript (used by task/todo tools). */
  readonly emit?: (event: ToolEmitEvent) => void;
}

export type ToolEmitEvent =
  | { type: "todos"; todos: { content: string; status: "pending" | "in_progress" | "completed" }[] }
  | { type: "subagent"; description: string; model: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "notice"; text: string };

export type ToolRisk = "low" | "medium" | "high";

export interface Tool {
  readonly name: string;
  /** Title used in the transcript, defaults to a humanised name. */
  readonly label?: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Pure reads: safe in plan mode and safe to parallelise. */
  readonly readOnly?: boolean;
  /** May run concurrently with other calls in the same assistant turn. */
  readonly concurrencySafe?: boolean;
  readonly risk?: ToolRisk;
  readonly tags?: readonly string[];
  /** Extra system-prompt guidance contributed when the tool is enabled. */
  readonly prompt?: string;
  /** Tool is hidden from the model unless the predicate passes. */
  isEnabled?(ctx: ToolContext): boolean;
  /** Validate and normalise arguments before execution. Throwing aborts the call. */
  prepare?(args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> | Promise<Record<string, unknown>>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolDisplayResult>;
  /** Human-readable one-liner describing a call, used in transcripts and prompts. */
  describe?(args: Record<string, unknown>, ctx: ToolContext): string;
}

export function defineTool<T extends Tool>(tool: T): T {
  return tool;
}

export interface ToolCallOutcome {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  content: string;
  isError: boolean;
  summary?: string;
  display?: ToolDisplay;
  meta?: ToolResultMeta;
  durationMs: number;
  denied?: boolean;
  /** Images produced by the tool, forwarded to the model. */
  images?: ImageAttachment[];
}

export function formatToolName(name: string): string {
  return name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
