import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "../src/version.ts";
import { binFileNames, binNames, globalBinDir, packageRootFrom, readManifest } from "../src/commands/link.ts";

const ROOT = packageRootFrom(import.meta.url);
const DATE = "2026-09-26";

interface ReleaseModule {
  parseVersion(value: string): { major: number; minor: number; patch: number };
  nextVersion(current: string, bump: string): string;
  replaceVersionConstant(source: string, version: string): string;
  sectionsFromCommits(subjects: string[]): string[];
  updateChangelog(
    content: string,
    options: { version: string; date: string; previousVersion?: string; entries?: string[] },
  ): string;
  buildReleasePlan(
    root: string,
    options: { bump: string; date?: string },
  ): { currentVersion: string; version: string; tag: string; files: { path: string; content: string }[] };
  applyRelease(root: string, plan: unknown, options?: { quiet?: boolean }): string[];
  isWorkingTreeClean(root: string): boolean;
}

const release = (await import(pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href)) as ReleaseModule;

function tempDir(prefix = "bb-release-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function writeFixture(dir: string, options: { changelog: string; version?: string }): void {
  const version = options.version ?? "0.1.0";
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "blue-bird-cli", version, license: "MIT", bin: { bb: "bin/bluebird.js" } }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "version.ts"), `export const VERSION = "${version}";\n`);
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({ name: "blue-bird-cli", version, lockfileVersion: 3, packages: { "": { name: "blue-bird-cli", version } } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), options.changelog);
}

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- a curated entry

## [0.0.9] - 2026-01-01

### Added

- something older

[Unreleased]: https://github.com/ayush-thakur02/blue-bird-cli/compare/v0.0.9...HEAD
[0.0.9]: https://github.com/ayush-thakur02/blue-bird-cli/releases/tag/v0.0.9
`;

test("the package stays publishable", () => {
  const manifest = readManifest(ROOT);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  assert.equal(raw.name, "@not.ayushthakur/blue-bird-cli", "the published name must match the workflow's registry check");
  assert.equal(raw.license, "MIT");
  assert.match(raw.repository.url, /github\.com\/ayush-thakur02\/blue-bird-cli/);
  assert.match(raw.homepage, /github\.com\/ayush-thakur02\/blue-bird-cli/);
  assert.match(raw.bugs.url, /issues/);
  assert.equal(raw.publishConfig.access, "public", "scoped-free packages still publish publicly");
  assert.match(raw.main, /^dist\//, "an installed copy must run compiled JavaScript, not TypeScript");
  assert.equal(raw.types, "dist/index.d.ts");
  assert.equal(raw.exports["."].default, "./dist/index.js");
  assert.match(raw.scripts.prepack, /build/, "packing must build dist first");
  assert.match(raw.scripts.prepublishOnly, /verify/, "publishing runs the checks");

  for (const entry of ["bin", "dist", "docs", "README.md", "CHANGELOG.md", "LICENSE"]) {
    assert.ok(raw.files.includes(entry), `${entry} must ship in the tarball`);
  }
  assert.ok(!raw.files.includes("src"), "TypeScript sources cannot execute inside node_modules");
  assert.ok(fs.existsSync(path.join(ROOT, "LICENSE")), "npm warns when the licensed package has no LICENSE file");
  assert.ok(fs.existsSync(path.join(ROOT, "CHANGELOG.md")));

  assert.equal(raw.engines.node, ">=22.18.0", "the runtime floor matches native TypeScript execution");

  const names = binNames(manifest);
  assert.deepEqual(names.sort(), ["bb", "blue-bird", "bluebird"]);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.bin![name]!)), `bin/${name} target exists`);
  }
});

test("the bin wrapper starts the CLI from this package", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "bluebird.js"), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, `bin/bluebird.js exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout.trim(), VERSION, "the bin must run the sources in a checkout and dist/ in an install");
});

test("the version is identical in package.json, src/version.ts and the lockfile", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

  assert.equal(manifest.version, VERSION, "`bluebird --version` must match the published version");
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[""].version, VERSION);
});

test("npm link helpers describe the global install", () => {
  assert.equal(packageRootFrom(import.meta.url), ROOT);
  assert.equal(globalBinDir("/usr/local"), "/usr/local/bin");
  assert.equal(globalBinDir("C:\\npm", "win32"), "C:\\npm");
  assert.deepEqual(binFileNames("bb"), ["bb"]);
  assert.deepEqual(binFileNames("bb", "win32"), ["bb.cmd", "bb.ps1", "bb"]);
  assert.throws(() => readManifest(path.join(ROOT, "docs")), /No package\.json/);
});

