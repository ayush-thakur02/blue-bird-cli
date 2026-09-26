import fs from "node:fs";
import path from "node:path";
import { listSessions, exportTranscript, loadSessionMeta, readTranscript, findSessionAnywhere } from "../core/session.ts";
import { bluebirdHome, findWorkspaceRoot, relativePath } from "../util/paths.ts";
import { formatBytes, formatCount, formatDuration } from "../util/text.ts";
import { dim, accent, bold } from "../cli/prompt.ts";

export interface SessionsOptions {
  cwd: string;
  action: string;
  id?: string;
  target?: string;
  limit?: number;
  /** Retention window for `prune`, in days (`--days`). */
  days?: number;
  json?: boolean;
  includeArchived?: boolean;
}

export function sessionsDir(cwd: string): string {
  return path.join(findWorkspaceRoot(cwd), ".bluebird", "sessions");
}

export function globalIndexPath(): string {
  return path.join(bluebirdHome(), "sessions.json");
}

export async function runSessionsCommand(options: SessionsOptions): Promise<number> {
  const dir = sessionsDir(options.cwd);

  switch (options.action) {
    case "list":
    case "ls": {
      const entries = listSessions(dir, {
        limit: options.limit ?? 20,
        ...(options.includeArchived ? { includeArchived: true } : {}),
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return 0;
      }
      if (entries.length === 0) {
        process.stdout.write(`No sessions in ${relativePath(options.cwd, dir)}\n`);
        return 0;
      }
      process.stdout.write(`${bold(`${entries.length} session(s)`)} ${dim(dir)}\n\n`);
      for (const entry of entries) {
        process.stdout.write(
          `  ${accent(entry.id)}  ${dim(
            `${new Date(entry.updatedAt).toLocaleString()} · ${entry.messages} msgs · ${formatCount(entry.usage?.totalTokens ?? 0)} tok · ${entry.provider}/${entry.model}`,
          )}\n`,
        );
        if (entry.title) process.stdout.write(`      ${entry.title}\n`);
      }
      process.stdout.write(`\n${dim("resume with: bluebird resume <id>")}\n`);
      return 0;
    }

    case "show": {
      if (!options.id) {
        usage();
        return 1;
      }
      const meta = loadSessionMeta(path.join(dir, `${options.id}.meta.json`));
      if (!meta) {
        const found = findSessionAnywhere(options.id, globalIndexPath());
        if (!found) {
          process.stderr.write(`bluebird: no session ${options.id}\n`);
          return 1;
        }
        process.stdout.write(`${JSON.stringify(found.meta, null, 2)}\n`);
        return 0;
      }
      const messages = readTranscript(path.join(dir, `${options.id}.messages.jsonl`));
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ meta, messages }, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`${bold(meta.title ?? meta.id)}\n`);
      process.stdout.write(`  session   ${meta.id}\n`);
      process.stdout.write(`  model     ${meta.provider}/${meta.model}\n`);
      process.stdout.write(`  created   ${new Date(meta.createdAt).toLocaleString()}\n`);
      process.stdout.write(`  updated   ${new Date(meta.updatedAt).toLocaleString()}\n`);
      process.stdout.write(`  messages  ${messages.length} (${meta.turns} turns)\n`);
      process.stdout.write(
        `  usage     ${formatCount(meta.usage?.inputTokens ?? 0)} in / ${formatCount(meta.usage?.outputTokens ?? 0)} out${meta.usage?.costUsd ? ` · $${meta.usage.costUsd.toFixed(4)}` : ""}\n`,
      );
      if (meta.gitBranch) process.stdout.write(`  branch    ${meta.gitBranch}\n`);
      return 0;
    }

    case "rm":
    case "remove": {
      if (!options.id) {
        usage();
        return 1;
      }
      const metaFile = path.join(dir, `${options.id}.meta.json`);
      const transcript = path.join(dir, `${options.id}.messages.jsonl`);
      if (!fs.existsSync(metaFile) && !fs.existsSync(transcript)) {
        process.stderr.write(`bluebird: no session ${options.id}\n`);
        return 1;
      }
      fs.rmSync(metaFile, { force: true });
      fs.rmSync(transcript, { force: true });
      process.stdout.write(`${accent("✓")} removed session ${options.id}\n`);
      return 0;
    }

    case "export": {
      if (!options.id) {
        usage();
        return 1;
      }
      const meta = loadSessionMeta(path.join(dir, `${options.id}.meta.json`));
      const messages = readTranscript(path.join(dir, `${options.id}.messages.jsonl`));
      if (!meta || messages.length === 0) {
        process.stderr.write(`bluebird: no transcript for ${options.id}\n`);
        return 1;
      }
      const content = exportTranscript(messages, meta);
      const target = options.target ?? path.join(options.cwd, `bluebird-${options.id}.md`);
      fs.writeFileSync(target, content);
      process.stdout.write(`${accent("✓")} wrote ${relativePath(options.cwd, path.resolve(target))} ${dim(formatBytes(content.length))}\n`);
      return 0;
    }

    case "prune": {
      // Documented as `--days n`; reading only `--limit` meant the flag was
      // accepted and ignored.
      const retention = options.days ?? options.limit ?? 30;
      let removed = 0;
      const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
      for (const entry of listSessions(dir, { includeArchived: true })) {
        if (entry.updatedAt > cutoff) continue;
        fs.rmSync(path.join(dir, `${entry.id}.meta.json`), { force: true });
        fs.rmSync(path.join(dir, `${entry.id}.messages.jsonl`), { force: true });
        removed += 1;
      }
      process.stdout.write(`${accent("✓")} pruned ${removed} session(s) older than ${retention} days\n`);
      return 0;
    }

    case "stats": {
      const entries = listSessions(dir, { includeArchived: true });
      const tokens = entries.reduce((sum, entry) => sum + (entry.usage?.totalTokens ?? 0), 0);
      const cost = entries.reduce((sum, entry) => sum + (entry.usage?.costUsd ?? 0), 0);
      const oldest = entries.length ? Math.min(...entries.map((entry) => entry.createdAt)) : Date.now();
      process.stdout.write(`${bold("Sessions")}      ${entries.length}\n`);
      process.stdout.write(`${bold("Tokens")}        ${formatCount(tokens)}\n`);
      process.stdout.write(`${bold("Cost")}          $${cost.toFixed(4)}\n`);
      process.stdout.write(`${bold("History")}       ${formatDuration(Date.now() - oldest)}\n`);
      return 0;
    }

    default:
      // An unknown action is a mistake, not a successful no-op.
      process.stderr.write(`bluebird: unknown sessions action "${options.action}"\n\n`);
      usage();
      return 1;
  }
}

function usage(): void {
  process.stdout.write(
    [
      "Usage: bluebird sessions <action> [id]",
      "",
      "  list [--limit n] [--all] [--json]   recent sessions for this project",
      "  show <id> [--json]                  metadata and message count",
      "  export <id> [file]                  write a markdown transcript",
      "  rm <id>                             delete a session",
      "  prune [--days n]                    delete sessions older than n days",
      "  stats                               totals for this project",
    ].join("\n") + "\n",
  );
}
