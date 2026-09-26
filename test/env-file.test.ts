import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeEnvWrite,
  envFileCandidates,
  globalEnvFile,
  isEnvVarName,
  loadEnvFiles,
  parseEnvFile,
  projectEnvFile,
  readEnvFileValues,
  upsertEnvVar,
} from "../src/config/env-file.ts";

function tempDir(prefix = "bb-env-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = tempDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parseEnvFile reads dotenv syntax", () => {
  const parsed = parseEnvFile(
    [
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=with-export",
      'QUOTED="has spaces and # hash"',
      "SINGLE='single quoted'",
      "EMPTY=",
      "WITH_COMMENT=value # trailing comment",
      "ESCAPED=\"line\\nbreak\"",
      "not a variable",
    ].join("\n"),
  );

  const values = Object.fromEntries(parsed.entries.map((entry) => [entry.key, entry.value]));
  assert.deepEqual(values, {
    PLAIN: "value",
    EXPORTED: "with-export",
    QUOTED: "has spaces and # hash",
    SINGLE: "single quoted",
    EMPTY: "",
    WITH_COMMENT: "value",
    ESCAPED: "line\nbreak",
  });
});

test("readEnvFileValues lets the last definition win", () => {
  withTempDir((dir) => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "KEY=first\nOTHER=x\nKEY=second\n");
    assert.deepEqual(readEnvFileValues(file), { KEY: "second", OTHER: "x" });
  });
});

test("loadEnvFiles fills the process environment without overriding it", () => {
  withTempDir((dir) => {
    const project = path.join(dir, "project.env");
    const global = path.join(dir, "global.env");
    fs.writeFileSync(project, "FROM_PROJECT=project\nSHARED=project\n");
    fs.writeFileSync(global, "FROM_GLOBAL=global\nSHARED=global\n");
    const missing = path.join(dir, "does-not-exist");

    const env: NodeJS.ProcessEnv = { SHARED: "shell" };
    const result = loadEnvFiles([project, missing, global], env);

    assert.deepEqual(result.files, [project, global], "only files that exist are reported");
    assert.deepEqual(result.keys, ["FROM_PROJECT", "FROM_GLOBAL"], "already-set variables are not taken from a file");
    assert.equal(env.SHARED, "shell", "the shell value wins over both files");
    assert.equal(env.FROM_PROJECT, "project");
    assert.equal(env.FROM_GLOBAL, "global");
  });
});

test("upsertEnvVar creates, appends, updates and never duplicates a key", () => {
  withTempDir((dir) => {
    const file = path.join(dir, ".env");

    const created = upsertEnvVar(file, "OPENAI_API_KEY", "sk-first");
    assert.equal(created.action, "created");
    assert.equal(created.changed, true);
    assert.match(fs.readFileSync(file, "utf8"), /^# Local secrets for Blue Bird.*\nOPENAI_API_KEY=sk-first\n$/s);

    const appended = upsertEnvVar(file, "OTHER_KEY", "second value");
    assert.equal(appended.action, "appended");
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(lines[lines.length - 2], "OPENAI_API_KEY=sk-first", "existing content stays where it was");
    assert.equal(lines[lines.length - 1], 'OTHER_KEY="second value"', "values with spaces are quoted");

    const beforeUnchanged = fs.readFileSync(file, "utf8");
    const unchanged = upsertEnvVar(file, "OPENAI_API_KEY", "sk-first");
    assert.equal(unchanged.action, "unchanged");
    assert.equal(unchanged.changed, false);
    assert.equal(fs.readFileSync(file, "utf8"), beforeUnchanged, "an identical value leaves the file untouched");

    const updated = upsertEnvVar(file, "OPENAI_API_KEY", "sk-rotated");
    assert.equal(updated.action, "updated");
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after.match(/OPENAI_API_KEY=/g)?.length, 1, "the key must not be appended a second time");
    assert.match(after, /OPENAI_API_KEY=sk-rotated/);
    assert.match(after, /OTHER_KEY="second value"/);
  });
});

test("upsertEnvVar preserves line endings, permissions and neighbouring comments", () => {
  withTempDir((dir) => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "# keep me\r\nKEY=old\r\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    const result = upsertEnvVar(file, "KEY", "new");
    assert.equal(result.action, "updated");
    assert.equal(fs.readFileSync(file, "utf8"), "# keep me\r\nKEY=new\r\n", "CRLF and the comment survive");
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, "the file's own mode is kept");
  });
});

test("upsertEnvVar rejects invalid names and describes what it did", () => {
  withTempDir((dir) => {
    const file = path.join(dir, ".env");
    assert.throws(() => upsertEnvVar(file, "not a name", "x"), /not a valid environment variable/);
    assert.equal(fs.existsSync(file), false, "nothing is written for an invalid name");

    assert.equal(isEnvVarName("OPENAI_API_KEY"), true);
    assert.equal(isEnvVarName("1KEY"), false);
    assert.equal(isEnvVarName("has-dash"), false);
    assert.equal(describeEnvWrite(upsertEnvVar(file, "KEY", "v")), `created ${file} with KEY`);
    assert.equal(describeEnvWrite(upsertEnvVar(file, "KEY", "v")), `KEY in ${file} already holds this value — left unchanged`);
  });
});

test("env files are located in the workspace and in the bluebird home", () => {
  const root = "/tmp/some-project";
  const env: NodeJS.ProcessEnv = { BLUEBIRD_HOME: "/tmp/bb-home" };
  assert.equal(projectEnvFile(root), "/tmp/some-project/.env");
  assert.equal(globalEnvFile(env), "/tmp/bb-home/.env");
  assert.deepEqual(envFileCandidates(root, env), ["/tmp/some-project/.env", "/tmp/bb-home/.env"]);
  assert.deepEqual(envFileCandidates(root, { BLUEBIRD_HOME: root }), ["/tmp/some-project/.env"], "a project that is its own home lists one path");
});
