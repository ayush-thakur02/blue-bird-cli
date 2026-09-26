import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoUpdateOnStart,
  checkForUpdate,
  compareVersions,
  installArgs,
  isNpmGlobalInstall,
  isNewer,
  isSourceCheckout,
  planUpdate,
  readUpdateState,
  REGISTRY_LATEST_URL,
  skipReason,
  updateStatePath,
  writeUpdateState,
} from "../src/core/update.ts";
import { npmGlobalPackageDirs } from "../src/util/npm.ts";
import { PACKAGE_NAME, VERSION } from "../src/version.ts";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bb-update-"));
}

function withHome(fn: (env: NodeJS.ProcessEnv) => Promise<void> | void): Promise<void> | void {
  const home = tempHome();
  const env = { BLUEBIRD_HOME: home, PATH: process.env.PATH ?? "" };
  const done = () => fs.rmSync(home, { recursive: true, force: true });
  try {
    const result = fn(env);
    return result instanceof Promise ? result.finally(done) : done();
  } catch (error) {
    done();
    throw error;
  }
}

test("versions compare numerically, and a prerelease sorts below its release", () => {
  assert.equal(compareVersions("0.1.1", "0.1.2"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("v0.3.0", "0.3.0"), 0, "a leading v is ignored");
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "10 is not less than 9");
  assert.equal(compareVersions("0.2.0-rc.1", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-rc.1"), 1);
  assert.equal(compareVersions("0.2.0-rc.2", "0.2.0-rc.1"), 1);
  assert.equal(isNewer("0.1.2", "0.1.1"), true);
  assert.equal(isNewer("0.1.1", "0.1.1"), false);
  assert.equal(isNewer(VERSION, VERSION), false);
});

test("the update state round-trips through the bluebird home", async () => {
  await withHome(async (env) => {
    assert.deepEqual(readUpdateState(env), {}, "a missing file reads as empty");
    assert.equal(updateStatePath(env), path.join(env.BLUEBIRD_HOME!, "update.json"));

    writeUpdateState({ checkedAt: 123, latest: "9.9.9", installed: "9.9.9", installedAt: 456 }, env);
    assert.deepEqual(readUpdateState(env), { checkedAt: 123, latest: "9.9.9", installed: "9.9.9", installedAt: 456 });

    fs.writeFileSync(updateStatePath(env), "{ not json");
    assert.deepEqual(readUpdateState(env), {}, "a corrupt file is ignored rather than fatal");
  });
});

test("a fresh cache skips the registry, a stale one refetches", async () => {
  await withHome(async (env) => {
    let calls = 0;
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      calls += 1;
      assert.equal(String(url), REGISTRY_LATEST_URL);
      return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
    }) as typeof fetch;

    const fresh = await checkForUpdate({ current: "0.1.1", state: { checkedAt: Date.now(), latest: "0.2.0" }, fetchImpl, env });
    assert.equal(fresh.checked, false, "a cached answer inside the interval is reused");
    assert.equal(fresh.newer, true);
    assert.equal(calls, 0);

    const stale = await checkForUpdate({ current: "0.1.1", state: { checkedAt: Date.now() - 25 * 3_600_000, latest: "0.1.0" }, fetchImpl, env });
    assert.equal(stale.checked, true);
    assert.equal(stale.latest, "0.2.0");
    assert.equal(stale.newer, true);
    assert.equal(calls, 1);
    assert.equal(readUpdateState(env).latest, "0.2.0", "the answer is cached for the next start");
    assert.equal(readUpdateState(env).error, undefined);
  });
});

test("a registry failure is recorded, never thrown", async () => {
  await withHome(async (env) => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as typeof fetch;

    const check = await checkForUpdate({ current: "0.1.1", fetchImpl, env });
    assert.equal(check.checked, false);
    assert.equal(check.newer, false);
    assert.match(check.error!, /ENOTFOUND/);
    assert.match(readUpdateState(env).error!, /ENOTFOUND/);
  });
});

