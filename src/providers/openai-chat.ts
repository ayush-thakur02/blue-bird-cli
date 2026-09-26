import type { ProviderDef, ProviderCompat, ResolvedModel } from "../config/schema.ts";
import type { Usage } from "../core/contracts.ts";
import type { ImageAttachment, Message, ToolCallBlock } from "../core/messages.ts";
import { ProviderError } from "../util/errors.ts";
import { callId } from "../util/ids.ts";
import { dataUrl } from "../util/images.ts";
import { estimateConversationTokens, estimateTokens } from "../util/tokens.ts";
import { cachePlan, knownUnsupported, rememberUnsupported } from "./caching.ts";
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

interface WireToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role: string;
  content?: string | null | WireContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string | { type?: string; text?: string }[] | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
      tool_calls?: WireToolCall[];
    };
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
      tool_calls?: WireToolCall[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    /** DeepSeek reports cache hits separately. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | null;
  error?: { message?: string; type?: string; code?: string | number };
}

const COMPAT_FIELDS = [
  "reasoning_effort",
  "stream_options",
  "parallel_tool_calls",
  "tool_choice",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  "store",
  "prompt_cache_key",
  "prompt_cache_retention",
  "tools",
] as const;
type CompatField = (typeof COMPAT_FIELDS)[number];

export interface OpenAiChatOptions {
  id: string;
  def: ProviderDef;
  apiKey?: string;
  compat?: ProviderCompat;
}

export function createOpenAiChatProvider(options: OpenAiChatOptions): Provider {
  const { id, def } = options;
  const compat = options.compat ?? def.compat ?? {};
  const chatPath = compat.chatPath ?? (def.baseURL.includes("/chat/completions") ? "" : "chat/completions");
  const modelsPath = compat.modelsPath ?? "models";
  const url = def.baseURL.includes("/chat/completions") ? def.baseURL : joinUrl(def.baseURL, chatPath);

  const transport = (signal: AbortSignal, overrides?: Partial<TransportOptions>): TransportOptions => ({
    signal,
    connectTimeoutMs: def.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT,
    idleTimeoutMs: def.timeoutMs ? Math.max(def.timeoutMs, DEFAULT_IDLE_TIMEOUT) : DEFAULT_IDLE_TIMEOUT,
    retries: def.retries ?? 2,
    providerId: id,
    ...overrides,
  });

  const headers = () => baseHeaders(def, options.apiKey, "openai-completions");

  async function* stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const disabled = knownUnsupported(id);
    let maxTokensParam: "max_tokens" | "max_completion_tokens" = (compat.maxTokensParam as never) ?? "max_tokens";
    const maxAttempts = 4;
    const requestUrl = withQuery(url, {
      ...(def.query ?? {}),
      ...(request.model.model.query ?? {}),
    });

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const payload = buildPayload(request, {
        compat,
        disabled,
        maxTokensParam,
        parallelToolCalls: request.parallelToolCalls,
      });
      const response = await postJson({
        url: requestUrl,
        body: payload,
        headers: headers(),
        options: transport(request.signal),
      });

      if (response.status === 400 || response.status === 422 || response.status === 404) {
        const text = await response.text().catch(() => "");
        const adjustment = diagnose(text, disabled, maxTokensParam);
        if (adjustment && attempt < maxAttempts - 1) {
          request.logger.debug(`Retrying ${safeHost(url)} without ${adjustment}`, { status: response.status });
          if (adjustment === "max_completion_tokens") maxTokensParam = "max_completion_tokens";
          else {
            disabled.add(adjustment);
            rememberUnsupported(id, adjustment);
          }
          continue;
        }
        await ensureOk(new Response(text, { status: response.status, headers: response.headers }), id, "Chat completion");
      }

      await ensureOk(response, id, "Chat completion");

      const modelId = response.headers.get("x-model") ?? request.model.model.id;
      yield { type: "start", model: modelId, providerId: id };
      yield* parseChatStream(response, request, transport(request.signal));
      return;
    }

    throw new ProviderError("Chat completion failed after adapting the request to this endpoint", {
      provider: id,
      hint:
        `Run \`bluebird doctor\` to check the endpoint, or set providers.${id}.compat fields to match your gateway.`,
    });
  }

  async function listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (def.models?.length) return def.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }));
    const response = await getJson<{ data?: { id?: string; owned_by?: string }[] }>({
      url: joinUrl(def.baseURL, modelsPath),
      headers: headers(),
      options: transport(signal, { connectTimeoutMs: 20_000 }),
    });
    return (response.data ?? [])
      .filter((entry): entry is { id: string; owned_by?: string } => Boolean(entry?.id))
      .map((entry) => ({ id: entry.id, ownedBy: entry.owned_by }));
  }

  async function probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const models = await listModels(signal);
      return {
        ok: true,
        detail: `${models.length} model${models.length === 1 ? "" : "s"} available at ${safeHost(url)}`,
        latencyMs: Date.now() - started,
        models: models.slice(0, 30).map((model) => model.id),
      };
    } catch (error) {
      return { ok: false, detail: (error as Error).message, latencyMs: Date.now() - started };
    }
  }

  return { id, api: "openai-completions", def, stream, listModels, probe };
}

export function buildPayload(
  request: ChatRequest,
  opts: { compat: ProviderCompat; disabled: Set<string>; maxTokensParam: "max_tokens" | "max_completion_tokens"; parallelToolCalls: boolean },
): Record<string, unknown> {
  const { compat, disabled, maxTokensParam } = opts;
  const payload: Record<string, unknown> = {
    model: request.model.model.id,
    messages: toWireMessages(request.system, request.messages, disabled),
    stream: compat.streaming !== false,
  };
  if (payload.stream && compat.streamUsage !== false && !disabled.has("stream_options")) {
    payload.stream_options = { include_usage: true };
  }

  if (request.tools.length && !disabled.has("tools")) {
    payload.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.strict ? { strict: true } : {}),
      },
    }));
    if (request.toolChoice && !disabled.has("tool_choice")) {
      payload.tool_choice = request.toolChoice === "required" ? "required" : request.toolChoice;
    }
    if (compat.parallelToolCalls !== false && !disabled.has("parallel_tool_calls")) {
      payload.parallel_tool_calls = opts.parallelToolCalls;
    }
  }

  const effortParam = compat.effortParam === null ? null : (compat.effortParam ?? "reasoning_effort");
  const effortValue = effortToApi(request.effort);
  const supportsEffort = request.model.model.supportsEffort !== false;
  if (effortParam && effortValue && supportsEffort && !disabled.has("reasoning_effort")) {
    if (compat.effortObject) payload.reasoning = { effort: effortValue };
    else payload[effortParam] = effortValue;
  }

  const plan = cachePlan(request.model);
  if (plan.cacheKey && request.cacheKey && !disabled.has("prompt_cache_key")) {
    payload.prompt_cache_key = request.cacheKey;
  }
  if (plan.retention && !disabled.has("prompt_cache_retention")) {
    payload.prompt_cache_retention = plan.retention;
  }

  const maxTokens = request.maxTokens ?? request.model.maxOutput;
  if (maxTokens && !disabled.has(maxTokensParam)) {
    payload[maxTokensParam] = maxTokens;
  }

  if (request.temperature !== undefined && !disabled.has("temperature")) {
    payload.temperature = request.temperature;
  }

  return payload;
}

export function toWireMessages(system: string, messages: Message[], disabled: Set<string>): WireMessage[] {
  const wire: WireMessage[] = [];
  if (system.trim()) wire.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      if (text.trim()) wire.push({ role: "system", content: text });
      continue;
    }

    if (message.role === "user") {
      const text = message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      const images = message.blocks.filter((block) => block.type === "image").map((block) => block.image);
      if (images.length) {
        wire.push({ role: "user", content: imageParts(text, images) });
        continue;
      }
      if (text) wire.push({ role: "user", content: text });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      const calls = message.blocks.filter((block): block is ToolCallBlock => block.type === "tool_call");
      if (!text && calls.length === 0) continue;
      const entry: WireMessage = { role: "assistant", content: text || null };
      if (calls.length) {
        entry.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      wire.push(entry);
      continue;
    }

    // Tool results can only carry text on this dialect, so any images the tool
    // produced ride along in an immediately following user message.
    const trailingImages: ImageAttachment[] = [];
    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      wire.push({
        role: "tool",
        tool_call_id: block.id,
        name: block.name,
        content: block.content || "(no output)",
      });
      if (block.images?.length) trailingImages.push(...block.images);
    }
    if (trailingImages.length) {
      wire.push({
        role: "user",
        content: imageParts(`Images returned by the ${message.blocks[0]?.type === "tool_result" ? (message.blocks[0] as { name?: string }).name ?? "tool" : "tool"} call above:`, trailingImages),
      });
    }
  }

  return wire;
}

function imageParts(text: string, images: readonly ImageAttachment[]): WireContentPart[] {
  const parts: WireContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) parts.push({ type: "text", text: trimmed });
  for (const image of images) {
    parts.push({
      type: "image_url",
      image_url: {
        url: dataUrl(image),
        ...(image.detail ? { detail: image.detail } : {}),
      },
    });
  }
  return parts;
}

async function* parseChatStream(
  response: Response,
  request: ChatRequest,
  options: TransportOptions,
): AsyncGenerator<StreamEvent, void, void> {
  let text = "";
  let thinking = "";
  const pending = new Map<number, { id: string; name: string; args: string }>();
  const emitted: ToolCallBlock[] = [];
  let stopReason: StopReason = "end_turn";
  let usage: Usage | undefined;
  let model: string | undefined;

  const finishCalls = (): ToolCallBlock[] => {
    const calls: ToolCallBlock[] = [];
    const entries = [...pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, entry] of entries) {
      const call = finalizeCall(entry, index);
      calls.push(call);
      emitted.push(call);
    }
    pending.clear();
    return calls;
  };

  for await (const chunk of jsonOrSse<ChatChunk>(response, options)) {
    if (chunk.error) {
      const message = chunk.error.message ?? JSON.stringify(chunk.error);
      yield { type: "error", message, retryable: /rate|overload|temporar|timeout/i.test(message) };
      return;
    }
    if (chunk.model) model = chunk.model;

    if (chunk.usage) {
      usage = normalizeUsage(chunk.usage, request);
      yield { type: "usage", usage };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta ?? choice.message;
    if (delta) {
      const content = flattenContent(delta.content);
      if (content) {
        text += content;
        yield { type: "text", delta: content };
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (reasoning) {
        thinking += reasoning;
        yield { type: "thinking", delta: reasoning };
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? pending.size;
        const existing = pending.get(index) ?? { id: call.id ?? callId(), name: "", args: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        if (call.function?.arguments) existing.args += call.function.arguments;
        pending.set(index, existing);
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
      const calls = finishCalls();
      for (const call of calls) yield { type: "tool_call", call };
      if (calls.length) stopReason = "tool_use";
    }
  }

  if (pending.size) {
    for (const call of finishCalls()) yield { type: "tool_call", call };
    stopReason = "tool_use";
  }

  if (!usage) {
    usage = estimateUsage(request, text, thinking);
    yield { type: "usage", usage };
  }

  yield {
    type: "done",
    stopReason,
    usage,
    text,
    thinking,
    toolCalls: emitted,
    ...(model ? { model } : {}),
  };
}

function finalizeCall(entry: { id: string; name: string; args: string }, _index: number): ToolCallBlock {
  const raw = entry.args.trim();
  const parsed = parseToolArguments(raw);
  const call: ToolCallBlock = {
    type: "tool_call",
    id: entry.id,
    name: entry.name || "unknown_tool",
    args: parsed.args,
    ...(raw ? { raw } : {}),
    ...(parsed.error ? { parseError: parsed.error } : {}),
  };
  return call;
}

export function parseToolArguments(raw: string): { args: Record<string, unknown>; error?: string } {
  if (!raw) return { args: {} };
  const candidates: string[] = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { args: value as Record<string, unknown> };
      }
    } catch {
      const repaired = candidate
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
      try {
        const value = JSON.parse(repaired) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return { args: value as Record<string, unknown> };
        }
      } catch {
        continue;
      }
    }
  }
  return { args: {}, error: `Could not parse tool arguments as JSON: ${raw.slice(0, 180)}` };
}

export function flattenContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

function normalizeUsage(
  usage: NonNullable<ChatChunk["usage"]>,
  request: ChatRequest,
): Usage {
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const result: Usage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.total_tokens ?? input + output,
  };

  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  if (cached) result.cacheReadTokens = cached;
  const written = usage.prompt_tokens_details?.cache_write_tokens;
  if (written) result.cacheWriteTokens = written;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning) result.reasoningTokens = reasoning;

  const cost = estimateCost(request.model, result);
  if (cost !== undefined) result.costUsd = cost;
  return result;
}

export function estimateUsage(request: ChatRequest, text: string, thinking: string): Usage {
  const inputTokens = estimateConversationTokens([
    { role: "system", content: request.system },
    ...request.messages.map((message) => {
      const text = message.blocks
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_result") return block.content;
          return "";
        })
        .join("");
      return {
        role: message.role,
        content: text,
        toolCalls: message.blocks.filter((block) => block.type === "tool_call").length,
      };
    }),
  ]);
  const outputTokens = estimateTokens(text + thinking);
  const usage: Usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  const cost = estimateCost(request.model, usage);
  if (cost !== undefined) usage.costUsd = cost;
  return usage;
}

export function estimateCost(model: ResolvedModel, usage: Usage): number | undefined {
  const pricing = model.pricing;
  if (!pricing) return undefined;
  const input = (usage.inputTokens / 1_000_000) * pricing.input;
  const output = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheRead = ((usage.cacheReadTokens ?? 0) / 1_000_000) * (pricing.cacheRead ?? pricing.input);
  return input + output + cacheRead;
}

export function effortToApi(effort: string): string | undefined {
  switch (effort) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
    case "end_turn":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function diagnose(
  body: string,
  disabled: Set<string>,
  maxTokensParam: "max_tokens" | "max_completion_tokens",
): CompatField | "max_completion_tokens" | undefined {
  const lowered = body.toLowerCase();
  const looksStructural =
    /unknown|unsupported|not supported|unrecognized|invalid|extra inputs|unexpected|must use|does not support|deprecated/.test(lowered) ||
    /param/.test(lowered);
  if (!looksStructural) return undefined;

  if (lowered.includes("max_completion_tokens") && maxTokensParam !== "max_completion_tokens") {
    return "max_completion_tokens";
  }

  for (const field of COMPAT_FIELDS) {
    if (field === "max_tokens" || field === "max_completion_tokens") continue;
    if (!lowered.includes(field)) continue;
    if (field === "reasoning_effort" && disabled.has("reasoning_effort")) continue;
    if (!disabled.has(field)) return field;
  }

  if (lowered.includes("tools") && !disabled.has("tools")) return "tools";
  return undefined;
}
