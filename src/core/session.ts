import fs from "node:fs";
import path from "node:path";
import type { SessionRef, Usage } from "./contracts.ts";
import type { Message } from "./messages.ts";
import { ensureDirSync, fileExists, readJsonSync, writeJsonAtomic } from "../util/paths.ts";
import { sessionId as newSessionId } from "../util/ids.ts";

export interface SessionMeta {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  root: string;
  model: string;
  provider: string;
  effort: string;
  messages: number;
  turns: number;
  usage: Usage;
  gitBranch?: string;
  archived?: boolean;
  parent?: string;
}

export interface SessionOptions {
  dir: string;
  root: string;
  cwd: string;
  model: string;
  provider: string;
  effort: string;
  id?: string;
  persist?: boolean;
  globalIndex?: string;
  gitBranch?: string;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

export class Session {
  readonly id: string;
  readonly dir: string;
  readonly root: string;
  readonly cwd: string;
  readonly persist: boolean;
  readonly createdAt: number;
  messages: Message[] = [];
  private meta: SessionMeta;
  private readonly globalIndex?: string;
  private dirty = false;
  private lastFlushed = 0;

  constructor(options: SessionOptions) {
    this.id = options.id ?? newSessionId();
    this.dir = options.dir;
    this.root = options.root;
    this.cwd = options.cwd;
    this.persist = options.persist ?? true;
    this.globalIndex = options.globalIndex;
    this.createdAt = Date.now();
    this.meta = {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      cwd: options.cwd,
      root: options.root,
      model: options.model,
      provider: options.provider,
      effort: options.effort,
      messages: 0,
      turns: 0,
      usage: { ...NO_USAGE },
      ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
    };
    if (this.persist) ensureDirSync(this.dir);
  }

  get metaFile(): string {
    return path.join(this.dir, `${this.id}.meta.json`);
  }

  get transcriptFile(): string {
    return path.join(this.dir, `${this.id}.messages.jsonl`);
  }

  info(): SessionMeta {
    return { ...this.meta, messages: this.messages.length };
  }

  ref(): SessionRef {
    return { id: this.id, cwd: this.cwd, dir: this.dir, ...(this.meta.title ? { title: this.meta.title } : {}) };
  }

  append(message: Message): void {
    this.messages.push(message);
    this.dirty = true;
    if (this.persist) this.appendToDisk(message);
  }

  replace(messages: Message[]): void {
    this.messages = messages;
    this.dirty = true;
    this.rewriteTranscript();
  }

  setTitle(title: string): void {
    this.meta.title = title.slice(0, 120);
    this.dirty = true;
  }

  update(partial: Partial<Pick<SessionMeta, "model" | "provider" | "effort" | "gitBranch" | "archived" | "parent">>): void {
    Object.assign(this.meta, partial);
    this.dirty = true;
  }

