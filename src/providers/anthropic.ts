import type { ProviderCompat, ProviderDef } from "../config/schema.ts";
import { EFFORT_THINKING_BUDGET, type Effort } from "../config/schema.ts";
import type { Usage } from "../core/contracts.ts";
import type { ImageAttachment, Message, ToolCallBlock } from "../core/messages.ts";
import { ProviderError } from "../util/errors.ts";
import { callId } from "../util/ids.ts";
import { estimateConversationTokens, estimateTokens } from "../util/tokens.ts";
import { estimateCost } from "./openai-chat.ts";
import { cachePlan, knownUnsupported, rememberUnsupported, withoutToolsNotice, type CachePlan } from "./caching.ts";
import type { ChatRequest, ModelInfo, ProbeResult, Provider, StreamEvent, StopReason } from "./types.ts";
import {
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_IDLE_TIMEOUT,
  baseHeaders,
  ensureOk,
  getJson,
  joinUrl,
  jsonOrSse,
  postJson,
  safeHost,
  withQuery,
  type TransportOptions,
} from "./transport.ts";

const ANTHROPIC_VERSION = "2023-06-01";

interface ContentBlockWire {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  cache_control?: { type: "ephemeral" };
  /** image blocks */
  source?: { type: "base64"; media_type: string; data: string };
}

interface WireMessage {
  role: "user" | "assistant";
  content: ContentBlockWire[];
}

interface AnthropicEvent {
  type: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string | null;
  };
  index?: number;
  content_block?: ContentBlockWire;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number; input_tokens?: number };
  error?: { type?: string; message?: string };
}

export function createAnthropicProvider(options: { id: string; def: ProviderDef; apiKey?: string }): Provider {
  const { id, def } = options;
  const compat: ProviderCompat = def.compat ?? {};
  const messagesUrl = anthropicUrl(def.baseURL, compat.messagesPath ?? "v1/messages");

  const transport = (signal: AbortSignal): TransportOptions => ({
    signal,
    connectTimeoutMs: def.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT,
    idleTimeoutMs: def.timeoutMs ? Math.max(def.timeoutMs, DEFAULT_IDLE_TIMEOUT) : DEFAULT_IDLE_TIMEOUT,
    retries: def.retries ?? 2,
    providerId: id,
  });

  const headers = (plan?: CachePlan) => {
    const beta: string[] = [];
    if (compat.context1m) beta.push("context-1m-2025-08-07");
    if (plan?.betaHeader) beta.push("prompt-caching-2024-07-31");
    return {
      ...baseHeaders(def, options.apiKey, "anthropic-messages"),
      "anthropic-version": ANTHROPIC_VERSION,
      ...(beta.length ? { "anthropic-beta": beta.join(",") } : {}),
    };
  };

  async function* stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const disabled = knownUnsupported(id);
    const attempts = 4;
    const requestUrl = withQuery(messagesUrl, { ...(def.query ?? {}), ...(request.model.model.query ?? {}) });
    const plan = cachePlan(request.model);
    const useCache = plan.breakpoints;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const payload = buildPayload(request, { disabled, useCache, streaming: compat.streaming !== false, tailBreakpoints: plan.tailBreakpoints });
      const response = await postJson({ url: requestUrl, body: payload, headers: headers(plan), options: transport(request.signal) });

      if (response.status === 400 || response.status === 422) {
        const text = await response.text().catch(() => "");
        const lowered = text.toLowerCase();
        let adjustment: string | undefined;
        if (lowered.includes("thinking") && !disabled.has("thinking")) adjustment = "thinking";
        else if (lowered.includes("cache_control") && !disabled.has("cache_control")) adjustment = "cache_control";
        else if (lowered.includes("temperature") && !disabled.has("temperature")) adjustment = "temperature";
        else if (lowered.includes("max_tokens") && !disabled.has("max_tokens")) adjustment = "max_tokens";
        else if (lowered.includes("tools") && !disabled.has("tools")) adjustment = "tools";
        if (adjustment && attempt < attempts - 1) {
          request.logger.debug(`Retrying Anthropic request without ${adjustment}`);
          disabled.add(adjustment);
          rememberUnsupported(id, adjustment);
          if (adjustment === "tools") yield { type: "notice", text: withoutToolsNotice(safeHost(messagesUrl)) };
          continue;
        }
        if (/prompt is too long|too many tokens|exceeds.*context/i.test(lowered)) {
          throw new ProviderError("Prompt exceeds the model context window", {
            provider: id,
            retryable: false,
            hint: "Run /compact to summarize the session, or lower context.compactAt in your config.",
          });
        }
        await ensureOk(new Response(text, { status: response.status, headers: response.headers }), id, "Messages call");
      }

      await ensureOk(response, id, "Messages call");
      yield* parseAnthropicStream(response, request, transport(request.signal));
      return;
    }

    throw new ProviderError("Anthropic request failed after adapting to this endpoint", { provider: id });
  }

  async function listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const configured = def.models ?? [];
    try {
      const response = await getJson<{ data?: { id?: string; display_name?: string }[] }>({
        url: anthropicUrl(def.baseURL, compat.modelsPath ?? "v1/models"),
        headers: headers(),
        options: transport(signal),
      });
      const remote = (response.data ?? [])
        .filter((entry): entry is { id: string; display_name?: string } => Boolean(entry?.id))
        .map((entry) => ({ id: entry.id, name: entry.display_name, contextWindow: 200_000 }));
      if (remote.length) {
        const known = new Map<string, ModelInfo>(remote.map((model) => [model.id, model]));
        for (const model of configured) {
          known.set(model.id, { id: model.id, name: model.name, contextWindow: model.contextWindow });
        }
        return [...known.values()];
      }
    } catch {
      // fall through to configured list
    }
    return configured.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }));
  }

  async function probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const models = await listModels(signal);
      return {
        ok: true,
        detail: `${models.length} model${models.length === 1 ? "" : "s"} reachable at ${safeHost(messagesUrl)}`,
        latencyMs: Date.now() - started,
        models: models.slice(0, 30).map((model) => model.id),
      };
    } catch (error) {
      return { ok: false, detail: (error as Error).message, latencyMs: Date.now() - started };
    }
  }

  return { id, api: "anthropic-messages", def, stream, listModels, probe };
}

