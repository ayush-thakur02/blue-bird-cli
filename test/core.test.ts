import assert from "node:assert/strict";
import test from "node:test";
import { applyEdit } from "../src/tools/fs.ts";
import { parseTodos } from "../src/tools/todo.ts";
import { parseHookOutput } from "../src/core/hooks.ts";
import { classifyEffort, resolveEffort, shiftEffort } from "../src/core/effort.ts";
import { analyzeContext, compactionPrompt, planCompaction, pruneToolResults, structuralSummary, truncateToolOutput } from "../src/core/context.ts";
import { assistantMessage, messageText, toolCallBlocks, userMessage } from "../src/core/messages.ts";
import { estimateTokens } from "../src/util/tokens.ts";
import { matchesGlob, parseJsonLoose } from "../src/util/text.ts";
import { parseRule, ruleMatches } from "../src/core/permissions.ts";
import { createMockProvider } from "../src/providers/mock.ts";
import { parseToolArguments } from "../src/providers/openai-chat.ts";
import { toAnthropicMessages } from "../src/providers/anthropic.ts";
import { toResponsesInput } from "../src/providers/openai-responses.ts";
import { loadConfig, resolveModel, expandEnv, mergeConfig } from "../src/config/load.ts";

test("applyEdit performs exact, whitespace-tolerant and fuzzy replacements", () => {
  const exact = applyEdit("const a = 1;\nconst b = 2;\n", "const b = 2;", "const b = 3;", false);
  assert.ok(exact.ok);
  assert.match(exact.text, /const b = 3;/);

  const indented = applyEdit("function f() {\n    return 1;\n}\n", "function f() {\nreturn 1;\n}", "function f() {\n  return 2;\n}", false);
  assert.ok(indented.ok, indented.ok ? "" : indented.error);
  assert.match(indented.text, /return 2;/);

  const ambiguous = applyEdit("x\nx\n", "x", "y", false);
  assert.equal(ambiguous.ok, false);

  const all = applyEdit("x\nx\n", "x", "y", true);
  assert.ok(all.ok);
  assert.equal(all.text, "y\ny\n");

  const missing = applyEdit("hello", "not-there", "x", false);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
});

test("edit failures suggest the closest region", () => {
  const content = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const result = applyEdit(content, "line 7\nline 8 changed\nline 9", "x", false);
  assert.equal(result.ok, false);
  assert.ok(result.hint && result.hint.includes("line"), result.hint);
});

test("todo parsing normalizes statuses and rejects bad shapes", () => {
  const todos = parseTodos([
    { content: "do a thing", status: "in_progress" },
    { content: "done thing", status: "completed" },
    { content: "plain string" },
    { nonsense: true },
  ]);
  assert.equal(todos.length, 3);
  assert.equal(todos[0]!.status, "in_progress");
  assert.equal(todos[2]!.status, "pending");
});

test("hook output parsing understands block and context payloads", () => {
  assert.deepEqual(parseHookOutput('{"blocked":true,"reason":"no"}'), { blocked: true, reason: "no" });
  assert.deepEqual(parseHookOutput('{"context":"extra"}'), { context: "extra" });
  assert.equal(parseHookOutput("plain text"), undefined);
});

test("effort classification responds to prompt shape", () => {
  const base = { historyLength: 0, toolCount: 13, planMode: false, continuation: false, repeatedFailures: 0, touchedFiles: 0 };
  assert.equal(classifyEffort({ ...base, prompt: "what does this function do?" }).effort, "minimal");
  assert.equal(classifyEffort({ ...base, prompt: "rename foo to bar" }).effort, "low");
  assert.equal(classifyEffort({ ...base, prompt: "refactor the auth flow and fix the race condition" }).effort, "high");
  assert.equal(classifyEffort({ ...base, prompt: "be very careful and audit this migration" }).effort, "xhigh");
  assert.equal(classifyEffort({ ...base, planMode: true, prompt: "add caching" }).effort, "high");
  assert.equal(resolveEffort("low", { ...base, prompt: "anything" }).effort, "low");
  assert.equal(shiftEffort("medium", 1), "high");
  assert.equal(shiftEffort("none", -1), "none");
});