  addUsage(usage: Usage): void {
    const current = this.meta.usage ?? { ...NO_USAGE };
    this.meta.usage = {
      inputTokens: current.inputTokens + usage.inputTokens,
      outputTokens: current.outputTokens + usage.outputTokens,
      totalTokens: (current.totalTokens ?? 0) + (usage.totalTokens ?? usage.inputTokens + usage.outputTokens),
      cacheReadTokens: (current.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: (current.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      costUsd: (current.costUsd ?? 0) + (usage.costUsd ?? 0),
    };
    this.dirty = true;
  }

  countTurn(): void {
    this.meta.turns += 1;
    this.dirty = true;
  }

  flush(force = false): void {
    if (!this.persist || !this.dirty) return;
    const now = Date.now();
    if (!force && now - this.lastFlushed < 400) return;
    this.lastFlushed = now;
    this.meta.updatedAt = now;
    this.meta.messages = this.messages.length;
    try {
      writeJsonAtomic(this.metaFile, this.meta);
      this.updateGlobalIndex();
      // Cleared only after the write lands: clearing it up front meant a failed
      // write was never retried and the session silently lost its title, usage
      // and turn counts.
      this.dirty = false;
    } catch {
      // persistence failures must never break a session
    }
  }

  private appendToDisk(message: Message): void {
    try {
      ensureDirSync(this.dir);
      fs.appendFileSync(this.transcriptFile, `${JSON.stringify(message)}\n`);
    } catch {
      // ignore
    }
  }

  private rewriteTranscript(): void {
    if (!this.persist) return;
    try {
      ensureDirSync(this.dir);
      fs.writeFileSync(this.transcriptFile, this.messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    } catch {
      // ignore
    }
  }

  private updateGlobalIndex(): void {
    if (!this.globalIndex) return;
    try {
      const index = readJsonSync<Record<string, { root: string; dir: string; title?: string; updatedAt: number; model: string; messages: number }>>(
        this.globalIndex,
      ) ?? {};
      index[this.id] = {
        root: this.root,
        dir: this.dir,
        ...(this.meta.title ? { title: this.meta.title } : {}),
        updatedAt: this.meta.updatedAt,
        model: this.meta.model,
        messages: this.messages.length,
      };
      const entries = Object.entries(index).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      const trimmed = Object.fromEntries(entries.slice(0, 500));
      writeJsonAtomic(this.globalIndex, trimmed);
    } catch {
      // ignore
    }
  }
}

export function loadSessionMeta(file: string): SessionMeta | undefined {
  const meta = readJsonSync<SessionMeta>(file);
  if (!meta || typeof meta.id !== "string") return undefined;
  return meta;
}

export function readTranscript(file: string): Message[] {
  if (!fileExists(file)) return [];
  const messages: Message[] = [];
  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Message;
      if (parsed && typeof parsed === "object" && typeof parsed.role === "string" && Array.isArray(parsed.blocks)) {
        messages.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return messages;
}

export interface SessionListEntry extends SessionMeta {
  file: string;
}

export function listSessions(dir: string, options: { limit?: number; includeArchived?: boolean } = {}): SessionListEntry[] {
  if (!fileExists(dir)) return [];
  const entries: SessionListEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".meta.json")) continue;
    const meta = loadSessionMeta(path.join(dir, file));
    if (!meta) continue;
    if (meta.archived && !options.includeArchived) continue;
    entries.push({ ...meta, file: path.join(dir, file) });
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return options.limit ? entries.slice(0, options.limit) : entries;
}

export interface GlobalSessionRef {
  root: string;
  dir: string;
  title?: string;
  updatedAt: number;
  model: string;
  messages: number;
}

export function findSessionAnywhere(id: string, indexFile: string): { meta: SessionMeta; messages: Message[] } | undefined {
  const index = readJsonSync<Record<string, GlobalSessionRef>>(indexFile) ?? {};
  const entry = index[id];
  const candidates: string[] = [];
  if (entry) candidates.push(path.join(entry.dir, `${id}.meta.json`));
  for (const dir of candidates) {
    const meta = loadSessionMeta(dir);
    if (!meta) continue;
    const messages = readTranscript(path.join(path.dirname(dir), `${id}.messages.jsonl`));
    return { meta, messages };
  }
  return undefined;
}

export function pruneSessions(dir: string, retentionDays: number): number {
  if (!fileExists(dir) || retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of listSessions(dir, { includeArchived: true })) {
    if (entry.updatedAt > cutoff) continue;
    try {
      fs.rmSync(entry.file, { force: true });
      fs.rmSync(path.join(dir, `${entry.id}.messages.jsonl`), { force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

export function exportTranscript(messages: Message[], meta: SessionMeta): string {
  const lines: string[] = [
    `# ${meta.title ?? `Session ${meta.id}`}`,
    "",
    `- session: \`${meta.id}\``,
    `- model: \`${meta.provider}/${meta.model}\``,
    `- updated: ${new Date(meta.updatedAt).toISOString()}`,
    `- messages: ${messages.length}`,
    "",
  ];
  for (const message of messages) {
    if (message.meta?.hidden) continue;
    lines.push(`## ${message.role}`);
    for (const block of message.blocks) {
      if (block.type === "text") lines.push(block.text, "");
      else if (block.type === "thinking") lines.push("<details><summary>reasoning</summary>", "", block.text, "", "</details>", "");
      else if (block.type === "tool_call") lines.push(`**${block.name}** \`${JSON.stringify(block.args)}\``, "");
      else if (block.type === "tool_result") {
        lines.push(`<details><summary>${block.name} output</summary>`, "", "```", block.content.slice(0, 8000), "```", "", "</details>", "");
      }
    }
  }
  return lines.join("\n");
}