test("the check is skipped for checkouts, CI, opt-outs and non-terminals", () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "bb-checkout-"));
  fs.mkdirSync(path.join(checkout, "src"));
  fs.writeFileSync(path.join(checkout, "src", "cli.ts"), "export {};\n");
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), "bb-installed-"));

  try {
    assert.equal(isSourceCheckout(checkout), true);
    assert.equal(isSourceCheckout(installed), false);

    const base = { config: { version: 1 }, tty: true, packageRoot: installed, env: {} as NodeJS.ProcessEnv };
    assert.equal(skipReason(base), undefined, "an installed copy in a terminal may update itself");
    assert.match(skipReason({ ...base, env: { BLUEBIRD_NO_UPDATE: "1" } })!, /BLUEBIRD_NO_UPDATE/);
    assert.match(skipReason({ ...base, config: { version: 1, update: { auto: false, checkIntervalHours: 24 } } })!, /update\.auto/);
    assert.match(skipReason({ ...base, env: { CI: "true" } })!, /CI environment/);
    assert.match(skipReason({ ...base, tty: false })!, /interactive terminal/);
    assert.match(skipReason({ ...base, packageRoot: checkout })!, /source checkout/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(installed, { recursive: true, force: true });
  }
});

test("only a copy inside the npm global prefix is replaced", () => {
  const prefix = path.join(path.sep, "usr", "local");
  const [globalDir] = npmGlobalPackageDirs(prefix, PACKAGE_NAME);
  assert.equal(isNpmGlobalInstall(globalDir!, prefix), true);
  assert.equal(isNpmGlobalInstall(path.join(path.sep, "home", "me", "blue-bird-cli"), prefix), false);
  assert.equal(isNpmGlobalInstall(globalDir!, undefined), false, "an unknown prefix means no install rights");
  assert.deepEqual(installArgs("1.2.3"), ["install", "-g", `${PACKAGE_NAME}@1.2.3`]);
});

test("an update is installed only when npm owns the copy, and a failure is not retried", () => {
  const state = { latest: "0.2.0", checkedAt: 0 };
  assert.deepEqual(planUpdate({ state, version: "0.2.0", canInstall: true }), { action: "install" });

  const foreign = planUpdate({ state, version: "0.2.0", canInstall: false });
  assert.equal(foreign.action, "notice");
  assert.match(foreign.action === "notice" ? foreign.notice : "", /update available: 0\.2\.0 — run `npm install -g @not\.ayushthakur\/blue-bird-cli`/);

  const failed = { ...state, installError: "npm exited with 1", installErrorAt: 1_000 };
  const reported = planUpdate({ state: failed, version: "0.2.0", canInstall: true, now: 2_000 });
  assert.equal(reported.action, "notice");
  assert.match(reported.action === "notice" ? reported.notice : "", /failed \(npm exited with 1\)/);
  assert.deepEqual(
    planUpdate({ state: failed, version: "0.2.0", canInstall: true, now: 1_000 + 25 * 3_600_000 }),
    { action: "install" },
    "the next interval tries again",
  );
});

test("a source checkout is never updated by npm, and a global install is", async () => {
  await withHome(async (env) => {
    const root = tempHome();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "cli.ts"), "export {};\n");
    const config = { version: 1 };

    // A checkout: the policy skips it before any network call.
    const skipped = await autoUpdateOnStart({ config, packageRoot: root, env, tty: true });
    assert.deepEqual(skipped, {});
    assert.equal(readUpdateState(env).latest, undefined, "no check happened");

    // An installed copy: the cached answer says a newer version exists, so the
    // install is attempted — and refused, because this path is not inside npm's
    // global prefix. The user gets the command instead of a surprise install.
    const installed = tempHome();
    writeUpdateState({ latest: "99.0.0", checkedAt: Date.now() }, env);
    const result = await autoUpdateOnStart({ config, packageRoot: installed, env, tty: true });
    assert.match(result.notice ?? "", /update available: 99\.0\.0/);
    assert.equal(result.installed, undefined, "no background install outside the npm prefix");

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(installed, { recursive: true, force: true });
  });
});