test("tool output truncation keeps head and tail", () => {
  const long = "a".repeat(5000);
  const result = truncateToolOutput(long, 1000);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length < 1200);
  assert.ok(result.content.includes("characters omitted"));
});

test("context analysis and compaction planning preserve recent turns", () => {
  const messages = [];
  for (let index = 0; index < 12; index += 1) {
    messages.push(userMessage(`request ${index}`));
    messages.push(assistantMessage([{ type: "text", text: `answer ${index}` }]));
    messages.push({
      type: "tool" as const,
      id: `m${index}`,
      role: "tool" as const,
      ts: Date.now(),
      blocks: [{ type: "tool_result" as const, id: `c${index}`, name: "read", content: "x".repeat(2000) }],
    });
  }

  const stats = analyzeContext({ system: "system", messages, contextWindow: 10_000, reserveOutput: 2_000 });
  assert.ok(stats.ratio > 0);
  assert.equal(stats.turns, 12);

  const plan = planCompaction(messages, { keepRecentTurns: 4 });
  assert.ok(plan.fold.length > 0);
  assert.ok(plan.keep.length > 0);
  assert.equal(plan.keep[0]!.role, "user");

  const pruned = pruneToolResults(messages, 4);
  assert.ok(pruned.pruned > 0);
  const summary = structuralSummary(plan.fold);
  assert.match(summary, /Files touched|Requests so far/);
  assert.match(compactionPrompt("transcript"), /handover note/);
});

test("messages expose text and tool calls", () => {
  const assistant = assistantMessage([
    { type: "text", text: "hello" },
    { type: "tool_call", id: "1", name: "read", args: { file_path: "a.ts" } },
  ]);
  assert.equal(messageText(assistant), "hello");
  assert.equal(toolCallBlocks(assistant).length, 1);
});

test("token estimation scales with content", () => {
  const small = estimateTokens("hello world");
  const large = estimateTokens("hello world ".repeat(100));
  assert.ok(large > small * 50);
  assert.ok(small >= 2);
});

test("glob matching handles doublestar, braces and anchoring", () => {
  assert.ok(matchesGlob("**/*.ts", "src/a/b.ts"));
  assert.ok(matchesGlob("src/**/*.ts", "src/a/b.ts"));
  assert.ok(matchesGlob("*.ts", "a.ts"));
  assert.ok(!matchesGlob("*.ts", "src/a.ts"));
  assert.ok(matchesGlob("**/{test,spec}/**", "a/test/b.js"));
  assert.ok(!matchesGlob("**/*.ts", "a/b.js"));
});

test("loose JSON parsing salvages fenced and noisy payloads", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('here you go: {"a":1,}'), { a: 1 });
  assert.equal(parseJsonLoose("nope"), undefined);
});

test("permission rules match tools, commands and paths", () => {
  const rule = parseRule("bash(npm test:*)");
  assert.equal(rule.tool, "bash");
  assert.ok(ruleMatches(rule, { tool: "bash", args: {}, summary: "", risk: "high", readOnly: false, command: "npm test -- --watch" }, "/tmp"));
  assert.ok(!ruleMatches(rule, { tool: "bash", args: {}, summary: "", risk: "high", readOnly: false, command: "rm -rf /" }, "/tmp"));

  const pathRule = parseRule("edit(src/**)");
  assert.ok(
    ruleMatches(pathRule, { tool: "edit", args: {}, summary: "", risk: "medium", readOnly: false, paths: ["/tmp/proj/src/app.ts"] }, "/tmp/proj"),
  );

  const wildcard = parseRule("*");
  assert.ok(ruleMatches(wildcard, { tool: "anything", args: {}, summary: "", risk: "low", readOnly: true }, "/tmp"));
});

