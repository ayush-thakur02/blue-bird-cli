import fs from "node:fs";
import path from "node:path";
import type { CheckpointApi, CheckpointInfo, Logger } from "./contracts.ts";
import { ensureDirSync, readJsonSync, writeJsonAtomic } from "../util/paths.ts";
import { shortId } from "../util/ids.ts";

interface StoredFile {
  path: string;
  existed: boolean;
  encoding: "utf8" | "base64";
  content?: string;
  additions?: number;
  deletions?: number;
  tooLarge?: boolean;
}

interface StoredCheckpoint {
  id: string;
  label: string;
  sessionId: string;
  ts: number;
  turn: number;
  files: StoredFile[];
}

interface Store {
  version: 1;
  sessionId: string;
  checkpoints: StoredCheckpoint[];
}

export interface CheckpointOptions {
  dir: string;
  sessionId: string;
  /** Files larger than this are not snapshotted. */
  maxFileBytes?: number;
  /** Keep at most this many checkpoints per session. */
  maxCheckpoints?: number;
  logger?: Logger;
}

const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_MAX_CHECKPOINTS = 60;
/** Armed-but-uncommitted turns kept in memory; a safety net against a leaked turn. */
const MAX_PENDING = 8;

/**
 * Records the pre-edit content of every file the agent mutates so the user can
 * rewind a turn with /undo. Restores are content-based rather than git-based so
 * they work in any directory, git repo or not.
 */
export class CheckpointManager implements CheckpointApi {
  private readonly options: CheckpointOptions;
  private store: Store;
  private readonly pending = new Map<string, StoredCheckpoint>();

  constructor(options: CheckpointOptions) {
    this.options = options;
    this.store = readJsonSync<Store>(this.file) ?? { version: 1, sessionId: options.sessionId, checkpoints: [] };
  }

  get file(): string {
    return path.join(this.options.dir, `${this.options.sessionId}.json`);
  }

  arm(turnId: string, label: string, turn: number): void {
    if (this.pending.has(turnId)) return;
    if (this.pending.size >= MAX_PENDING) this.releaseOldestPending();
    this.pending.set(turnId, {
      id: newCheckpointId(turn),
      label,
      sessionId: this.options.sessionId,
      ts: Date.now(),
      turn,
      files: [],
    });
  }

  /** Drops an armed turn that was never committed so a crash mid-turn cannot leak it. */
  private releaseOldestPending(): void {
    const oldest = this.pending.keys().next();
    if (!oldest.done) this.pending.delete(oldest.value);
  }

  capture(turnId: string, filePath: string): void {
    const checkpoint = this.pending.get(turnId);
    if (!checkpoint) return;
    const absolute = path.resolve(filePath);
    if (checkpoint.files.some((entry) => entry.path === absolute)) return;
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    try {
      const stats = fs.statSync(absolute);
      if (!stats.isFile()) return;
      if (stats.size > maxBytes) {
        checkpoint.files.push({ path: absolute, existed: true, encoding: "utf8", tooLarge: true });
        return;
      }
      const buffer = fs.readFileSync(absolute);
      const text = decodeIfText(buffer);
      if (text !== undefined) checkpoint.files.push({ path: absolute, existed: true, encoding: "utf8", content: text });
      else checkpoint.files.push({ path: absolute, existed: true, encoding: "base64", content: buffer.toString("base64") });
    } catch {
      checkpoint.files.push({ path: absolute, existed: false, encoding: "utf8" });
    }
  }

  setDelta(turnId: string, filePath: string, delta: { added: number; removed: number }): void {
    const checkpoint = this.pending.get(turnId);
    if (!checkpoint) return;
    const entry = checkpoint.files.find((file) => file.path === path.resolve(filePath));
    if (!entry) return;
    entry.additions = (entry.additions ?? 0) + delta.added;
    entry.deletions = (entry.deletions ?? 0) + delta.removed;
  }

  commit(turnId: string): CheckpointInfo | undefined {
    const checkpoint = this.pending.get(turnId);
    if (!checkpoint) return undefined;
    this.pending.delete(turnId);
    if (checkpoint.files.length === 0) return undefined;

    const existing = this.store.checkpoints.findIndex((entry) => entry.id === checkpoint.id);
    if (existing === -1) this.store.checkpoints.push(checkpoint);
    else this.store.checkpoints[existing] = checkpoint;

    const max = this.options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    if (this.store.checkpoints.length > max) this.store.checkpoints = this.store.checkpoints.slice(-max);
    this.flush();
    return toInfo(checkpoint);
  }

  list(limit = 20): CheckpointInfo[] {
    return [...this.store.checkpoints]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map(toInfo);
  }

  get(id: string): StoredCheckpoint | undefined {
    return this.store.checkpoints.find((entry) => entry.id === id);
  }

  async restore(id: string): Promise<{ restored: string[]; missing: string[] }> {
    const checkpoint = this.store.checkpoints.find((entry) => entry.id === id);
    if (!checkpoint) return { restored: [], missing: [] };
    const restored: string[] = [];
    const missing: string[] = [];
    for (const file of checkpoint.files) {
      try {
        if (!file.existed) {
          fs.rmSync(file.path, { force: true });
          restored.push(file.path);
          continue;
        }
        if (file.tooLarge) {
          missing.push(file.path);
          continue;
        }
        ensureDirSync(path.dirname(file.path));
        const data = file.encoding === "base64" ? Buffer.from(file.content ?? "", "base64") : (file.content ?? "");
        fs.writeFileSync(file.path, data);
        restored.push(file.path);
      } catch {
        missing.push(file.path);
      }
    }
    this.store.checkpoints = this.store.checkpoints.filter((entry) => entry.id !== id);
    this.flush();
    return { restored, missing };
  }

  async drop(id: string): Promise<void> {
    this.store.checkpoints = this.store.checkpoints.filter((entry) => entry.id !== id);
    this.flush();
  }

  private flush(): void {
    try {
      ensureDirSync(this.options.dir);
      writeJsonAtomic(this.file, this.store);
    } catch (error) {
      this.options.logger?.debug(`Could not persist checkpoints: ${(error as Error).message}`);
    }
  }
}

function toInfo(checkpoint: StoredCheckpoint): CheckpointInfo {
  return {
    id: checkpoint.id,
    label: checkpoint.label,
    sessionId: checkpoint.sessionId,
    ts: checkpoint.ts,
    turn: checkpoint.turn,
    files: checkpoint.files.map((file) => ({
      path: file.path,
      existed: file.existed,
      ...(file.additions !== undefined ? { additions: file.additions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    })),
  };
}

function decodeIfText(buffer: Buffer): string | undefined {
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) return undefined;
  const text = buffer.toString("utf8");
  return text.includes("\uFFFD") ? undefined : text;
}

export function newCheckpointId(turn: number): string {
  return `cp-${turn}-${shortId(6)}`;
}
