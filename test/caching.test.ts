import assert from "node:assert/strict";
import test from "node:test";
import { cacheKeyFor, cacheMetrics, cacheMode, cachePlan, formatCacheSummary, hostSupportsCacheKey, isContextOverflow, knownUnsupported, MAX_ANTHROPIC_BREAKPOINTS, rememberUnsupported, resetUnsupported } from "../src/providers/caching.ts";
import { buildPayload as buildAnthropicPayload } from "../src/providers/anthropic.ts";
import { buildPayload as buildOpenAiPayload } from "../src/providers/openai-chat.ts";
import { analyzeContext, planCompaction, pruneToolResults, splitTurns } from "../src/core/context.ts";
import { DEFAULT_CONTEXT_WINDOW, type ResolvedModel } from "../src/config/schema.ts";
import { loadConfig, resolveModel } from "../src/config/load.ts";
import { assistantMessage, userMessage, type Message } from "../src/core/messages.ts";
import { estimateImageTokens } from "../src/util/tokens.ts";

function model(overrides: {
  api?: "openai-completions" | "anthropic-messages";
  baseURL?: string;
  compat?: Record<string, unknown>;
  contextWindow?: number;
} = {}): ResolvedModel {
  const api = overrides.api ?? "openai-completions";
  const baseURL = overrides.baseURL ?? "https://api.openai.com/v1";
  return {
    providerId: "test",
    provider: { api, baseURL, compat: overrides.compat ?? {} },
    model: { id: "test-model", contextWindow: overrides.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxOutput: 64_000 },
    api,
    baseURL,
    apiKeySource: "env",
    contextWindow: overrides.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutput: 64_000,
    label: `test/test-model`,
  } as unknown as ResolvedModel;
}

function request(resolved: ResolvedModel, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    model: resolved,
    effort: "medium" as const,
    system: "You are Blue Bird.",
    messages: [
      userMessage("first turn"),
      assistantMessage([{ type: "text", text: "ack" }]),
      userMessage("second turn"),
      assistantMessage([{ type: "text", text: "ack again" }]),
    ],
    tools: [
      { name: "read", description: "read a file", parameters: { type: "object" as const } },
      { name: "grep", description: "search", parameters: { type: "object" as const } },
    ],
    parallelToolCalls: true,
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as never,
    cacheKey: cacheKeyFor("session-1", "test-model"),
    ...overrides,
  };
}

test("cache policy is chosen per host and dialect", () => {
  assert.equal(cacheMode({}), "auto");
  assert.equal(cacheMode({ promptCache: false }), "off");
  assert.equal(cacheMode({ promptCache: true }), "on");

  assert.ok(hostSupportsCacheKey("https://api.openai.com/v1"));
  assert.ok(hostSupportsCacheKey("https://my-openai.openai.azure.com/openai/v1"));
  assert.ok(!hostSupportsCacheKey("http://localhost:11434/v1"));

  const anthropic = cachePlan(model({ api: "anthropic-messages", baseURL: "https://api.anthropic.com" }));
  assert.equal(anthropic.breakpoints, true);
  assert.equal(anthropic.tailBreakpoints, 2);
  assert.equal(anthropic.cacheKey, false, "anthropic uses cache_control, not a cache key");

  const openai = cachePlan(model());
  assert.equal(openai.breakpoints, false);
  assert.equal(openai.cacheKey, true);
  assert.equal(openai.retention, "24h");

  // The cache key is attempted on unknown hosts too; a rejection is remembered
  // instead of being retried on every turn.
  const local = cachePlan(model({ baseURL: "http://localhost:8000/v1" }));
  assert.equal(local.cacheKey, true);
  assert.equal(local.retention, undefined, "extended retention stays limited to known hosts");

  const off = cachePlan(model({ compat: { promptCache: false } }));
  assert.equal(off.cacheKey, false);
  assert.equal(off.breakpoints, false);
});

test("rejected parameters are remembered per provider", () => {
  resetUnsupported();
  assert.equal(knownUnsupported("gateway").size, 0);
  rememberUnsupported("gateway", "prompt_cache_key");
  assert.ok(knownUnsupported("gateway").has("prompt_cache_key"));
  assert.equal(knownUnsupported("other").size, 0);
  resetUnsupported("gateway");
  assert.equal(knownUnsupported("gateway").size, 0);
});

test("anthropic payload uses at most four cache breakpoints", () => {
  const payload = buildAnthropicPayload(request(model({ api: "anthropic-messages", baseURL: "https://api.anthropic.com" })), {
    disabled: new Set(),
    useCache: true,
    streaming: true,
    tailBreakpoints: 2,
  }) as Record<string, never>;

  const markers: string[] = [];
  const system = payload.system as { cache_control?: unknown }[];
  if (system[0]?.cache_control) markers.push("system");
  const tools = payload.tools as { cache_control?: unknown }[];
  if (tools[tools.length - 1]?.cache_control) markers.push("tools");
  const messages = payload.messages as { content: { cache_control?: unknown }[] }[];
  for (const message of messages) {
    if (message.content[message.content.length - 1]?.cache_control) markers.push("tail");
  }

  assert.deepEqual(markers, ["system", "tools", "tail", "tail"]);
  assert.ok(markers.length <= MAX_ANTHROPIC_BREAKPOINTS);
});

