#!/usr/bin/env node
/**
 * Release driver for blue-bird-cli.
 *
 *   npm run release -- patch|minor|major|0.2.0 [--dry-run] [--push] [--publish] [--no-verify]
 *
 * Keeps package.json, src/version.ts and package-lock.json on the same version,
 * promotes the CHANGELOG `Unreleased` section, commits, and tags `v<version>`.
 * Pushing and publishing are opt-in so a release can be reviewed before it leaves
 * the machine; publishing from CI is documented in docs/RELEASING.md.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = path.join("src", "version.ts");
export const CHANGELOG_FILE = "CHANGELOG.md";
export const LOCK_FILE = "package-lock.json";
const RELEASE_PREFIX = "chore(release)";
const CLI_PUBLISH_FLAGS = " --access public --provenance";

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`"${value}" is not a version — use patch, minor, major or a full x.y.z`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function nextVersion(current, bump) {
  const parsed = parseVersion(current);
  if (!["patch", "minor", "major"].includes(bump)) return formatVersion(parseVersion(bump));
  if (bump === "major") return `${parsed.major + 1}.0.0`;
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** Rewrites the VERSION constant, refusing a file that does not declare one. */
export function replaceVersionConstant(source, version) {
  const pattern = /export const VERSION = "[^"]*";/;
  if (!pattern.test(source)) throw new Error(`${VERSION_FILE} does not declare \`export const VERSION = "...";\``);
  return source.replace(pattern, `export const VERSION = "${version}";`);
}