test("version arithmetic understands bumps and explicit versions", () => {
  assert.equal(release.nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(release.nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(release.nextVersion("1.4.2", "major"), "2.0.0");
  assert.equal(release.nextVersion("0.1.0", "2.3.4"), "2.3.4");
  assert.deepEqual(release.parseVersion("2.3.4"), { major: 2, minor: 3, patch: 4 });
  assert.throws(() => release.parseVersion("v2.3"), /not a version/);

  assert.equal(
    release.replaceVersionConstant('export const VERSION = "0.1.0";\n', "0.2.0"),
    'export const VERSION = "0.2.0";\n',
  );
  assert.throws(() => release.replaceVersionConstant("nothing here", "0.2.0"), /does not declare/);
});

test("changelog sections are generated from conventional commits", () => {
  const sections = release.sectionsFromCommits([
    "feat(cli): add the link command",
    "fix: do not duplicate .env keys",
    "chore(release): v0.1.0",
    "docs: explain the release flow",
    "random subject",
  ]);
  const text = sections.join("\n");
  assert.match(text, /^### Added\n- add the link command/m);
  assert.match(text, /^### Changed\n- random subject/m);
  assert.match(text, /^### Fixed\n- do not duplicate \.env keys/m);
  assert.match(text, /^### Documentation\n- explain the release flow/m);
  assert.doesNotMatch(text, /v0\.1\.0/, "release commits are not changelog entries");
  assert.deepEqual(release.sectionsFromCommits([]), ["_No changes recorded._"]);
});

test("updateChangelog promotes Unreleased and repoints the compare links", () => {
  const updated = release.updateChangelog(CHANGELOG, {
    version: "0.2.0",
    date: DATE,
    previousVersion: "0.1.0",
    entries: ["feat: ignored"],
  });

  assert.match(updated, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-09-26\n\n### Added\n\n- a curated entry/);
  assert.match(updated, /## \[0\.0\.9\] - 2026-01-01/, "older sections are untouched");
  assert.match(updated, /\[Unreleased\]: https:\/\/github\.com\/ayush-thakur02\/blue-bird-cli\/compare\/v0\.2\.0\.\.\.HEAD/);
  assert.match(updated, /\[0\.2\.0\]: https:\/\/github\.com\/ayush-thakur02\/blue-bird-cli\/compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  assert.equal(updated.match(/a curated entry/g)?.length, 1, "curated entries are not duplicated by generated ones");
  assert.ok(updated.endsWith("\n") && !updated.endsWith("\n\n"), "exactly one trailing newline");

  assert.throws(() => release.updateChangelog(updated, { version: "0.2.0", date: DATE }), /already has a section for 0\.2\.0/);
  assert.throws(() => release.updateChangelog("# Changelog\n", { version: "0.2.0", date: DATE }), /no "## \[Unreleased\]" heading/);
});

test("an empty Unreleased section is filled from the commits since the last tag", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not available");
    return;
  }
  const dir = tempDir();
  try {
    writeFixture(dir, { changelog: "# Changelog\n\n## [Unreleased]\n\n## [0.0.9] - 2026-01-01\n\n- older\n" });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Blue Bird Test");
    git("add", "-A");
    git("commit", "-qm", "feat: add the first thing");
    git("tag", "v0.1.0");
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- older\n");
    git("add", "-A");
    git("commit", "-qm", "fix: repair the second thing");

    const plan = release.buildReleasePlan(dir, { bump: "minor", date: DATE });
    const changelog = plan.files.find((file) => file.path === "CHANGELOG.md");
    assert.ok(changelog, "the changelog is part of the plan");
    assert.match(changelog.content, /## \[0\.2\.0\] - 2026-09-26/);
    assert.match(changelog.content, /### Fixed\n- repair the second thing/);
    assert.doesNotMatch(changelog.content, /add the first thing/, "only commits after the last tag are listed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildReleasePlan lists every file a release touches, without writing", () => {
  const dir = tempDir();
  try {
    writeFixture(dir, { changelog: CHANGELOG });
    const plan = release.buildReleasePlan(dir, { bump: "patch", date: DATE });

    assert.equal(plan.currentVersion, "0.1.0");
    assert.equal(plan.version, "0.1.1");
    assert.equal(plan.tag, "v0.1.1");
    assert.deepEqual(
      plan.files.map((file) => file.path).sort(),
      ["CHANGELOG.md", "package-lock.json", "package.json", "src/version.ts"],
    );
    assert.equal(JSON.parse(plan.files.find((file) => file.path === "package.json")!.content).version, "0.1.1");
    assert.match(plan.files.find((file) => file.path === "src/version.ts")!.content, /VERSION = "0\.1\.1"/);
    assert.equal(JSON.parse(plan.files.find((file) => file.path === "package-lock.json")!.content).packages[""].version, "0.1.1");

    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8").includes("0.1.0"), true, "planning changes nothing on disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tagging an unreleased version keeps the version and only promotes the changelog", () => {
  const dir = tempDir();
  try {
    writeFixture(dir, { changelog: CHANGELOG });
    const plan = release.buildReleasePlan(dir, { bump: "0.1.0", date: DATE });
    assert.equal(plan.version, plan.currentVersion);
    assert.deepEqual(
      plan.files.map((file) => file.path),
      ["CHANGELOG.md"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRelease commits the bump and creates the tag", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not available");
    return;
  }
  const dir = tempDir();
  try {
    writeFixture(dir, { changelog: CHANGELOG });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bin", "bluebird.js"), "#!/usr/bin/env node\n");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Blue Bird Test");
    git("add", "-A");
    git("commit", "-qm", "feat: initial release");

    const plan = release.buildReleasePlan(dir, { bump: "minor", date: DATE });
    release.applyRelease(dir, plan, { quiet: true });

    assert.equal(git("tag", "--list").stdout.trim(), "v0.2.0");
    assert.equal(git("log", "-1", "--pretty=%s").stdout.trim(), "chore(release): v0.2.0");
    assert.equal(git("status", "--porcelain").stdout.trim(), "", "the release leaves a clean tree");
    assert.equal(release.isWorkingTreeClean(dir), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "0.2.0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