test("anthropic payload omits cache markers when disabled", () => {
  const payload = buildAnthropicPayload(request(model({ api: "anthropic-messages", baseURL: "https://api.anthropic.com" })), {
    disabled: new Set(),
    useCache: false,
    streaming: true,
  }) as Record<string, never>;
  const system = payload.system as { cache_control?: unknown }[];
  const tools = payload.tools as { cache_control?: unknown }[];
  assert.equal(system[0]?.cache_control, undefined);
  assert.equal(tools[0]?.cache_control, undefined);
  for (const message of payload.messages as { content: { cache_control?: unknown }[] }[]) {
    for (const block of message.content) assert.equal(block.cache_control, undefined);
  }
});

test("openai payload sends a stable cache key only where supported", () => {
  const resolved = model();
  const payload = buildOpenAiPayload(request(resolved), {
    compat: resolved.provider.compat ?? {},
    disabled: new Set(),
    maxTokensParam: "max_tokens",
    parallelToolCalls: true,
  }) as Record<string, unknown>;
  assert.equal(typeof payload.prompt_cache_key, "string");
  assert.match(String(payload.prompt_cache_key), /^bb-[0-9a-f]+$/);
  assert.equal(payload.prompt_cache_retention, "24h");

  const localResolved = model({ baseURL: "http://localhost:8000/v1" });
  const localPayload = buildOpenAiPayload(request(localResolved), {
    compat: {},
    disabled: new Set(),
    maxTokensParam: "max_tokens",
    parallelToolCalls: true,
  }) as Record<string, unknown>;
  assert.equal(typeof localPayload.prompt_cache_key, "string", "the cache key is still attempted");
  assert.equal(localPayload.prompt_cache_retention, undefined);

  const disabledPayload = buildOpenAiPayload(request(localResolved), {
    compat: {},
    disabled: new Set(["prompt_cache_key"]),
    maxTokensParam: "max_tokens",
    parallelToolCalls: true,
  }) as Record<string, unknown>;
  assert.equal(disabledPayload.prompt_cache_key, undefined, "a remembered rejection suppresses the field");
});

test("cache keys are stable per session and distinct per model", () => {
  const a = cacheKeyFor("session-1", "gpt-5");
  assert.equal(a, cacheKeyFor("session-1", "gpt-5"));
  assert.notEqual(a, cacheKeyFor("session-2", "gpt-5"));
  assert.notEqual(a, cacheKeyFor("session-1", "claude-sonnet-4-5"));
  assert.ok(a.length <= 64);
});

test("cache metrics report hit ratios", () => {
  const metrics = cacheMetrics({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 1000 });
  assert.equal(metrics.readTokens, 9000);
  assert.equal(metrics.writeTokens, 1000);
  assert.ok(Math.abs(metrics.hitRatio - 9000 / 11000) < 0.0001);
  assert.match(String(formatCacheSummary({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 400 })), /cache 80%/);
  assert.equal(formatCacheSummary({ inputTokens: 100, outputTokens: 1 }), undefined);
});

test("context overflow detection catches provider wording", () => {
  assert.ok(isContextOverflow("This model's maximum context length is 128000 tokens", 400));
  assert.ok(isContextOverflow("prompt is too long: 250000 tokens > 200000 maximum"));
  assert.ok(isContextOverflow("context_length_exceeded"));
  assert.ok(isContextOverflow("Please reduce the length of the messages.", 400));
  assert.ok(!isContextOverflow("invalid api key", 401));
  assert.ok(!isContextOverflow("unknown parameter reasoning_effort", 400));
});

test("the default context window is one million tokens", () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 1_000_000);
  const raw = {
    version: 1,
    endpoint: "https://host/v1",
    model: "gpt-5.6-terra",
    providers: { default: { api: "openai-completions" as const, baseURL: "https://host/v1", models: [{ id: "gpt-5.6-terra" }] } },
  };
  const warnings: string[] = [];
  const resolved = resolveModel(raw, { env: {} as NodeJS.ProcessEnv }, warnings);
  assert.equal(resolved.contextWindow, 1_000_000);
  assert.equal(resolved.model.assumedWindow, true);
  assert.match(warnings.join(" "), /Assuming a 1M token context window/);
});

