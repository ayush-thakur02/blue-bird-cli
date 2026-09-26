import type { Message, ToolResultBlock } from "./messages.ts";
import { estimateTokens } from "../util/tokens.ts";
import { imageTokenCost } from "../util/images.ts";

export interface ContextStats {
  systemTokens: number;
  messageTokens: number;
  toolResultTokens: number;
  totalTokens: number;
  contextWindow: number;
  ratio: number;
  remainingTokens: number;
  messages: number;
  turns: number;
}

export function analyzeContext(args: { system: string; messages: Message[]; contextWindow: number; reserveOutput: number }): ContextStats {
  const systemTokens = estimateTokens(args.system);
  let messageTokens = 0;
  let toolResultTokens = 0;
  for (const message of args.messages) {
    let messageTokensForMessage = 0;
    for (const block of message.blocks) {
      if (block.type === "text") messageTokensForMessage += estimateTokens(block.text);
      else if (block.type === "thinking") messageTokensForMessage += estimateTokens(block.text);
      else if (block.type === "tool_call") messageTokensForMessage += estimateTokens(`${block.name} ${JSON.stringify(block.args)}`);
      else if (block.type === "tool_result") {
        const tokens = estimateTokens(block.content);
        messageTokensForMessage += tokens;
        toolResultTokens += tokens;
        for (const image of block.images ?? []) messageTokensForMessage += imageTokenCost(image);
      } else if (block.type === "image") {
        messageTokensForMessage += imageTokenCost(block.image);
      }
    }
    messageTokens += messageTokensForMessage + 4;
  }
  const totalTokens = systemTokens + messageTokens;
  const budget = Math.max(1, args.contextWindow - args.reserveOutput);
  return {
    systemTokens,
    messageTokens,
    toolResultTokens,
    totalTokens,
    contextWindow: args.contextWindow,
    ratio: totalTokens / budget,
    remainingTokens: Math.max(0, budget - totalTokens),
    messages: args.messages.length,
    turns: countTurns(args.messages),
  };
}

export function countTurns(messages: Message[]): number {
  return messages.filter((message) => message.role === "user" && !message.meta?.synthetic).length;
}

export interface TurnSlice {
  start: number;
  end: number;
}

/** Splits the transcript into user turns, each starting at a user message. */
export function splitTurns(messages: Message[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let start = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user" && !message.meta?.synthetic) {
      if (start !== -1) slices.push({ start, end: index });
      start = index;
    }
  }
  if (start !== -1) slices.push({ start, end: messages.length });
  return slices;
}

export interface CompactionPlan {
  /** Messages kept verbatim, in order. */
  keep: Message[];
  /** Prefix of older messages to fold into a summary. */
  fold: Message[];
  /** Recent messages kept untouched for safety. */
  recentTurns: number;
  /** Number of tool results that will be stubbed out. */
  pruneCandidates: number;
}

export function planCompaction(
  messages: Message[],
  options: { keepRecentTurns: number; minKeep?: number },
): CompactionPlan {
  const turns = splitTurns(messages);
  const keepRecent = Math.max(1, options.keepRecentTurns);
  if (turns.length <= keepRecent) {
    return { keep: messages, fold: [], recentTurns: turns.length, pruneCandidates: 0 };
  }
  const cutoffIndex = turns[turns.length - keepRecent]!.start;
  const fold = messages.slice(0, cutoffIndex);
  const keep = messages.slice(cutoffIndex);
  return {
    keep,
    fold,
    recentTurns: keepRecent,
    pruneCandidates: fold.reduce(
      (count, message) => count + message.blocks.filter((block) => block.type === "tool_result" && block.content.length > 400).length,
      0,
    ),
  };
}

const PRUNE_STUB = (name: string, bytes: number) =>
  `[${name} output elided during compaction — ${bytes} characters removed. Re-run the tool if you need this data again.]`;

