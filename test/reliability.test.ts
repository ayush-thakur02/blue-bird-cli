import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsPath, realPathOfExistingPrefix } from "../src/util/paths.ts";
import { parseArgs, flagBool, flagString } from "../src/cli/args.ts";
import { retryAfterMs } from "../src/providers/transport.ts";
import { validateArgs } from "../src/tools/args.ts";
import { hasNestedQuantifier } from "../src/tools/search.ts";
import { CheckpointManager } from "../src/core/checkpoint.ts";
import { applyEdit } from "../src/tools/fs.ts";
import { visibleWidth, sliceVisible, truncateVisible, charWidth } from "../src/ui/ansi.ts";
import { previousGraphemeStart, nextGraphemeEnd, layoutLines } from "../src/ui/input.ts";
import { Runtime } from "../src/runtime.ts";

function tempDir(prefix = "bb-reliability-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withWorkspace(fn: (args: { root: string; runtime: Runtime }) => Promise<void>): Promise<void> {
  const root = tempDir();
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      provider: "mock",
      model: "mock-1",
      providers: { mock: { api: "mock", baseURL: "http://127.0.0.1:1", models: [{ id: "mock-1" }] } },
      permissions: { preset: "danger-full-access", allowDangerous: true },
      sessions: { persist: false },
    }),
  );
  const runtime = await Runtime.create({ cwd: root, configPath, headless: true, maxTurns: 1 });
  try {
    await fn({ root, runtime });
  } finally {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("containsPath is symlink-aware", () => {
  const root = tempDir();
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");

  const inside = path.join(root, "src");
  fs.mkdirSync(inside);
  assert.equal(containsPath(root, path.join(inside, "index.ts")), true, "plain path inside the workspace is allowed");
  assert.equal(containsPath(root, path.join(root, "not-created-yet.ts")), true, "a file that does not exist yet is allowed");

  const link = path.join(root, "escape");
  fs.symlinkSync(outside, link, "dir");
  const escaped = path.join(link, "secret.txt");
  assert.equal(containsPath(root, escaped), false, "a symlink pointing outside the workspace must not pass containment");
  // The lexical check accepted this, which is exactly the hole being closed.
  assert.equal(escaped.startsWith(root), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("realPathOfExistingPrefix resolves a missing tail through its real parent", () => {
  const root = tempDir();
  const real = fs.realpathSync(root);
  assert.equal(realPathOfExistingPrefix(path.join(root, "a", "b", "c.ts")), path.join(real, "a", "b", "c.ts"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("hasNestedQuantifier rejects catastrophic patterns but allows ordinary ones", () => {
  assert.equal(hasNestedQuantifier("(a+)+$"), true);
  assert.equal(hasNestedQuantifier("(.*)*x"), true);
  assert.equal(hasNestedQuantifier("(\\w*){2,}"), true);
  assert.equal(hasNestedQuantifier("(foo|bar)+"), false);
  assert.equal(hasNestedQuantifier("function\\s+\\w+"), false);
  assert.equal(hasNestedQuantifier("a+b*c?"), false);
});

test("validateArgs enforces types and enums but tolerates coercible values", () => {
  const schema = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const },
      limit: { type: "number" as const },
      output_mode: { type: "string" as const, enum: ["content", "count"] },
      flag: { type: "boolean" as const },
    },
    required: ["file_path"],
  };
  assert.deepEqual(validateArgs(schema, { file_path: "a.ts" }, "t"), []);
  // Coercible by the arg helpers, so not an error.
  assert.deepEqual(validateArgs(schema, { file_path: "a.ts", limit: "10", flag: "yes" }, "t"), []);
  // null is treated as absent everywhere else, so it is not a type error.
  assert.deepEqual(validateArgs(schema, { file_path: "a.ts", limit: null }, "t"), []);
  assert.equal(validateArgs(schema, {}, "t").length, 1);
  assert.equal(validateArgs(schema, { file_path: "a.ts", limit: {} }, "t")[0]?.message, "expected a number");
  assert.equal(validateArgs(schema, { file_path: "a.ts", flag: "maybe" }, "t")[0]?.message, "expected a boolean");
  assert.match(validateArgs(schema, { file_path: "a.ts", output_mode: "bogus" }, "t")[0]?.message ?? "", /must be one of/);
});

test("--no-* flags are readable under the name the user typed", () => {
  const args = parseArgs(["--no-memory", "--no-subagents", "--no-color", "run", "hello"]);
  assert.equal(flagBool(args, "no-memory"), true);
  assert.equal(flagBool(args, "no-subagents"), true);
  assert.equal(flagBool(args, "no-color"), true);
  assert.equal(flagBool(args, "memory"), false);
  assert.equal(args.command, "run");
  assert.equal(flagBool(parseArgs(["--no-memory=false"]), "memory"), true);
});

test("short flags cluster and negative numbers are consumed as values", () => {
  const cluster = parseArgs(["-qy", "run", "x"]);
  assert.equal(flagBool(cluster, "quiet"), true);
  assert.equal(flagBool(cluster, "yes"), true);

  assert.equal(flagString(parseArgs(["run", "x", "--max-turns", "-1"]), "max-turns"), "-1");
  assert.equal(flagString(parseArgs(["--max-turns=5"]), "max-turns"), "5");
});

test("retryAfterMs reads seconds and dates from response headers", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" }), 999), 2000);
  assert.equal(retryAfterMs(new Headers({}), 999), 999);
  assert.equal(retryAfterMs(undefined), undefined);
  const value = retryAfterMs(new Headers({ "retry-after": new Date(Date.now() + 3000).toUTCString() }), 0);
  assert.ok(value !== undefined && value > 500 && value <= 3000, `unexpected delay ${value}`);
});

test("emoji, variation selectors and ZWJ sequences measure as one glyph", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("日本"), 4);
  assert.equal(visibleWidth("🚀"), 2, "transport-plane emoji used to count as width 1");
  assert.equal(visibleWidth("⭐"), 2);
  assert.equal(visibleWidth("👨‍👩‍👧"), 2, "a ZWJ family is one glyph, not four");
  assert.equal(visibleWidth("🏳️‍🌈"), 2);
  assert.equal(charWidth(0x2764), 1, "text presentation without the selector stays narrow");
  assert.equal(visibleWidth("❤️"), 2, "the emoji-presentation selector widens it");
});

test("slicing never splits a surrogate pair or a joined glyph", () => {
  assert.equal(sliceVisible("a🚀b", 1, 2), "🚀");
  assert.equal(sliceVisible("x👨‍👩‍👧y", 1, 2), "👨‍👩‍👧");
  assert.equal(visibleWidth(truncateVisible("🚀🚀🚀", 3)), 3);
});

test("grapheme steps move by whole characters", () => {
  const rocket = "a🚀b";
  assert.equal(nextGraphemeEnd(rocket, 1), 3, "right arrow steps over the surrogate pair");
  assert.equal(previousGraphemeStart(rocket, 3), 1, "backspace removes the whole emoji");
  const family = "x👨‍👩‍👧";
  assert.equal(previousGraphemeStart(family, family.length), 1, "backspace removes the whole ZWJ cluster");
  assert.equal(layoutLines(["日本"], 2).caretColumnInLine, 4, "caret column is a display column, not a code-unit offset");
});

test("applyEdit reports how it matched", () => {
  const exact = applyEdit("const a = 1;\n", "const a = 1;", "const a = 2;", false);
  assert.ok(exact.ok);
  assert.equal(exact.strategy, "exact");

  // The block is indented as a whole; dedenting both sides keeps relative
  // structure, which is strictly more precise than trimming every line.
  const dedented = applyEdit(
    "class A {\n    method() {\n        return 1;\n    }\n}\n",
    "method() {\n    return 1;\n}",
    "method() {\n    return 2;\n}",
    false,
  );
  assert.ok(dedented.ok, dedented.ok ? "" : dedented.error);
  assert.equal(dedented.strategy, "indentation");

  // Tabs versus spaces survives only the loosest strategy.
  const trimmed = applyEdit("if (a) {\n\t\tb();\n}\n", "if (a) {\nb();\n}", "if (a) {\nc();\n}", false);
  assert.ok(trimmed.ok, trimmed.ok ? "" : trimmed.error);
  assert.equal(trimmed.strategy, "whitespace");
});

test("checkpoints arm, capture, commit and restore in that order", async () => {
  const root = tempDir();
  const manager = new CheckpointManager({ dir: root, sessionId: "session-1" });
  const file = path.join(root, "code.ts");
  fs.writeFileSync(file, "original\n");

  manager.arm("turn-1", "edit", 1);
  manager.capture("turn-1", file);
  manager.setDelta("turn-1", file, { added: 3, removed: 1 });
  const info = manager.commit("turn-1");
  assert.ok(info, "a turn that changed a file must produce a checkpoint");
  assert.equal(info.files.length, 1);
  assert.equal(info.files[0]?.additions, 3);

  fs.writeFileSync(file, "modified\n");
  const restored = await manager.restore(info.id);
  assert.deepEqual(restored.restored, [file]);
  assert.equal(fs.readFileSync(file, "utf8"), "original\n");
  assert.equal(manager.list().length, 0, "a restored checkpoint is consumed");

  manager.arm("turn-2", "read", 2);
  assert.equal(manager.commit("turn-2"), undefined, "a turn that changed nothing leaves no entry");
  assert.equal(manager.list().length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a tool-driven edit is checkpointed and /undo restores the file", async () => {
  await withWorkspace(async ({ root, runtime }) => {
    const target = path.join(root, "code.ts");
    fs.writeFileSync(target, "original\n");

    await runtime.agent.submit(`@tool read ${JSON.stringify({ file_path: target })}`);
    await runtime.agent.submit(`@tool edit ${JSON.stringify({ file_path: target, old_string: "original", new_string: "changed" })}`);
    assert.equal(fs.readFileSync(target, "utf8"), "changed\n", "the edit tool ran through the loop");

    const checkpoints = runtime.checkpoints.list();
    assert.equal(checkpoints.length, 1, "the mutating turn committed exactly one checkpoint");
    assert.deepEqual(checkpoints[0]!.files.map((file) => file.path), [target]);
    assert.ok((checkpoints[0]!.files[0]?.additions ?? 0) > 0, "the checkpoint records the size of the change");

    const restored = await runtime.checkpoints.restore(checkpoints[0]!.id);
    assert.deepEqual(restored.restored, [target]);
    assert.equal(fs.readFileSync(target, "utf8"), "original\n", "/undo put the file back");
  });
});

test("writes bypassing the read guard are refused, and the mode is preserved", async () => {
  await withWorkspace(async ({ root, runtime }) => {
    const target = path.join(root, "run.sh");
    fs.writeFileSync(target, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    // The file exists with content and has not been read, so the write must fail.
    runtime.agent.setAbortSignal(undefined);
    await runtime.agent.submit(`@tool write ${JSON.stringify({ file_path: target, content: "clobbered\n" })}`);
    assert.equal(fs.readFileSync(target, "utf8"), "#!/bin/sh\necho hi\n", "an unread file is not overwritten");

    await runtime.agent.submit(`@tool read ${JSON.stringify({ file_path: target })}`);
    await runtime.agent.submit(`@tool write ${JSON.stringify({ file_path: target, content: "#!/bin/sh\necho bye\n" })}`);
    assert.equal(fs.readFileSync(target, "utf8"), "#!/bin/sh\necho bye\n");
    assert.equal(
      fs.statSync(target).mode & 0o111,
      0o111,
      "the atomic write must not clear the executable bit",
    );
  });
});

test("an aborted run stops before doing any work", async () => {
  await withWorkspace(async ({ root, runtime }) => {
    const controller = new AbortController();
    controller.abort();
    runtime.agent.setAbortSignal(controller.signal);
    await assert.rejects(() => runtime.agent.submit(`@tool write ${JSON.stringify({ file_path: path.join(root, "nope.txt"), content: "x" })}`));
    assert.equal(fs.existsSync(path.join(root, "nope.txt")), false);
  });
});

test("the documented hook events actually fire", async () => {
  const root = tempDir();
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      provider: "mock",
      model: "mock-1",
      providers: { mock: { api: "mock", baseURL: "http://127.0.0.1:1", models: [{ id: "mock-1" }] } },
      permissions: { preset: "danger-full-access", allowDangerous: true },
      sessions: { persist: false },
      hooks: [
        { event: "session.start", command: "echo session-start >> hook.log" },
        { event: "turn.end", command: "echo turn-end >> hook.log" },
        { event: "tool.before", matcher: "^read$", command: "echo tool-before >> hook.log" },
        { event: "tool.before", matcher: "^write$", command: "echo write-should-not-run >> hook.log" },
      ],
    }),
  );
  const runtime = await Runtime.create({ cwd: root, configPath, headless: true, maxTurns: 1 });
  try {
    fs.writeFileSync(path.join(root, "x.txt"), "hello\n");
    await runtime.agent.submit(`@tool read ${JSON.stringify({ file_path: path.join(root, "x.txt") })}`);
    const log = fs.readFileSync(path.join(root, "hook.log"), "utf8");
    assert.match(log, /session-start/, "session.start fired");
    assert.match(log, /tool-before/, "tool.before fired for a matching tool");
    assert.match(log, /turn-end/, "turn.end fired");
    assert.doesNotMatch(log, /write-should-not-run/, "a non-matching tool.before is skipped");
  } finally {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a prompt.submit hook can veto a request before anything happens", async () => {
  const root = tempDir();
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      provider: "mock",
      model: "mock-1",
      providers: { mock: { api: "mock", baseURL: "http://127.0.0.1:1", models: [{ id: "mock-1" }] } },
      permissions: { preset: "danger-full-access", allowDangerous: true },
      sessions: { persist: false },
      hooks: [{ event: "prompt.submit", matcher: "deploy", command: `printf '{"blocked":true,"reason":"policy says no"}'` }],
    }),
  );
  const runtime = await Runtime.create({ cwd: root, configPath, headless: true, maxTurns: 1 });
  try {
    await assert.rejects(() => runtime.agent.submit("deploy to production"), /policy says no/);
    assert.equal(runtime.session.messages.length, 0, "a vetoed prompt never reaches the session");
  } finally {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failing primary endpoint fails over to the configured fallback", async () => {
  const root = tempDir();
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      provider: "primary",
      model: "broken-1",
      // The fallback list was parsed, exported and then never read at runtime.
      fallbacks: ["backup"],
      providers: {
        // A real HTTP provider pointed at a closed port: the connection is
        // refused, which is exactly the case a fallback exists for.
        primary: {
          api: "openai-completions",
          baseURL: "http://127.0.0.1:1/v1",
          models: [{ id: "broken-1" }],
          retries: 0,
        },
        backup: { api: "mock", baseURL: "http://127.0.0.1:1", models: [{ id: "works-1" }] },
      },
      permissions: { preset: "danger-full-access", allowDangerous: true },
      sessions: { persist: false },
      agent: { retries: 0 },
    }),
  );
  const runtime = await Runtime.create({ cwd: root, configPath, headless: true, maxTurns: 1 });
  const notices: string[] = [];
  runtime.attachUi({
    agentUi: { notice: (text) => notices.push(text) },
    sink: { progress() {}, notice() {}, status() {}, log() {} },
    promptApi: { async confirm() { return "deny"; } },
  });
  try {
    const result = await runtime.agent.submit("hello from the fallback test");
    assert.ok(notices.some((line) => /fallback model/i.test(line)), `expected a failover notice, saw: ${notices.join(" | ")}`);
    assert.equal(runtime.agent.model.model.id, "works-1", "the agent switches to the fallback model");
    assert.equal(runtime.session.info().model, "works-1", "the session records the model that answered");
    assert.match(result.text, /works-1/, "the fallback provider produced the answer");
  } finally {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
