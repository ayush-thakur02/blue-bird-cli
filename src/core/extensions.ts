import fs from "node:fs";
import path from "node:path";
import type { AgentDefinition, CommandDefinition, SkillDefinition } from "./contracts.ts";
import { fileExists, isDirectory } from "../util/paths.ts";
import { CONFIG_DIR } from "../version.ts";

export interface Frontmatter {
  attrs: Record<string, string | string[]>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { attrs: {}, body: text };
  const attrs: Record<string, string | string[]> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  let currentKey: string | undefined;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const existing = attrs[currentKey];
      const value = stripQuotes(listItem[1]!.trim());
      attrs[currentKey] = Array.isArray(existing) ? [...existing, value] : [value];
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    currentKey = pair[1]!;
    const raw = pair[2]!.trim();
    if (!raw) {
      attrs[currentKey] = [];
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      attrs[currentKey] = raw
        .slice(1, -1)
        .split(",")
        .map((entry) => stripQuotes(entry.trim()))
        .filter(Boolean);
      continue;
    }
    attrs[currentKey] = stripQuotes(raw);
  }

  return { attrs, body: match[2] ?? "" };
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function attrString(attrs: Record<string, string | string[]>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.join(", ");
  }
  return undefined;
}

function attrList(attrs: Record<string, string | string[]>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) {
      return value
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return undefined;
}

export interface ExtensionPaths {
  root: string;
  home: string;
}

export function extensionDirs(paths: ExtensionPaths): {
  skills: string[];
  commands: string[];
  agents: string[];
} {
  return {
    skills: [
      path.join(paths.home, "skills"),
      path.join(paths.root, CONFIG_DIR, "skills"),
    ],
    commands: [
      path.join(paths.home, "commands"),
      path.join(paths.root, CONFIG_DIR, "commands"),
    ],
    agents: [
      path.join(paths.home, "agents"),
      path.join(paths.root, CONFIG_DIR, "agents"),
    ],
  };
}

export function loadSkills(dirs: string[]): SkillDefinition[] {
  const skills = new Map<string, SkillDefinition>();
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const file = path.join(skillDir, "SKILL.md");
      if (!fileExists(file)) continue;
      const skill = parseSkill(file, skillDir, entry.name);
      if (skill) skills.set(skill.name, skill);
    }
  }
  return [...skills.values()];
}

function parseSkill(file: string, dir: string, fallbackName: string): SkillDefinition | undefined {
  try {
    const { attrs, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = attrString(attrs, "name") ?? fallbackName;
    const description = attrString(attrs, "description") ?? firstParagraph(body) ?? name;
    const files: string[] = [];
    collectFiles(dir, dir, files, 40);
    return {
      name,
      description,
      body: body.trim(),
      dir,
      files,
      source: file,
      ...(attrString(attrs, "when_to_use", "whenToUse", "when") ? { whenToUse: attrString(attrs, "when_to_use", "whenToUse", "when")! } : {}),
      ...(attrString(attrs, "argument-hint", "argumentHint") ? { argumentHint: attrString(attrs, "argument-hint", "argumentHint")! } : {}),
    };
  } catch {
    return undefined;
  }
}

function collectFiles(root: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(root, full, out, limit);
    else if (entry.name !== "SKILL.md") out.push(path.relative(root, full));
  }
}

export function loadCommands(dirs: string[]): CommandDefinition[] {
  const commands = new Map<string, CommandDefinition>();
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue;
    for (const file of walkMarkdown(dir)) {
      const name = path.relative(dir, file).replace(/\.md$/, "").split(path.sep).join(":");
      const command = parseCommand(file, name);
      if (command) commands.set(command.name, command);
    }
  }
  return [...commands.values()];
}