export function anthropicUrl(baseURL: string, path: string): string {
  if (/\/messages\/?$/.test(baseURL)) return baseURL;
  return joinUrl(baseURL, path);
}

export function buildPayload(
  request: ChatRequest,
  opts: { disabled: Set<string>; useCache: boolean; streaming: boolean; tailBreakpoints?: number },
): Record<string, unknown> {
  const { disabled, useCache, streaming } = opts;
  const effort: Effort = request.effort;
  const thinkingBudget = EFFORT_THINKING_BUDGET[effort] ?? 0;
  const thinkingEnabled = thinkingBudget > 0 && !disabled.has("thinking") && request.model.model.supportsEffort !== false;
  const cacheEnabled = useCache && !disabled.has("cache_control");

  const systemBlocks: ContentBlockWire[] = [];
  if (request.system.trim()) {
    const block: ContentBlockWire = { type: "text", text: request.system };
    if (cacheEnabled) block.cache_control = { type: "ephemeral" };
    systemBlocks.push(block);
  }

  const maxTokens = Math.max(
    request.maxTokens ?? request.model.maxOutput,
    thinkingEnabled ? thinkingBudget + 4096 : 0,
  );

  const payload: Record<string, unknown> = {
    model: request.model.model.id,
    system: systemBlocks,
    messages: toAnthropicMessages(request.messages, {
      cacheTail: cacheEnabled ? (opts.tailBreakpoints ?? 2) : 0,
    }),
    max_tokens: maxTokens,
    stream: streaming,
  };

  if (request.tools.length && !disabled.has("tools")) {
    payload.tools = request.tools.map((tool, index) => {
      const entry: Record<string, unknown> = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      };
      // The tools block is cached as a whole, so only the final definition needs the marker.
      if (cacheEnabled && index === request.tools.length - 1) {
        entry.cache_control = { type: "ephemeral" };
      }
      return entry;
    });
    if (request.toolChoice && !disabled.has("tool_choice")) {
      payload.tool_choice = request.toolChoice === "none" ? { type: "none" } : { type: "auto" };
    }
  }

  if (thinkingEnabled) {
    payload.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  } else if (request.temperature !== undefined && !disabled.has("temperature")) {
    payload.temperature = request.temperature;
  }

  return payload;
}

export function toAnthropicMessages(
  messages: Message[],
  options: { cacheTail?: number } = {},
): WireMessage[] {
  const wire = buildAnthropicWire(messages);
  const tail = options.cacheTail ?? 0;
  if (tail > 0) {
    for (const message of wire.slice(-tail)) {
      const last = message.content[message.content.length - 1];
      if (last && !last.cache_control) last.cache_control = { type: "ephemeral" };
    }
  }
  return wire;
}

function buildAnthropicWire(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      const content: ContentBlockWire[] = [];
      for (const block of message.blocks) {
        if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
        else if (block.type === "image") content.push(imageBlock(block.image));
      }
      if (content.length) wire.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      const content: ContentBlockWire[] = [];
      for (const block of message.blocks) {
        if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
        else if (block.type === "thinking" && block.text && block.signature) {
          content.push({ type: "thinking", thinking: block.text, signature: block.signature });
        } else if (block.type === "tool_call") {
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.args ?? {} });
        }
      }
      if (content.length) wire.push({ role: "assistant", content });
      continue;
    }

    const results: ContentBlockWire[] = [];
    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      // Anthropic accepts images inside a tool_result, so vision tools are native here.
      const inner: ContentBlockWire[] = [{ type: "text", text: block.content || "(no output)" }];
      for (const image of block.images ?? []) inner.push(imageBlock(image));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: inner,
        ...(block.isError ? { is_error: true } : {}),
      });
    }
    if (results.length) {
      const last = wire[wire.length - 1];
      if (last && last.role === "user" && last.content.every((block) => block.type === "tool_result")) {
        last.content.push(...results);
      } else {
        wire.push({ role: "user", content: results });
      }
    }
  }

  return mergeAdjacent(wire);
}

