import type { ProviderDef } from "../config/schema.ts";
import type { Usage } from "../core/contracts.ts";
import { callId } from "../util/ids.ts";
import { estimateTokens } from "../util/tokens.ts";
import type { ChatRequest, ModelInfo, ProbeResult, Provider, StreamEvent } from "./types.ts";

/**
 * Deterministic provider used for tests, demos and `--offline` runs. It never
 * touches the network and reacts to simple directives in the last user message:
 *
 *   @tool read {"file_path":"src/cli.ts"}   emit a tool call
 *   @tools a b                              emit several calls in one turn
 *   @think <text>                           emit reasoning before the answer
 *   @error <text>                           emit a recoverable provider error
 *   @slow                                   stream character by character
 */
export function createMockProvider(options: { id: string; def: ProviderDef; apiKey?: string }): Provider {
  const { id, def } = options;

  async function* stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const prompt = lastUser ? lastUser.blocks.map((block) => (block.type === "text" ? block.text : "")).join("") : "";
    const directives = parseDirectives(prompt);

    yield { type: "start", model: request.model.model.id, providerId: id };

    if (directives.error) {
      yield { type: "error", message: directives.error, retryable: false };
      return;
    }

    for (const chunk of directives.thinking) {
      await pause(request, directives.slow ? 12 : 0);
      yield { type: "thinking", delta: chunk };
    }

    const calls = directives.tools.map((tool) => ({
      type: "tool_call" as const,
      id: callId(),
      name: tool.name,
      args: tool.args,
    }));
    for (const call of calls) yield { type: "tool_call", call };

    const body = calls.length ? `Calling ${calls.map((call) => call.name).join(", ")}.` : composeAnswer(request, prompt, directives);
    let text = "";
    const pieces = directives.slow ? [...body] : splitChunks(body);
    for (const piece of pieces) {
      await pause(request, directives.slow ? 6 : 4);
      text += piece;
      yield { type: "text", delta: piece };
    }

    const usage: Usage = {
      inputTokens: estimateTokens(request.system + prompt),
      outputTokens: estimateTokens(text),
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    yield { type: "usage", usage };

    yield {
      type: "done",
      stopReason: calls.length ? "tool_use" : "end_turn",
      usage,
      text,
      thinking: directives.thinking.join(""),
      toolCalls: calls,
      model: request.model.model.id,
    };
  }

  async function listModels(): Promise<ModelInfo[]> {
    return [{ id: request_model_id(), name: "Mock model", contextWindow: 200_000 }];
  }

  async function probe(): Promise<ProbeResult> {
    return { ok: true, detail: `Mock provider (no network) serving ${request_model_id()}`, latencyMs: 0 };
  }

  function request_model_id(): string {
    return def.models?.[0]?.id ?? "mock-1";
  }

  return { id, api: "mock", def, stream, listModels, probe };
}

async function pause(request: ChatRequest, ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    request.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

interface Directive {
  tools: { name: string; args: Record<string, unknown> }[];
  thinking: string[];
  error?: string;
  slow: boolean;
  echo: boolean;
}

export function parseDirectives(prompt: string): Directive {
  const directive: Directive = { tools: [], thinking: [], slow: false, echo: true };
  const toolMatches = prompt.matchAll(/@tool\s+([A-Za-z_][\w]*)\s*(\{[\s\S]*?\})?/g);
  for (const match of toolMatches) {
    const name = match[1]!;
    let args: Record<string, unknown> = {};
    if (match[2]) {
      try {
        args = JSON.parse(match[2]) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    directive.tools.push({ name, args });
  }
  const bulk = prompt.match(/@tools\s+(.+)/);
  if (bulk?.[1]) {
    for (const name of bulk[1].trim().split(/\s+/)) {
      if (name) directive.tools.push({ name, args: {} });
    }
  }
  const think = prompt.matchAll(/@think\s+([^\n]+)/g);
  for (const match of think) directive.thinking.push(match[1]!.trim());
  const error = prompt.match(/@error\s+([^\n]+)/);
  if (error?.[1]) directive.error = error[1].trim();
  directive.slow = /@slow\b/.test(prompt);
  return directive;
}

function composeAnswer(request: ChatRequest, prompt: string, directive: Directive): string {
  const toolNames = request.tools.map((tool) => tool.name);
  const lines: string[] = [];
  if (/^\/?plan\b/i.test(prompt) || /plan mode/i.test(prompt)) {
    lines.push(`Mock provider — here is a plan.`);
  }
  lines.push(`Received ${request.messages.length} message(s) with ${request.tools.length} tool(s) available.`);

  const images = request.messages.flatMap((message) =>
    message.blocks.flatMap((block) => {
      if (block.type === "image") return [block.image];
      if (block.type === "tool_result") return block.images ?? [];
      return [];
    }),
  );
  if (images.length) {
    lines.push(
      `Looked at ${images.length} image(s): ${images
        .map((image) => `${image.label} ${image.width ?? "?"}×${image.height ?? "?"} ${image.mediaType.replace("image/", "")} (${Math.round(image.bytes / 1024)} KB)`)
        .join(", ")}.`,
    );
  }

  if (prompt.trim()) {
    lines.push("");
    lines.push(`> ${prompt.trim().split("\n")[0]!.slice(0, 160)}`);
  }
  lines.push("");
  lines.push("**Tools on the wire:** " + (toolNames.length ? toolNames.join(", ") : "none"));
  lines.push("");
  lines.push(`Effort: \`${request.effort}\` · model: \`${request.model.model.id}\``);
  if (directive.echo) {
    lines.push("");
    lines.push("Use the direct form to script this provider, e.g. `@tool read {\"file_path\":\"README.md\"}`.");
  }
  return lines.join("\n");
}

function splitChunks(text: string): string[] {
  const chunks: string[] = [];
  const size = 24;
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}