function groupFor(subject) {
  if (/^feat(\(|:|!)/.test(subject)) return "Added";
  if (/^fix(\(|:|!)/.test(subject)) return "Fixed";
  if (/^perf(\(|:|!)/.test(subject)) return "Changed";
  if (/^docs(\(|:|!)/.test(subject)) return "Documentation";
  return "Changed";
}

function cleanSubject(subject) {
  return subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").trim() || subject;
}

/** Markdown body generated from commit subjects when Unreleased has no curated entries. */
export function sectionsFromCommits(subjects) {
  const groups = new Map();
  for (const subject of subjects) {
    if (subject.startsWith(RELEASE_PREFIX)) continue;
    const group = groupFor(subject);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(cleanSubject(subject));
  }
  if (groups.size === 0) return ["_No changes recorded._"];
  const order = ["Added", "Changed", "Fixed", "Documentation"];
  const lines = [];
  for (const group of order) {
    const entries = groups.get(group);
    if (!entries?.length) continue;
    lines.push(`### ${group}`, ...entries.map((entry) => `- ${entry}`), "");
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const REPO_URL = "https://github.com/ayush-thakur02/blue-bird-cli";

function isReferenceLine(line) {
  return /^\[[^\]]+\]:\s+\S+/.test(line);
}

/**
 * Promotes `## [Unreleased]` to `## [version] - date`, opening a fresh
 * Unreleased section above it and repointing the compare links.
 */
export function updateChangelog(content, { version, date, previousVersion, entries = [] }) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^##\s*\[?unreleased\]?/i.test(line.trim()));
  if (start === -1) throw new Error(`${CHANGELOG_FILE} has no "## [Unreleased]" heading to promote`);
  const escaped = version.replace(/\./g, "\\.");
  if (lines.some((line, index) => index !== start && new RegExp(`^##\\s*\\[${escaped}\\]`).test(line.trim()))) {
    throw new Error(`${CHANGELOG_FILE} already has a section for ${version}`);
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("## ") || (isReferenceLine(line) && index > start + 1)) {
      end = index;
      break;
    }
  }

  const body = lines.slice(start + 1, end);
  const curated = body.filter((line) => /^\s*[-*]\s+\S/.test(line) || (line.trim() && !line.trim().startsWith("#")));
  const section = curated.length > 0 ? body : ["", ...sectionsFromCommits(entries), ""];
  while (section.length && section[0].trim() === "") section.shift();
  while (section.length && section[section.length - 1].trim() === "") section.pop();

  const promoted = [`## [Unreleased]`, "", `## [${version}] - ${date}`, "", ...section, ""];
  const merged = [...lines.slice(0, start), ...promoted, ...lines.slice(end)];

  const withLinks = merged.map((line) => {
    if (/^\[unreleased\]:/i.test(line.trim())) return `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`;
    return line;
  });

  if (!withLinks.some((line) => new RegExp(`^\\[${version.replace(/\./g, "\\.")}\\]:`).test(line.trim()))) {
    const link = previousVersion
      ? `[${version}]: ${REPO_URL}/compare/v${previousVersion}...v${version}`
      : `[${version}]: ${REPO_URL}/releases/tag/v${version}`;
    const lastReference = withLinks.map(isReferenceLine).lastIndexOf(true);
    if (lastReference === -1) withLinks.push("", link);
    else withLinks.splice(lastReference + 1, 0, link);
  }

  return `${withLinks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "")}\n`;
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

export function lastTag(root) {
  const result = git(root, ["describe", "--tags", "--abbrev=0"], { allowFailure: true });
  return result.ok && result.stdout ? result.stdout : undefined;
}

export function commitsSince(root, tag) {
  const result = git(root, ["log", "--no-merges", "--pretty=format:%s", tag ? `${tag}..HEAD` : "HEAD"], { allowFailure: true });
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function tagExists(root, tag) {
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { allowFailure: true }).ok;
}

export function currentBranch(root) {
  const result = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  return result.ok && result.stdout && result.stdout !== "HEAD" ? result.stdout : undefined;
}

export function isWorkingTreeClean(root) {
  const result = git(root, ["status", "--porcelain"], { allowFailure: true });
  return result.ok && result.stdout === "";
}

/**
 * Reads the repository and returns every file change a release would make,
 * without touching the working tree.
 */
export function buildReleasePlan(root, { bump, date = new Date().toISOString().slice(0, 10) }) {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentVersion = manifest.version;
  const version = nextVersion(currentVersion, bump);
  const tag = `v${version}`;
  const previousTag = lastTag(root);
  const previousVersion = previousTag ? previousTag.replace(/^v/, "") : undefined;
  const files = [];

  if (version !== currentVersion) {
    files.push({ path: "package.json", content: `${JSON.stringify({ ...manifest, version }, null, 2)}\n` });
    const versionPath = path.join(root, VERSION_FILE);
    files.push({ path: VERSION_FILE, content: replaceVersionConstant(fs.readFileSync(versionPath, "utf8"), version) });
    const lockPath = path.join(root, LOCK_FILE);
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      files.push({ path: LOCK_FILE, content: `${JSON.stringify(lock, null, 2)}\n` });
    }
  }

  const changelogPath = path.join(root, CHANGELOG_FILE);
  if (fs.existsSync(changelogPath)) {
    const before = fs.readFileSync(changelogPath, "utf8");
    const after = updateChangelog(before, {
      version,
      date,
      ...(previousVersion ? { previousVersion } : {}),
      entries: commitsSince(root, previousTag),
    });
    if (after !== before) files.push({ path: CHANGELOG_FILE, content: after });
  }

  return {
    currentVersion,
    version,
    tag,
    date,
    ...(previousTag ? { previousTag } : {}),
    files,
    changed: files.length > 0,
  };
}

function writePlan(root, plan, { quiet }) {
  const written = [];
  for (const file of plan.files) {
    const target = path.join(root, file.path);
    const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (before === file.content) continue;
    fs.writeFileSync(target, file.content);
    written.push(file.path);
  }
  if (!quiet) {
    for (const file of written) process.stdout.write(`  ${"updated".padEnd(9)} ${file}\n`);
    if (written.length === 0) process.stdout.write(`  ${"updated".padEnd(9)} nothing (already at ${plan.version})\n`);
  }
  return written;
}

export function applyRelease(root, plan, { quiet = false } = {}) {
  const written = writePlan(root, plan, { quiet });
  if (written.length > 0) {
    git(root, ["add", ...written]);
    git(root, ["commit", "-m", `${RELEASE_PREFIX}: ${plan.tag}`]);
  }
  git(root, ["tag", "-a", plan.tag, "-m", plan.tag]);
  return written;
}

function usage() {
  return [
    "Usage: npm run release -- <patch|minor|major|x.y.z> [flags]",
    "",
    "  --dry-run     print the version, files and commands without changing anything",
    "  --push        push the branch and the new tag to origin",
    "  --publish     run npm publish after tagging (CI publishes on tag push instead)",
    "  --no-verify   skip `npm run verify` (typecheck + tests)",
    "  --allow-dirty allow a working tree with uncommitted changes",
  ].join("\n");
}

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const bump = argv.find((arg) => !arg.startsWith("--"));
  if (!bump || flags.has("--help")) {
    process.stdout.write(`${usage()}\n`);
    return bump ? 0 : 1;
  }

  const dryRun = flags.has("--dry-run");
  const root = PACKAGE_ROOT;
  const plan = buildReleasePlan(root, { bump });

  if (!dryRun && !flags.has("--allow-dirty") && !isWorkingTreeClean(root)) {
    throw new Error("the working tree has uncommitted changes — commit or stash them first (or pass --allow-dirty)");
  }
  if (tagExists(root, plan.tag) && plan.version !== plan.currentVersion) {
    throw new Error(`tag ${plan.tag} already exists`);
  }

  process.stdout.write(`\nBlue Bird release: ${plan.currentVersion} → ${plan.version}${dryRun ? " (dry run)" : ""}\n\n`);
  if (plan.files.length === 0) {
    process.stdout.write(`  no file changes (version stays ${plan.version})\n`);
  } else {
    for (const file of plan.files) process.stdout.write(`  ${"changes".padEnd(9)} ${file.path}\n`);
  }

  if (dryRun) {
    process.stdout.write(`\n  would run: git add, git commit -m "${RELEASE_PREFIX}: ${plan.tag}", git tag -a ${plan.tag}\n`);
    if (flags.has("--push")) process.stdout.write(`  would run: git push --follow-tags\n`);
    if (flags.has("--publish")) process.stdout.write(`  would run: npm publish${CLI_PUBLISH_FLAGS}\n`);
    process.stdout.write("\n");
    return 0;
  }

  if (!flags.has("--no-verify")) {
    process.stdout.write(`\n  running npm run verify…\n`);
    const verify = spawnSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });
    if (verify.status !== 0) throw new Error("npm run verify failed — fix the failures and release again");
  }

  const written = applyRelease(root, plan);
  process.stdout.write(`\n  ✓ tagged ${plan.tag}${written.length ? ` (${written.join(", ")})` : " (no file changes)"}\n`);

  const branch = currentBranch(root);
  const steps = [`git push${branch ? ` origin ${branch}` : ""} --follow-tags`, `npm publish${CLI_PUBLISH_FLAGS}`];
  if (flags.has("--push")) {
    const push = spawnSync("git", ["push", "--follow-tags"], { cwd: root, stdio: "inherit" });
    if (push.status !== 0) throw new Error("git push failed");
    process.stdout.write(`  ✓ pushed ${branch ?? "HEAD"} and ${plan.tag}\n`);
  }
  if (flags.has("--publish")) {
    const publish = spawnSync("npm", ["publish"], { cwd: root, stdio: "inherit" });
    if (publish.status !== 0) throw new Error("npm publish failed");
  }

  if (!flags.has("--push") || !flags.has("--publish")) {
    process.stdout.write(`\n  next:\n`);
    if (!flags.has("--push")) process.stdout.write(`    ${steps[0]}\n`);
    if (!flags.has("--publish")) process.stdout.write(`    ${steps[1]}\n`);
    process.stdout.write(`    ${"or push the tag and let the release workflow publish it"}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`\n  release: ${error.message}\n\n`);
    process.exitCode = 1;
  }
}
