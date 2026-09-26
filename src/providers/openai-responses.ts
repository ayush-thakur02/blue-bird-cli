import type { ProviderCompat, ProviderDef } from "../config/schema.ts";
import { EFFORT_OPENAI, type Effort } from "../config/schema.ts";
import type { Usage } from "../core/contracts.ts";
import type { Message } from "../core/messages.ts";
import { ProviderError } from "../util/errors.ts";
import { callId } from "../util/ids.ts";
import { dataUrl } from "../util/images.ts";
import { estimateConversationTokens, estimateTokens } from "../util/tokens.ts";
import { estimateCost } from "./openai-chat.ts";
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

interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: { type?: string; text?: string }[];
    role?: string;
  };
  item_id?: string;
  response?: {
    id?: string;
    model?: string;
    output?: ResponsesStreamEvent["item"][];
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
    error?: { message?: string };
  };
  error?: { message?: string; code?: string };
  message?: string;
}

export function createOpenAiResponsesProvider(options: { id: string; def: ProviderDef; apiKey?: string }): Provider {
  const { id, def } = options;
  const compat: ProviderCompat = def.compat ?? {};
  const url = joinUrl(def.baseURL, compat.responsesPath ?? "responses");

  const transport = (signal: AbortSignal): TransportOptions => ({
    signal,
    connectTimeoutMs: def.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT,
    idleTimeoutMs: def.timeoutMs ? Math.max(def.timeoutMs, DEFAULT_IDLE_TIMEOUT) : DEFAULT_IDLE_TIMEOUT,
    retries: def.retries ?? 2,
    providerId: id,
  });

  const headers = () => baseHeaders(def, options.apiKey, "openai-responses");

  async function* stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const disabled = knownUnsupported(id);
    const requestUrl = withQuery(url, { ...(def.query ?? {}), ...(request.model.model.query ?? {}) });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const payload = buildPayload(request, { disabled, compat });
      const response = await postJson({ url: requestUrl, body: payload, headers: headers(), options: transport(request.signal) });

      if (response.status === 400 || response.status === 422 || response.status === 404) {
        const text = await response.text().catch(() => "");
        const lowered = text.toLowerCase();
        let adjustment: string | undefined;
        if (lowered.includes("reasoning") && !disabled.has("reasoning")) adjustment = "reasoning";
        else if (lowered.includes("max_output_tokens") && !disabled.has("max_output_tokens")) adjustment = "max_output_tokens";
        else if (lowered.includes("instructions") && !disabled.has("instructions")) adjustment = "instructions";
        else if (lowered.includes("prompt_cache_retention") && !disabled.has("prompt_cache_retention")) adjustment = "prompt_cache_retention";
        else if (lowered.includes("prompt_cache_key") && !disabled.has("prompt_cache_key")) adjustment = "prompt_cache_key";
        else if (lowered.includes("prompt_cache") && !disabled.has("prompt_cache_key")) adjustment = "prompt_cache_key";
        else if (lowered.includes("prompt_cache") && !disabled.has("prompt_cache_retention")) adjustment = "prompt_cache_retention";
        else if (lowered.includes("store") && !disabled.has("store")) adjustment = "store";
        else if (lowered.includes("parallel_tool_calls") && !disabled.has("parallel_tool_calls")) adjustment = "parallel_tool_calls";
        if (adjustment && attempt < 3) {
          request.logger.debug(`Retrying responses call without ${adjustment}`);
          disabled.add(adjustment);
          rememberUnsupported(id, adjustment);
          continue;
        }
        await ensureOk(new Response(text, { status: response.status, headers: response.headers }), id, "Responses call");
      }

      await ensureOk(response, id, "Responses call");
      yield* parseResponsesStream(response, request, transport(request.signal));
      return;
    }

    throw new ProviderError("Responses call failed after adapting to this endpoint", { provider: id });
  }

  async function listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (def.models?.length) return def.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }));
    return [];
  }

  async function probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const response = await getJson<{ data?: { id?: string }[] }>({
        url: joinUrl(def.baseURL, compat.modelsPath ?? "models"),
        headers: headers(),
        options: transport(signal),
      });
      const models = (response.data ?? []).filter((entry) => Boolean(entry?.id)).map((entry) => entry.id!);
      return {
        ok: true,
        detail: `${models.length} models visible at ${safeHost(url)}`,
        latencyMs: Date.now() - started,
        models: models.slice(0, 30),
      };
    } catch (error) {
      return { ok: false, detail: (error as Error).message, latencyMs: Date.now() - started };
    }
  }

  return { id, api: "openai-responses", def, stream, listModels, probe };
}