function walkMarkdown(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full, depth + 1));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function parseCommand(file: string, fallbackName: string): CommandDefinition | undefined {
  try {
    const { attrs, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = (attrString(attrs, "name") ?? fallbackName).replace(/^\//, "").toLowerCase();
    const description = attrString(attrs, "description") ?? firstParagraph(body) ?? `Run ${name}`;
    return {
      name,
      description,
      template: body.trim(),
      source: file,
      ...(attrString(attrs, "argument-hint", "argumentHint") ? { argumentHint: attrString(attrs, "argument-hint", "argumentHint")! } : {}),
      ...(attrString(attrs, "model") ? { model: attrString(attrs, "model")! } : {}),
      ...(attrString(attrs, "effort") ? { effort: attrString(attrs, "effort")! } : {}),
    };
  } catch {
    return undefined;
  }
}

export function loadAgents(dirs: string[]): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue;
    for (const file of walkMarkdown(dir)) {
      const name = path.basename(file).replace(/\.md$/, "");
      const agent = parseAgent(file, name);
      if (agent) agents.set(agent.name, agent);
    }
  }
  return [...agents.values()];
}

function parseAgent(file: string, fallbackName: string): AgentDefinition | undefined {
  try {
    const { attrs, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = (attrString(attrs, "name") ?? fallbackName).toLowerCase().replace(/\s+/g, "-");
    const description = attrString(attrs, "description") ?? firstParagraph(body) ?? `The ${name} subagent`;
    const tools = attrList(attrs, "tools");
    const readOnlyAttr = attrString(attrs, "read_only", "readonly", "readOnly");
    return {
      name,
      description,
      prompt: body.trim(),
      source: file,
      ...(tools ? { tools } : {}),
      ...(attrString(attrs, "model") ? { model: attrString(attrs, "model")! } : {}),
      ...(readOnlyAttr !== undefined
        ? { readOnly: readOnlyAttr === "true" || readOnlyAttr === "yes" }
        : tools && tools.every((tool) => ["read", "glob", "grep"].includes(tool))
          ? { readOnly: true }
          : {}),
    };
  } catch {
    return undefined;
  }
}

function firstParagraph(body: string): string | undefined {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/^#.*$/gm, "").trim())
    .find((entry) => entry.length > 0);
  return paragraph ? paragraph.split("\n")[0]!.slice(0, 200) : undefined;
}

export function builtinAgents(): AgentDefinition[] {
  return [
    {
      name: "explore",
      description: "Read-only search across the repository: locates code, maps behaviour and reports findings with file:line references.",
      readOnly: true,
      tools: ["read", "glob", "grep", "bash", "web_fetch"],
      source: "builtin",
      prompt: [
        "You explore a codebase and report what you find. You are read-only: never modify files.",
        "Search broadly, then read the specific regions that matter. Follow imports and call sites to the point where you can explain the behaviour.",
        "Report: the answer first, then the evidence — file paths with line numbers, the key function or type names, and the control flow that connects them.",
        "If something is missing or inconsistent, say so explicitly. Do not speculate about code you did not read.",
      ].join("\n"),
    },
    {
      name: "general",
      description: "Full-capability subagent for a self-contained task: can read, search, edit and run commands.",
      tools: undefined,
      source: "builtin",
      prompt: [
        "You complete a bounded task end to end in the repository.",
        "Work autonomously: investigate, change what is needed, and verify the result with the project's own tests or build.",
        "Report what you changed (paths) and how you verified it. Keep unrelated refactors out.",
      ].join("\n"),
    },
    {
      name: "plan",
      description: "Read-only architect that produces an implementation plan with file-level steps and risks.",
      readOnly: true,
      tools: ["read", "glob", "grep", "bash"],
      source: "builtin",
      prompt: [
        "You design an implementation plan. Read the code first; never propose changes to code you have not inspected.",
        "Return: the approach in a few sentences, then ordered steps each naming the file and the change, then the risks and the verification strategy.",
        "Prefer the smallest change that satisfies the requirement, and follow existing patterns in the repository.",
      ].join("\n"),
    },
  ];
}

export function mergeAgents(defined: AgentDefinition[], builtins = builtinAgents()): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  for (const agent of builtins) map.set(agent.name, agent);
  for (const agent of defined) map.set(agent.name, agent);
  return [...map.values()];
}

export function substituteArguments(template: string, args: string): string {
  const positional = args.trim().split(/\s+/);
  let out = template.replace(/\$ARGUMENTS\b/g, args.trim());
  out = out.replace(/\$(\d)/g, (_match, index: string) => positional[Number(index) - 1] ?? "");
  return out.replace(/\$ARGUMENTS_ALL\b/g, args.trim());
}
