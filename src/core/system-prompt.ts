import path from "node:path";
import os from "node:os";
import type { ResolvedConfig } from "../config/schema.ts";
import type { AgentDefinition, SkillDefinition } from "./contracts.ts";
import type { MemoryDiscovery } from "./memory.ts";
import { formatMemoryPrompt } from "./memory.ts";
import type { Tool } from "../tools/types.ts";

export interface SystemPromptInput {
  config: ResolvedConfig;
  memory: MemoryDiscovery;
  tools: Tool[];
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  planMode: boolean;
  gitBranch?: string;
  gitStatus?: string;
  platform?: string;
  date?: string;
  mode: "interactive" | "headless" | "subagent";
  parentSession?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [
    identitySection(input),
    environmentSection(input),
    operatingPrinciples(input),
    toolSection(input),
    outputStyleSection(input),
  ];

  const memory = formatMemoryPrompt(input.memory);
  if (memory) sections.push(memory);

  if (input.agents.length) {
    sections.push(
      [
        "# Subagents",
        "Delegate work that would flood this context (broad searches, reading many files, independent investigations) with the `task` tool. Each subagent runs its own loop and returns a summary.",
        "",
        ...input.agents.map(
          (agent) =>
            `- \`${agent.name}\` — ${agent.description}${agent.readOnly ? " (read-only)" : ""}${agent.tools?.length ? ` · tools: ${agent.tools.join(", ")}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  if (input.skills.length) {
    sections.push(
      [
        "# Skills",
        "Call the `skill` tool to load one of these playbooks before doing the work it covers.",
        "",
        ...input.skills.map((skill) => `- \`${skill.name}\` — ${skill.description}`),
      ].join("\n"),
    );
  }

  const custom = input.config.raw.memory?.instructions;
  if (custom?.trim()) sections.push(`# User instructions\n${custom.trim()}`);

  if (input.planMode) sections.push(planModeSection());
  if (input.mode === "subagent") sections.push(subagentSection(input.parentSession));

  return sections.filter(Boolean).join("\n\n");
}

function identitySection(input: SystemPromptInput): string {
  const stance =
    input.mode === "headless"
      ? "You are running headlessly: nobody is watching the transcript. Work autonomously, make reasonable assumptions, and finish the task."
      : "You are pair programming with a developer in their terminal. They can see every tool call and will interrupt when you drift.";
  return [
    "You are Blue Bird, an agentic coding assistant that works directly inside the user's repository.",
    stance,
    `Current model: ${input.config.model.label} · reasoning effort: ${input.config.effort}.`,
  ].join("\n");
}

function environmentSection(input: SystemPromptInput): string {
  const { config } = input;
  const lines = [
    "# Environment",
    `- Working directory: ${config.cwd}`,
    `- Workspace root: ${config.root}`,
    `- Platform: ${input.platform ?? `${os.platform()} ${os.release()}`}`,
    `- Date: ${input.date ?? new Date().toISOString().slice(0, 10)}`,
    `- Shell: ${process.env.SHELL ?? "unknown"}`,
    `- Node: ${process.version}`,
  ];
  if (input.gitBranch) lines.push(`- Git branch: ${input.gitBranch}`);
  if (input.gitStatus) lines.push(`- Git status: ${input.gitStatus.slice(0, 1200)}`);
  const extra = config.raw.permissions?.additionalDirectories ?? [];
  if (extra.length) lines.push(`- Additional allowed directories: ${extra.join(", ")}`);
  if (config.raw.permissions?.preset === "read-only") {
    lines.push("- Permission mode: read-only. You cannot modify files or run mutating commands; produce a plan instead.");
  }
  return lines.join("\n");
}

function operatingPrinciples(input: SystemPromptInput): string {
  const lines = [
    "# How to work",
    "- Read before you change. Never propose an edit to a file you have not inspected in this session.",
    "- Match the codebase: its naming, structure, error handling, dependency choices and formatting. Do not introduce new libraries or patterns unless the task requires it.",
    "- Prefer the smallest change that fully solves the problem, then verify it (run the project's build, tests, linter or type checker with `bash`).",
    "- Search before writing new code: the function you need often already exists. Use `glob` and `grep` first.",
    "- Keep working until the task is genuinely done. If you hit a blocker you cannot resolve, say what is blocked, what you tried, and what decision you need.",
    "- State results, not process. Do not narrate tool calls that the user can already see.",
    "- Track multi-step work with `todo_write`; keep exactly one task in progress.",
    "- When several independent reads or searches are needed, issue them in parallel in a single response.",
    "- Report failures honestly. Never claim a test passed unless you ran it.",
  ];
  if (input.mode !== "headless") {
    lines.push("- Ask a short clarifying question only when the request is genuinely ambiguous or destructive; otherwise pick the sensible default and note the assumption.");
  }
  lines.push(
    "- Never create git commits, push branches, or open pull requests unless the user asks for it.",
    "- Never print or commit secrets (keys, tokens, .env contents).",
  );
  return lines.join("\n");
}

function toolSection(input: SystemPromptInput): string {
  const groups: Record<string, string[]> = {
    Files: [],
    Search: [],
    Execution: [],
    Planning: [],
    Other: [],
  };
  const names = new Set(input.tools.map((tool) => tool.name));
  for (const tool of input.tools) {
    const tag = tool.tags?.[0] ?? "other";
    const bucket =
      tag === "fs"
        ? "Files"
        : tag === "search"
          ? "Search"
          : tag === "exec"
            ? "Execution"
            : tag === "plan"
              ? "Planning"
              : "Other";
    groups[bucket]!.push(tool.name);
  }

  const lines = ["# Tools", "Prefer the dedicated tool over shelling out: `read` over `cat`, `grep` over `rg`, `glob` over `ls`."];
  for (const [bucket, tools] of Object.entries(groups)) {
    if (!tools.length) continue;
    lines.push("", `**${bucket}:** ${tools.map((name) => `\`${name}\``).join(", ")}`);
  }

  const notes: string[] = [];
  if (names.has("edit")) {
    notes.push(
      "- `edit` needs an exact `old_string` match including indentation, and it must be unique in the file. Read the file immediately before editing; if it fails, re-read and retry with more surrounding context.",
    );
  }
  if (names.has("bash")) {
    notes.push(
      "- `bash` commands run non-interactively with a timeout. Avoid anything that waits for input, and never leave a long-running process in the foreground — use `run_in_background` for servers and watchers.",
    );
  }
  if (names.has("todo_write")) {
    notes.push("- `todo_write` replaces the whole list; send every task each time with exactly one `in_progress`.");
  }
  if (names.has("task")) {
    notes.push("- `task` subagents cannot see this conversation. Give them a complete, self-contained brief.");
  }
  const toolPrompts = input.tools.map((tool) => tool.prompt).filter((value): value is string => Boolean(value));
  lines.push("", ...notes, ...toolPrompts.map((text) => `- ${text}`));
  return lines.join("\n");
}

function outputStyleSection(input: SystemPromptInput): string {
  const lines = [
    "# Response style",
    "- Replies are rendered in a terminal: short paragraphs, markdown headings only when structure helps, fenced code for code.",
    "- Answer first, then evidence. No preamble such as \"Great question\" or \"I'll now…\".",
    "- Reference files as `path/to/file.ts:42` so the user can jump to them.",
    "- When you finish a task: one or two sentences on what changed and how you verified it. Nothing else.",
  ];
  if (input.mode === "headless") {
    lines.push("- This run is headless: the final message is the deliverable. Make it complete and self-contained.");
  }
  return lines.join("\n");
}

export function planModeSection(): string {
  return [
    "# Plan mode",
    "The user asked for a plan before any changes. For this turn:",
    "- Investigate freely with read-only tools (read, glob, grep, and read-only bash commands).",
    "- Do not write, edit, or run mutating commands. There are no exceptions; if a change is required to answer, describe it instead.",
    "- Produce a concrete plan: the files you would touch, the exact changes, the order, the risks, and how you would verify the result.",
    "- Finish by asking the user to approve the plan so you can switch to execution.",
    "",
    "End your plan with the exact line: `Ready to implement — approve to proceed.`",
  ].join("\n");
}

export function subagentSection(parentSession?: string): string {
  return [
    "# Subagent mode",
    `You are a subagent spawned by the main Blue Bird session${parentSession ? ` (${parentSession})` : ""}. Your context is isolated: you cannot see the parent conversation and the parent cannot see your tool calls.`,
    "- Return a single, self-contained report: findings, file paths with line numbers, and anything the parent must know to act.",
    "- Do not ask questions; make reasonable assumptions and state them in one line.",
    "- Do not modify files unless your task explicitly requires it.",
  ].join("\n");
}

export function sessionStartReminder(input: { planMode: boolean; model: string; effort: string; tools: number }): string {
  const parts = [`Session started with ${input.model} at ${input.effort} effort and ${input.tools} tools available.`];
  if (input.planMode) parts.push("Plan mode is on: investigate and propose, do not modify.");
  return parts.join(" ");
}

export function relativeLabel(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative.startsWith("..") ? filePath : relative;
}