export function buildPayload(request: ChatRequest, opts: { disabled: Set<string>; compat: ProviderCompat }): Record<string, unknown> {
  const { disabled, compat } = opts;
  const payload: Record<string, unknown> = {
    model: request.model.model.id,
    input: toResponsesInput(request.messages),
    stream: compat.streaming !== false,
  };

  if (request.system.trim() && !disabled.has("instructions")) payload.instructions = request.system;

  if (request.tools.length && !disabled.has("tools")) {
    payload.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict ? { strict: true } : {}),
    }));
    if (request.toolChoice) payload.tool_choice = request.toolChoice;
    if (compat.parallelToolCalls !== false && !disabled.has("parallel_tool_calls")) {
      payload.parallel_tool_calls = request.parallelToolCalls;
    }
  }

  const effortValue = EFFORT_OPENAI[request.effort as Effort];
  if (effortValue && request.model.model.supportsEffort !== false && !disabled.has("reasoning")) {
    payload.reasoning = { effort: effortValue, summary: "auto" };
  }

  const plan = cachePlan(request.model);
  if (plan.cacheKey && request.cacheKey && !disabled.has("prompt_cache_key")) {
    payload.prompt_cache_key = request.cacheKey;
  }
  if (plan.retention && !disabled.has("prompt_cache_retention")) {
    payload.prompt_cache_retention = plan.retention;
  }

  const maxTokens = request.maxTokens ?? request.model.maxOutput;
  if (maxTokens && !disabled.has("max_output_tokens")) payload.max_output_tokens = maxTokens;
  if (request.temperature !== undefined && !disabled.has("temperature") && !effortValue) {
    payload.temperature = request.temperature;
  }
  // The API default is `store: true`, which keeps your prompts server-side. Blue
  // Bird rebuilds the full input every turn and never uses response ids, so it
  // opts out unless the user asked for retention explicitly.
  if (!disabled.has("store")) payload.store = compat.store ?? false;

  return payload;
}

export function toResponsesInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      const text = message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      const images = message.blocks.filter((block) => block.type === "image").map((block) => block.image);
      const content: unknown[] = [];
      if (text) content.push({ type: "input_text", text });
      for (const image of images) content.push({ type: "input_image", image_url: dataUrl(image) });
      if (content.length) input.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const block of message.blocks) {
        if (block.type !== "tool_call") continue;
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.args ?? {}) });
      }
      continue;
    }

    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      // function_call_output accepts a content array, which lets images through.
      if (block.images?.length) {
        input.push({
          type: "function_call_output",
          call_id: block.id,
          output: [
            { type: "input_text", text: block.content || "(no output)" },
            ...block.images.map((image) => ({ type: "input_image", image_url: dataUrl(image) })),
          ],
        });
        continue;
      }
      input.push({ type: "function_call_output", call_id: block.id, output: block.content || "(no output)" });
    }
  }
  return input;
}

