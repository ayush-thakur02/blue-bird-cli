import type { ApiFlavor, Effort, ProviderDef, ResolvedModel } from "../config/schema.ts";
import type { Logger, Usage } from "../core/contracts.ts";
import type { Message, ToolCallBlock } from "../core/messages.ts";
import type { ToolSpec } from "../tools/types.ts";

export interface ChatRequest {
  sessionId: string;
  model: ResolvedModel;
  effort: Effort;
  /** Assembled system prompt (already includes memory, tool guidance and reminders). */
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  parallelToolCalls: boolean;
  signal: AbortSignal;
  logger: Logger;
  /**
   * Stable identifier for this session, used as the provider-side prompt-cache
   * key so every turn of a session reuses the same cache shard.
   */
  cacheKey?: string;
  /** Optional prompt-cache hint: index of the last message that can be cached. */
  cacheBreakpoint?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "aborted" | "error";

export type StreamEvent =
  | { type: "start"; model: string; providerId: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; call: ToolCallBlock }
  | { type: "usage"; usage: Usage }
  /** Something the user should see: the request is being adapted, not failing. */
  | { type: "notice"; text: string }
  | {
      type: "done";
      stopReason: StopReason;
      usage: Usage;
      text: string;
      thinking: string;
      /**
       * Provider signature for the thinking block. Anthropic rejects an
       * assistant turn that carries tool_use but no signed thinking block, so
       * this must survive from the stream into the next request.
       */
      thinkingSignature?: string;
      toolCalls: ToolCallBlock[];
      model?: string;
    }
  | { type: "error"; message: string; retryable: boolean };

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  ownedBy?: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  models?: string[];
}

export interface Provider {
  readonly id: string;
  readonly api: ApiFlavor;
  readonly def: ProviderDef;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  probe(signal: AbortSignal): Promise<ProbeResult>;
}

export function isRetryableStreamError(event: { type: "error"; retryable: boolean }): boolean {
  return event.retryable;
}
