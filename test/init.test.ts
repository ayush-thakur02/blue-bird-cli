import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/commands/init.ts";
import { loadRawConfig, resolveModel } from "../src/config/load.ts";
import { BlueBirdError } from "../src/util/errors.ts";

function tempDir(prefix = "bb-init-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

test("init stores the key in .env and references it from the config", async () => {
  const dir = tempDir();
  try {
    const result = await runInit({
      cwd: dir,
      yes: true,
      json: true,
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKey: "sk-live-secret",
      apiKeyEnv: "TEST_API_KEY",
    });

    const envFile = path.join(dir, ".env");
    assert.equal(result.envFile?.path, envFile);
    assert.equal(result.envFile?.key, "TEST_API_KEY");
    assert.equal(result.envFile?.action, "created");
    assert.match(read(envFile), /^TEST_API_KEY=sk-live-secret$/m);

    const config = JSON.parse(read(path.join(dir, ".bluebird", "config.json")));
    assert.equal(config.apiKey, "${TEST_API_KEY}", "the config keeps a reference, not the secret");
    assert.equal(config.endpoint, "https://example.test/v1");

    assert.match(read(path.join(dir, ".gitignore")), /^\.env$/m, "a .env written by init is gitignored");

    // A different process (no shell variable set) still resolves the key from .env.
    const fresh = { BLUEBIRD_HOME: path.join(dir, "home") };
    const { raw, envFiles, envKeys } = loadRawConfig({ cwd: dir, env: fresh });
    assert.deepEqual(envFiles, [envFile]);
    assert.deepEqual(envKeys, ["TEST_API_KEY"]);
    const model = resolveModel(raw, { env: fresh });
    assert.equal(model.apiKey, "sk-live-secret");
  } finally {
    delete process.env.TEST_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a second init updates the existing .env entry instead of appending it", async () => {
  const dir = tempDir();
  try {
    const base = { cwd: dir, yes: true as const, json: true, endpoint: "https://example.test/v1", model: "test-model", apiKeyEnv: "TEST_API_KEY" };
    await runInit({ ...base, apiKey: "sk-first" });
    const rotated = await runInit({ ...base, apiKey: "sk-rotated" });

    assert.equal(rotated.envFile?.action, "updated");
    const content = read(path.join(dir, ".env"));
    assert.equal(content.match(/TEST_API_KEY=/g)?.length, 1, "the key must not be duplicated");
    assert.match(content, /^TEST_API_KEY=sk-rotated$/m);

    const repeated = await runInit({ ...base, apiKey: "sk-rotated" });
    assert.equal(repeated.envFile?.action, "unchanged");
    assert.equal(read(path.join(dir, ".env")), content, "an identical key leaves the file byte-identical");
  } finally {
    delete process.env.TEST_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--api-key-env without a key references the variable and writes no .env", async () => {
  const dir = tempDir();
  try {
    const result = await runInit({
      cwd: dir,
      yes: true,
      json: true,
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "LATER_API_KEY",
    });

    assert.equal(result.envFile, undefined);
    assert.equal(fs.existsSync(path.join(dir, ".env")), false);
    assert.equal(result.config.apiKey, "${LATER_API_KEY}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--api-key-env rejects a name that is not a variable", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      runInit({ cwd: dir, yes: true, json: true, endpoint: "https://example.test/v1", model: "m", apiKeyEnv: "NOT A NAME" }),
      (error: unknown) => error instanceof BlueBirdError && /not a valid environment variable name/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(dir, ".bluebird", "config.json")), false, "nothing is written when the name is invalid");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init --global keeps the key in the bluebird home", async () => {
  const dir = tempDir();
  const home = path.join(dir, "home");
  const previousHome = process.env.HOME;
  const previousBluebirdHome = process.env.BLUEBIRD_HOME;
  process.env.HOME = dir;
  process.env.BLUEBIRD_HOME = home;
  try {
    const result = await runInit({
      cwd: dir,
      yes: true,
      json: true,
      global: true,
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKey: "sk-global",
      apiKeyEnv: "GLOBAL_API_KEY",
    });

    assert.equal(result.envFile?.path, path.join(home, ".env"));
    assert.match(read(path.join(home, ".env")), /^GLOBAL_API_KEY=sk-global$/m);
    assert.equal(JSON.parse(read(path.join(home, "config.json"))).apiKey, "${GLOBAL_API_KEY}");
    assert.equal(fs.existsSync(path.join(dir, "BLUEBIRD.md")), false, "a global init writes no project instructions");
  } finally {
    delete process.env.GLOBAL_API_KEY;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousBluebirdHome === undefined) delete process.env.BLUEBIRD_HOME;
    else process.env.BLUEBIRD_HOME = previousBluebirdHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