async function* parseResponsesStream(
  response: Response,
  request: ChatRequest,
  options: TransportOptions,
): AsyncGenerator<StreamEvent, void, void> {
  let text = "";
  let thinking = "";
  let stopReason: StopReason = "end_turn";
  let usage: Usage | undefined;
  let model: string | undefined;
  let streamed = false;
  let topLevelError: string | undefined;
  const calls: { id: string; name: string; args: string }[] = [];
  const byItem = new Map<string, { id: string; name: string; args: string }>();

  for await (const event of jsonOrSse<ResponsesStreamEvent>(response, options)) {
    if (event.type) streamed = true;
    // A body like {"error":{"message":"..."}} with no `type` matches no case below.
    else if (!topLevelError) topLevelError = event.error?.message ?? event.message;
    switch (event.type) {
      case "response.output_text.delta": {
        if (event.delta) {
          text += event.delta;
          yield { type: "text", delta: event.delta };
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (event.delta) {
          thinking += event.delta;
          yield { type: "thinking", delta: event.delta };
        }
        break;
      }
      case "response.output_item.added": {
        if (event.item?.type === "function_call") {
          const key = event.item.id ?? event.item.call_id ?? callId();
          const entry = {
            id: event.item.call_id ?? event.item.id ?? callId(),
            name: event.item.name ?? "unknown_tool",
            args: event.item.arguments ?? "",
          };
          byItem.set(key, entry);
          calls.push(entry);
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "";
        const entry = byItem.get(key);
        if (entry && event.delta) entry.args += event.delta;
        break;
      }
      case "response.output_item.done": {
        if (event.item?.type === "function_call") {
          const key = event.item.id ?? event.item.call_id ?? "";
          const entry = byItem.get(key);
          if (entry) {
            if (event.item.arguments) entry.args = event.item.arguments;
            const parsed = parseArgs(entry.args);
            const call = {
              type: "tool_call" as const,
              id: entry.id,
              name: entry.name,
              args: parsed.args,
              ...(entry.args ? { raw: entry.args } : {}),
              ...(parsed.error ? { parseError: parsed.error } : {}),
            };
            yield { type: "tool_call", call };
          }
        }
        break;
      }
      case "response.completed": {
        model = event.response?.model ?? model;
        const raw = event.response?.usage;
        if (raw) {
          usage = {
            inputTokens: raw.input_tokens ?? 0,
            outputTokens: raw.output_tokens ?? 0,
            totalTokens: (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
            ...(raw.input_tokens_details?.cached_tokens ? { cacheReadTokens: raw.input_tokens_details.cached_tokens } : {}),
            ...(raw.output_tokens_details?.reasoning_tokens ? { reasoningTokens: raw.output_tokens_details.reasoning_tokens } : {}),
          };
        }
        for (const item of event.response?.output ?? []) {
          if (item?.type === "function_call" && item.name) {
            const exists = calls.some((call) => call.id === (item.call_id ?? item.id));
            if (!exists) {
              calls.push({ id: item.call_id ?? item.id ?? callId(), name: item.name, args: item.arguments ?? "" });
              const parsed = parseArgs(item.arguments ?? "");
              yield {
                type: "tool_call",
                call: {
                  type: "tool_call",
                  id: item.call_id ?? item.id ?? callId(),
                  name: item.name,
                  args: parsed.args,
                  ...(parsed.error ? { parseError: parsed.error } : {}),
                },
              };
            }
          }
        }
        stopReason = calls.length ? "tool_use" : "end_turn";
        break;
      }
      case "response.incomplete": {
        // An incomplete response still reports usage; discarding it forced a
        // rough estimate for the rest of the session.
        const incompleteUsage = event.response?.usage;
        if (incompleteUsage && !usage) {
          usage = {
            inputTokens: incompleteUsage.input_tokens ?? 0,
            outputTokens: incompleteUsage.output_tokens ?? 0,
            totalTokens: (incompleteUsage.input_tokens ?? 0) + (incompleteUsage.output_tokens ?? 0),
            ...(incompleteUsage.input_tokens_details?.cached_tokens
              ? { cacheReadTokens: incompleteUsage.input_tokens_details.cached_tokens }
              : {}),
            ...(incompleteUsage.output_tokens_details?.reasoning_tokens
              ? { reasoningTokens: incompleteUsage.output_tokens_details.reasoning_tokens }
              : {}),
          };
        }
        stopReason = event.response?.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens";
        break;
      }
      case "response.failed":
      case "error": {
        const message = event.error?.message ?? event.response?.error?.message ?? event.message ?? "Responses API error";
        yield { type: "error", message, retryable: /rate|overload|temporar/i.test(message) };
        return;
      }
      default:
        break;
    }
  }

  // A gateway may answer 200 with a plain JSON error object that carries no
  // `type`, in which case no case above matches and the failure would vanish.
  if (!streamed && topLevelError) {
    yield { type: "error", message: topLevelError, retryable: /rate|overload|temporar/i.test(topLevelError) };
    return;
  }

  if (!usage) {
    usage = {
      inputTokens: estimateConversationTokens([
        { role: "system", content: request.system },
        ...request.messages.map((message) => ({ role: message.role, content: JSON.stringify(message.blocks) })),
      ]),
      outputTokens: estimateTokens(text + thinking),
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  const cost = estimateCost(request.model, usage);
  if (cost !== undefined) usage.costUsd = cost;
  yield { type: "usage", usage };

  yield {
    type: "done",
    stopReason: calls.length ? "tool_use" : stopReason,
    usage,
    text,
    thinking,
    toolCalls: calls.map((call) => {
      const parsed = parseArgs(call.args);
      return {
        type: "tool_call" as const,
        id: call.id,
        name: call.name,
        args: parsed.args,
        ...(parsed.error ? { parseError: parsed.error } : {}),
      };
    }),
    ...(model ? { model } : {}),
  };
}

function parseArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {} };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return { args: value as Record<string, unknown> };
    return { args: {}, error: "Arguments were not a JSON object" };
  } catch {
    return { args: {}, error: `Could not parse arguments: ${trimmed.slice(0, 160)}` };
  }
}