function imageBlock(image: ImageAttachment): ContentBlockWire {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  };
}

function mergeAdjacent(wire: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of wire) {
    const last = out[out.length - 1];
    if (
      last &&
      last.role === message.role &&
      !last.content.some((block) => block.type === "tool_use") &&
      !message.content.some((block) => block.type === "tool_result")
    ) {
      last.content.push(...message.content);
      continue;
    }
    out.push(message);
  }
  return out;
}

async function* parseAnthropicStream(
  response: Response,
  request: ChatRequest,
  options: TransportOptions,
): AsyncGenerator<StreamEvent, void, void> {
  let text = "";
  let thinking = "";
  let signature: string | undefined;
  const toolCalls: ToolCallBlock[] = [];
  const partials = new Map<number, { id: string; name: string; json: string }>();
  let stopReason: StopReason = "end_turn";
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let model: string | undefined;

  for await (const event of jsonOrSse<AnthropicEvent>(response, options)) {
    switch (event.type) {
      case "message_start": {
        model = event.message?.model ?? model;
        const startUsage = event.message?.usage;
        if (startUsage) {
          usage.inputTokens = startUsage.input_tokens ?? 0;
          usage.cacheReadTokens = startUsage.cache_read_input_tokens;
          usage.cacheWriteTokens = startUsage.cache_creation_input_tokens;
          usage.outputTokens = startUsage.output_tokens ?? 0;
        }
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        const index = event.index ?? 0;
        if (block?.type === "tool_use") {
          partials.set(index, { id: block.id ?? callId(), name: block.name ?? "unknown_tool", json: "" });
        } else if (block?.type === "thinking" && block.thinking) {
          thinking += block.thinking;
          yield { type: "thinking", delta: block.thinking };
        } else if (block?.type === "text" && block.text) {
          text += block.text;
          yield { type: "text", delta: block.text };
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        const index = event.index ?? 0;
        if (!delta) break;
        if (delta.type === "text_delta" && delta.text) {
          text += delta.text;
          yield { type: "text", delta: delta.text };
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          thinking += delta.thinking;
          yield { type: "thinking", delta: delta.thinking };
        } else if (delta.type === "signature_delta" && delta.signature) {
          signature = (signature ?? "") + delta.signature;
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          const partial = partials.get(index) ?? { id: callId(), name: "unknown_tool", json: "" };
          partial.json += delta.partial_json;
          partials.set(index, partial);
        }
        break;
      }
      case "content_block_stop": {
        const index = event.index ?? 0;
        const partial = partials.get(index);
        if (partial) {
          const parsed = parseJsonOrEmpty(partial.json);
          const call: ToolCallBlock = {
            type: "tool_call",
            id: partial.id,
            name: partial.name,
            args: parsed.args,
            ...(partial.json ? { raw: partial.json } : {}),
            ...(parsed.error ? { parseError: parsed.error } : {}),
          };
          toolCalls.push(call);
          partials.delete(index);
          yield { type: "tool_call", call };
        }
        break;
      }
      case "message_delta": {
        if (event.delta?.stop_reason) stopReason = mapAnthropicStop(event.delta.stop_reason);
        if (event.usage?.output_tokens) usage.outputTokens = event.usage.output_tokens;
        break;
      }
      case "error": {
        const message = event.error?.message ?? "Unknown Anthropic error";
        yield { type: "error", message, retryable: /overloaded|rate|temporar/i.test(message) };
        return;
      }
      default:
        break;
    }
  }

  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  const cost = estimateCost(request.model, usage);
  if (cost !== undefined) usage.costUsd = cost;
  if (!usage.inputTokens && !usage.outputTokens) {
    usage = {
      inputTokens: estimateConversationTokens([{ role: "system", content: request.system }, ...request.messages.map((message) => ({ role: message.role, content: JSON.stringify(message.blocks) }))]),
      outputTokens: estimateTokens(text + thinking),
    };
  }
  yield { type: "usage", usage };

  yield {
    type: "done",
    stopReason: toolCalls.length ? "tool_use" : stopReason,
    usage,
    text,
    thinking,
    toolCalls,
    // Carried through so `buildAnthropicWire` can echo the signed block back;
    // without it Anthropic rejects the next turn of a tool-use loop.
    ...(signature ? { thinkingSignature: signature } : {}),
    ...(model ? { model } : {}),
  };
}

function parseJsonOrEmpty(raw: string): { args: Record<string, unknown>; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {} };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return { args: value as Record<string, unknown> };
    return { args: { value }, error: "Tool input was not an object" };
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return { args: JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown> };
      } catch {
        // fall through
      }
    }
    return { args: {}, error: `Could not parse tool input: ${trimmed.slice(0, 180)}` };
  }
}

function mapAnthropicStop(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    case "end_turn":
      return "end_turn";
    default:
      return "end_turn";
  }
}
