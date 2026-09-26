const WORD = /[A-Za-z0-9_]/;
const SPACE = /\s/;

/**
 * Provider-agnostic token estimate calibrated against cl100k for mixed prose and code.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let i = 0;
  const length = text.length;
  while (i < length) {
    const ch = text[i]!;
    if (SPACE.test(ch)) {
      i += 1;
      continue;
    }
    if (WORD.test(ch)) {
      let j = i;
      while (j < length && WORD.test(text[j]!)) j += 1;
      tokens += Math.ceil((j - i) / 4);
      i = j;
    } else {
      let j = i;
      while (j < length && !SPACE.test(text[j]!) && !WORD.test(text[j]!)) j += 1;
      tokens += Math.ceil((j - i) / 2);
      i = j;
    }
  }
  return Math.max(1, tokens);
}

/**
 * Tokens for one message, adding chat framing and per-tool-call overhead.
 */
export function estimateMessageTokens(message: { role: string; content: string; toolCalls?: number }): number {
  const framing = 4;
  const toolOverhead = (message.toolCalls ?? 0) * 12;
  return estimateTokens(message.role) + estimateTokens(message.content) + framing + toolOverhead;
}

/**
 * Total estimated tokens across a conversation.
 */
export function estimateConversationTokens(
  messages: readonly { role: string; content: string; toolCalls?: number }[],
): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/**
 * Approximate cost of an image for a vision model. Mirrors Anthropic's
 * (width × height) / 750 rule and OpenAI's 512px tiling heuristic, taking the
 * smaller of the two so budgets stay conservative.
 */
export function estimateImageTokens(width?: number, height?: number, detail: "auto" | "low" | "high" = "auto"): number {
  if (!width || !height) return 1105;
  const longEdge = Math.max(width, height);
  const scale = detail === "low" ? Math.min(1, 512 / longEdge) : Math.min(1, 1568 / longEdge);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const anthropic = Math.ceil((scaledWidth * scaledHeight) / 750);
  const tiles = detail === "low" ? 1 : Math.ceil(scaledWidth / 512) * Math.ceil(scaledHeight / 512);
  const openai = 85 + 170 * tiles;
  return Math.max(64, Math.min(anthropic, openai));
}

/**
 * Input budget after reserving room for the model's response.
 */
export function tokenBudget(contextWindow: number, reserveOutputTokens: number): number {
  return Math.max(0, contextWindow - reserveOutputTokens);
}

/**
 * Fraction of the context window used, clamped to 0..1.
 */
export function usageRatio(used: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.min(1, Math.max(0, used / contextWindow));
}

function trimNumber(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Compact token count such as "1.2k", "200k", "1M".
 */
export function formatTokenCount(tokens: number): string {
  const sign = tokens < 0 ? "-" : "";
  const abs = Math.abs(tokens);
  if (abs < 1000) return `${tokens}`;
  if (abs < 1_000_000) return `${sign}${trimNumber(abs / 1000, 1)}k`;
  if (abs < 1_000_000_000) return `${sign}${trimNumber(abs / 1_000_000, 1)}M`;
  return `${sign}${trimNumber(abs / 1_000_000_000, 1)}B`;
}

/**
 * Tokens still available after usage and the output reservation.
 */
export function remainingTokens(used: number, contextWindow: number, reserveOutputTokens: number): number {
  return Math.max(0, tokenBudget(contextWindow, reserveOutputTokens) - used);
}