export function pruneToolResults(messages: Message[], keepRecentTurns: number): { messages: Message[]; pruned: number } {
  const turns = splitTurns(messages);
  const keepFrom = turns.length > keepRecentTurns ? turns[turns.length - keepRecentTurns]!.start : 0;
  let pruned = 0;
  const out = messages.map((message, index) => {
    if (index >= keepFrom) return message;
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== "tool_result") return block;
      const result = block as ToolResultBlock;
      const heavyImages = (result.images?.length ?? 0) > 0;
      if (result.content.length < 400 && !heavyImages) return block;
      changed = true;
      pruned += 1;
      const { images: _dropped, ...rest } = result;
      const note = heavyImages ? ` (and ${result.images!.length} attached image(s))` : "";
      return { ...rest, content: `${PRUNE_STUB(result.name, result.content.length)}${note}` };
    });
    return changed ? { ...message, blocks } : message;
  });
  return { messages: out, pruned };
}

/**
 * Deterministic fallback summary built without an extra model call: lists the
 * work performed so the model keeps a thread even if summarization fails.
 */
export function structuralSummary(messages: Message[]): string {
  const files = new Set<string>();
  const commands = new Set<string>();
  const userAsks: string[] = [];
  const errors: string[] = [];

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "text" && message.role === "user") {
        const text = block.text.trim();
        if (text && !text.startsWith("<")) userAsks.push(text.split("\n")[0]!.slice(0, 200));
      }
      if (block.type === "tool_call") {
        const args = block.args as Record<string, unknown>;
        const target = (args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.query) as string | undefined;
        if (/^(read|write|edit|multi_edit|notebook_edit)$/.test(block.name) && target) files.add(String(target));
        if (block.name === "bash" && typeof args.command === "string") commands.add(args.command.slice(0, 160));
      }
      if (block.type === "tool_result" && block.isError) {
        errors.push(block.content.split("\n")[0]!.slice(0, 200));
      }
    }
  }

  const lines: string[] = ["Summarized earlier work in this session:"];
  if (userAsks.length) {
    lines.push("", "Requests so far:");
    for (const ask of userAsks.slice(-12)) lines.push(`- ${ask}`);
  }
  if (files.size) {
    lines.push("", "Files touched:");
    for (const file of [...files].slice(0, 40)) lines.push(`- ${file}`);
  }
  if (commands.size) {
    lines.push("", "Commands run:");
    for (const command of [...commands].slice(-20)) lines.push(`- \`${command}\``);
  }
  if (errors.length) {
    lines.push("", "Errors encountered:");
    for (const error of errors.slice(-10)) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

export function compactionPrompt(summaryInput: string): string {
  return [
    "Summarize the work performed in this conversation so far into a compact handover note for yourself.",
    "Preserve: user goals and constraints, decisions made and why, files created or modified with their purpose, exact commands that matter (build/test), unresolved problems, and any pending next steps.",
    "Drop: tool output bodies, repeated narration, and anything already captured in code.",
    "Reply with plain markdown under these headings: Goal, Changes, Decisions, Verification, Open questions. Keep it under 500 words.",
    "",
    "--- transcript ---",
    summaryInput,
  ].join("\n");
}

export function transcriptForSummary(messages: Message[], maxChars = 160_000): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    const rendered = renderForSummary(message);
    if (!rendered) continue;
    if (total + rendered.length > maxChars) break;
    total += rendered.length;
    parts.push(rendered);
  }
  return parts.join("\n\n");
}

function renderForSummary(message: Message): string {
  const lines: string[] = [`## ${message.role}`];
  for (const block of message.blocks) {
    if (block.type === "text") lines.push(block.text.slice(0, 4000));
    else if (block.type === "tool_call") lines.push(`tool_call ${block.name}(${JSON.stringify(block.args).slice(0, 400)})`);
    else if (block.type === "tool_result") lines.push(`tool_result ${block.name}: ${block.content.slice(0, 600)}`);
  }
  return lines.join("\n").trim();
}

export function truncateToolOutput(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  const head = content.slice(0, Math.floor(maxChars * 0.7));
  const tail = content.slice(-Math.floor(maxChars * 0.2));
  return {
    content: `${head}\n\n... [${content.length - head.length - tail.length} characters omitted — output truncated by the harness] ...\n\n${tail}`,
    truncated: true,
  };
}