test("declared windows win, and context.assumeWindow overrides the default", () => {
  const declared = resolveModel(
    {
      version: 1,
      endpoint: "https://host/v1",
      model: "small",
      contextWindow: 200_000,
      providers: { default: { api: "openai-completions", baseURL: "https://host/v1", models: [{ id: "small", contextWindow: 128_000 }] } },
    },
    { env: {} as NodeJS.ProcessEnv },
    [],
  );
  assert.equal(declared.contextWindow, 128_000);
  assert.equal(declared.model.assumedWindow, false);

  const assumed = resolveModel(
    {
      version: 1,
      endpoint: "https://host/v1",
      model: "mystery",
      context: { assumeWindow: 32_000, compactAt: 0.8, compaction: "auto", keepRecentTurns: 6, maxToolOutputChars: 1000, pruneStaleToolOutputs: true, reserveOutputTokens: 1000 },
      providers: { default: { api: "openai-completions", baseURL: "https://host/v1" } },
    },
    { env: {} as NodeJS.ProcessEnv },
    [],
  );
  assert.equal(assumed.contextWindow, 32_000);

  const fromEnv = resolveModel(
    { version: 1, endpoint: "https://host/v1", model: "mystery" },
    { env: { BLUEBIRD_CONTEXT_WINDOW: "64000" } as unknown as NodeJS.ProcessEnv },
    [],
  );
  assert.equal(fromEnv.contextWindow, 64_000);
});

test("a 1M window defers compaction and still plans it correctly", () => {
  const messages: Message[] = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push(userMessage(`task ${index} ${"context ".repeat(200)}`));
    messages.push(assistantMessage([{ type: "text", text: `done ${index} ${"result ".repeat(200)}` }]));
  }

  const big = analyzeContext({ system: "system prompt", messages, contextWindow: 1_000_000, reserveOutput: 16_000 });
  assert.ok(big.ratio < 0.2, `expected plenty of room, got ${big.ratio}`);
  assert.equal(big.contextWindow, 1_000_000);

  const small = analyzeContext({ system: "system prompt", messages, contextWindow: 60_000, reserveOutput: 16_000 });
  assert.ok(small.ratio > big.ratio);

  assert.equal(splitTurns(messages).length, 20);
  const plan = planCompaction(messages, { keepRecentTurns: 6 });
  assert.equal(plan.recentTurns, 6);
  assert.ok(plan.fold.length > 0);
});

test("pruning drops stale tool output and attached images", () => {
  const messages: Message[] = [];
  for (let index = 0; index < 8; index += 1) {
    messages.push(userMessage(`turn ${index}`));
    messages.push({
      id: `m${index}`,
      role: "tool",
      ts: Date.now(),
      blocks: [
        {
          type: "tool_result",
          id: `c${index}`,
          name: "view_image",
          content: "x".repeat(2000),
          images: [{ id: `img${index}`, label: "shot.png", mediaType: "image/png", data: "AAAA", bytes: 4, width: 10, height: 10 }],
        },
      ],
    });
  }
  const { messages: pruned, pruned: count } = pruneToolResults(messages, 2);
  assert.ok(count > 0);
  const firstTool = pruned.find((message) => message.role === "tool")!;
  const block = firstTool.blocks[0] as { images?: unknown[]; content: string };
  assert.equal(block.images, undefined, "images are dropped from stale results");
  assert.match(block.content, /elided/);
});

test("images count toward the context budget", () => {
  const png = { id: "i", label: "big.png", mediaType: "image/png" as const, data: "A".repeat(100), bytes: 100, width: 1600, height: 1200 };
  const withImage: Message[] = [
    { id: "u1", role: "user", ts: Date.now(), blocks: [{ type: "text", text: "look" }, { type: "image", image: png }] },
  ];
  const withoutImage: Message[] = [
    { id: "u1", role: "user", ts: Date.now(), blocks: [{ type: "text", text: "look" }] },
  ];
  const a = analyzeContext({ system: "", messages: withImage, contextWindow: 1_000_000, reserveOutput: 1000 });
  const b = analyzeContext({ system: "", messages: withoutImage, contextWindow: 1_000_000, reserveOutput: 1000 });
  assert.ok(a.messageTokens - b.messageTokens >= estimateImageTokens(1600, 1200) - 5);
});

test("loadConfig exposes the assumed window in resolved config", () => {
  const env = {
    BLUEBIRD_ENDPOINT: "https://example.test/v1",
    BLUEBIRD_MODEL: "mystery-model",
  } as unknown as NodeJS.ProcessEnv;
  const resolved = loadConfig({ cwd: process.cwd(), skipFiles: true, env });
  assert.equal(resolved.model.contextWindow, 1_000_000);
  assert.ok(resolved.raw.context?.assumeWindow === 1_000_000);
  assert.equal(resolved.raw.images?.enabled, true);
  assert.equal(resolved.raw.images?.maxBytes, 5_000_000);
});
