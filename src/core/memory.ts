import fs from "node:fs";
import path from "node:path";
import { bluebirdHome, fileExists, isDirectory } from "../util/paths.ts";
import { CONFIG_DIR } from "../version.ts";

export interface MemoryEntry {
  /** Absolute path of the file. */
  source: string;
  /** Path as displayed in the prompt (relative where possible). */
  label: string;
  content: string;
  scope: "global" | "project" | "nested" | "learnings";
}

export interface MemoryDiscovery {
  entries: MemoryEntry[];
  /** Files that were referenced through @import but missing. */
  missingImports: string[];
  truncated: boolean;
  totalChars: number;
}

export const MEMORY_FILENAMES = ["BLUEBIRD.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
export const BLUEBIRD_MEMORY_FILENAME = "BLUEBIRD.md";

const MAX_TOTAL_CHARS = 48_000;
const MAX_SINGLE_FILE_CHARS = 24_000;

export interface DiscoverOptions {
  cwd: string;
  /** Workspace root that owns .bluebird/. */
  root: string;
  home?: string;
  autoLoad?: boolean;
  extraFiles?: string[];
  learnings?: boolean;
}

export function discoverMemory(options: DiscoverOptions): MemoryDiscovery {
  const entries: MemoryEntry[] = [];
  const missingImports: string[] = [];
  let truncated = false;

  if (options.autoLoad === false) {
    return { entries, missingImports, truncated, totalChars: 0 };
  }

  const home = options.home ?? bluebirdHome();
  const globalFile = path.join(home, BLUEBIRD_MEMORY_FILENAME);
  const seen = new Set<string>();

  const push = (file: string, scope: MemoryEntry["scope"], label?: string) => {
    const real = path.resolve(file);
    if (seen.has(real) || !fileExists(real)) return;
    seen.add(real);
    const entry = readEntry(real, scope, label, options.cwd);
    if (!entry) return;
    entries.push(entry);
  };

  push(globalFile, "global", "~/.bluebird/" + BLUEBIRD_MEMORY_FILENAME);

  const chain = ancestorChain(options.cwd, options.root);
  for (const dir of chain) {
    for (const name of MEMORY_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) {
        push(candidate, dir === options.root || dir === options.cwd ? "project" : "nested");
      }
    }
    const projectMemoryDir = path.join(dir, CONFIG_DIR, "memory");
    if (options.learnings !== false && isDirectory(projectMemoryDir)) {
      for (const file of fs.readdirSync(projectMemoryDir).filter((name) => name.endsWith(".md")).sort()) {
        push(path.join(projectMemoryDir, file), "learnings", path.join(CONFIG_DIR, "memory", file));
      }
    }
  }

  for (const extra of options.extraFiles ?? []) {
    push(path.resolve(options.cwd, extra), "project");
  }

  // Resolve @import lines one level deep.
  const imported: MemoryEntry[] = [];
  for (const entry of entries) {
    const base = path.dirname(entry.source);
    for (const match of entry.content.matchAll(/^@([^\s@].*)$/gm)) {
      const target = path.resolve(base, match[1]!.trim());
      if (!fileExists(target)) {
        missingImports.push(target);
        continue;
      }
      const importedEntry = readEntry(target, "project", undefined, options.cwd);
      if (importedEntry) imported.push(importedEntry);
    }
  }
  for (const entry of imported) {
    if (!seen.has(entry.source)) {
      seen.add(entry.source);
      entries.push(entry);
    }
  }

  let total = 0;
  const limited: MemoryEntry[] = [];
  for (const entry of entries) {
    if (total + entry.content.length > MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    total += entry.content.length;
    limited.push(entry);
  }

  return { entries: limited, missingImports, truncated, totalChars: total };
}

function readEntry(
  source: string,
  scope: MemoryEntry["scope"],
  label: string | undefined,
  cwd: string,
): MemoryEntry | undefined {
  try {
    let content = fs.readFileSync(source, "utf8");
    if (content.length > MAX_SINGLE_FILE_CHARS) content = `${content.slice(0, MAX_SINGLE_FILE_CHARS)}\n\n[truncated]`;
    if (!content.trim()) return undefined;
    const display = label ?? (source.startsWith(cwd) ? path.relative(cwd, source) : source);
    return { source, label: display, content: content.trim(), scope };
  } catch {
    return undefined;
  }
}

function ancestorChain(cwd: string, root: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(cwd);
  const stop = path.parse(current).root;
  const boundary = path.resolve(root || cwd);
  while (true) {
    chain.push(current);
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current || current === stop) break;
    current = parent;
  }
  // Nearest (deepest) file should win, so emit deepest-last for stable prompting.
  return chain.reverse();
}