test("mock provider is deterministic and scriptable", async () => {
  const provider = createMockProvider({ id: "mock", def: { api: "mock", baseURL: "mock://local", models: [{ id: "m" }] } });
  const model = resolveModel({ version: 1, endpoint: "mock://local", api: "mock", model: "m", providers: { mock: { api: "mock", baseURL: "mock://local", models: [{ id: "m" }] } } }, {});
  const request = {
    sessionId: "s",
    model,
    effort: "medium" as const,
    system: "sys",
    messages: [userMessage('@tool read {"file_path":"a.ts"}')],
    tools: [],
    parallelToolCalls: true,
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => ({ debug() {}, info() {}, warn() {}, error() {}, child: () => ({}) as never }) } as never,
  };

  const events = [];
  for await (const event of provider.stream(request)) events.push(event);
  const done = events.find((event) => event.type === "done") as { toolCalls: { name: string; args: Record<string, unknown> }[] };
  assert.equal(done.toolCalls.length, 1);
  assert.equal(done.toolCalls[0]!.name, "read");
  assert.deepEqual(done.toolCalls[0]!.args, { file_path: "a.ts" });
});

test("tool argument parsing repairs common model mistakes", () => {
  assert.deepEqual(parseToolArguments('{"a":1}').args, { a: 1 });
  assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```').args, { a: 1 });
  assert.deepEqual(parseToolArguments("prefix {\"a\": 1} suffix").args, { a: 1 });
  assert.equal(parseToolArguments("not json").error !== undefined, true);
  assert.deepEqual(parseToolArguments("").args, {});
});

test("wire conversions produce provider-specific shapes", () => {
  const messages = [
    userMessage("do it"),
    assistantMessage([
      { type: "text", text: "ok" },
      { type: "tool_call", id: "c1", name: "read", args: { file_path: "a.ts" } },
    ]),
    {
      type: "tool" as const,
      id: "m1",
      role: "tool" as const,
      ts: Date.now(),
      blocks: [{ type: "tool_result" as const, id: "c1", name: "read", content: "contents" }],
    },
  ];

  const anthropic = toAnthropicMessages(messages);
  assert.equal(anthropic[1]!.content.some((block) => block.type === "tool_use"), true);
  assert.equal(anthropic[2]!.content[0]!.type, "tool_result");

  const responses = toResponsesInput(messages);
  assert.ok(responses.some((entry) => (entry as { type?: string }).type === "function_call"));
  assert.ok(responses.some((entry) => (entry as { type?: string }).type === "function_call_output"));
});

test("config merging layers values and resolves models", () => {
  const merged = mergeConfig(
    { version: 1, endpoint: "https://a/v1", model: "m1" },
    { model: "m2", permissions: { preset: "auto" } },
  );
  assert.equal(merged.endpoint, "https://a/v1");
  assert.equal(merged.model, "m2");

  const model = resolveModel(merged, { provider: "default" });
  assert.equal(model.model.id, "m2");
  assert.equal(model.api, "openai-completions");

  assert.equal(expandEnv("key=${MISSING_VAR:-fallback}"), "key=fallback");
  assert.equal(expandEnv("${HOME}"), process.env.HOME);
});

test("loadConfig raises actionable errors without an endpoint", () => {
  assert.throws(
    () =>
      loadConfig({
        cwd: process.cwd(),
        skipFiles: true,
        env: {},
      }),
    /No model endpoint configured/,
  );
});

test("loadConfig resolves the simple endpoint form from env overrides", () => {
  const env = {
    BLUEBIRD_ENDPOINT: "https://example.test/v1",
    BLUEBIRD_MODEL: "demo-model",
    BLUEBIRD_API_KEY: "secret-key",
    BLUEBIRD_EFFORT: "high",
  } as unknown as NodeJS.ProcessEnv;
  const resolved = loadConfig({ cwd: process.cwd(), skipFiles: true, env });
  assert.equal(resolved.model.model.id, "demo-model");
  assert.equal(resolved.model.apiKey, "secret-key");
  assert.equal(resolved.effort, "high");
  assert.equal(resolved.model.baseURL, "https://example.test/v1");
});