export function formatMemoryPrompt(discovery: MemoryDiscovery): string {
  if (discovery.entries.length === 0) return "";
  const sections = discovery.entries.map((entry) => {
    const header = `### ${entry.label}${entry.scope === "global" ? " (global)" : ""}`;
    return `${header}\n${entry.content}`;
  });
  const notes: string[] = [];
  if (discovery.truncated) notes.push("Some instruction files were truncated to keep the context small.");
  if (discovery.missingImports.length) {
    notes.push(`Missing @import targets: ${discovery.missingImports.slice(0, 5).join(", ")}`);
  }
  return [
    "# Project instructions",
    "These files were written by the user or previous sessions. Follow them, but a direct instruction in the current conversation always wins. Nearest files take precedence over parent directories.",
    "",
    sections.join("\n\n"),
    ...(notes.length ? ["", notes.join(" ")] : []),
  ].join("\n");
}

export function memoryTemplate(root: string, detected: { languages: string[]; packageManager?: string; scripts: string[] }): string {
  const name = path.basename(root);
  const lines = [
    `# ${name}`,
    "",
    "<!-- Blue Bird reads this file at the start of every session. Keep it short and factual. -->",
    "",
    "## Overview",
    "",
    `_One or two sentences describing what ${name} does._`,
    "",
    "## Layout",
    "",
    "- `src/` — application code",
    "",
    "## Commands",
    "",
    ...(detected.scripts.length
      ? detected.scripts.map((script) => `- \`${detected.packageManager ?? "npm"} run ${script}\``)
      : ["- `<build command>`", "- `<test command>`"]),
    "",
    "## Conventions",
    "",
    ...(detected.languages.length ? [`- Languages: ${detected.languages.join(", ")}`] : []),
    "- Describe style rules, naming, error handling and anything a new contributor must know.",
    "",
    "## Do not",
    "",
    "- List files or directories the agent must never touch.",
    "",
  ];
  return lines.join("\n");
}

export function detectProjectTraits(root: string): { languages: string[]; packageManager?: string; scripts: string[] } {
  const languages: string[] = [];
  const markers: [string, string][] = [
    ["tsconfig.json", "TypeScript"],
    ["package.json", "JavaScript"],
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Cargo.toml", "Rust"],
    ["pom.xml", "Java"],
    ["build.gradle", "Java"],
    ["Gemfile", "Ruby"],
    ["composer.json", "PHP"],
    ["CMakeLists.txt", "C++"],
    ["Dockerfile", "Docker"],
  ];
  for (const [file, language] of markers) {
    if (fileExists(path.join(root, file)) && !languages.includes(language)) languages.push(language);
  }
  let packageManager: string | undefined;
  if (fileExists(path.join(root, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (fileExists(path.join(root, "yarn.lock"))) packageManager = "yarn";
  else if (fileExists(path.join(root, "bun.lockb"))) packageManager = "bun";
  else if (fileExists(path.join(root, "package-lock.json"))) packageManager = "npm";

  const scripts: string[] = [];
  const pkgPath = path.join(root, "package.json");
  if (fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      for (const name of Object.keys(pkg.scripts ?? {}).slice(0, 8)) scripts.push(name);
    } catch {
      // ignore malformed package.json
    }
  }
  return { languages, ...(packageManager ? { packageManager } : {}), scripts };
}
