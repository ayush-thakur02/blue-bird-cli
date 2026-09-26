import type { ProviderCompat, ResolvedModel } from "../config/schema.ts";
import type { Usage } from "../core/contracts.ts";
import { hashShort } from "../util/paths.ts";

export type CacheMode = "on" | "auto" | "off";

export function cacheMode(compat: ProviderCompat | undefined): CacheMode {
  const value = compat?.promptCache;
  if (value === false) return "off";
  if (value === true) return "on";
  return "auto";
}

/**
 * Hosts known to accept OpenAI's extended cache retention parameter. The cache
 * key itself is attempted everywhere and remembered as unsupported per provider
 * when an endpoint rejects it, so caching is always tried but never spammed.
 */
const CACHE_KEY_HOSTS = [/^api\.openai\.com$/i, /\.openai\.azure\.com$/i, /^api\.deepseek\.com$/i];

export function hostSupportsCacheKey(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname;
    return CACHE_KEY_HOSTS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

const unsupportedByProvider = new Map<string, Set<string>>();

/** Parameters a provider has already rejected in this process. */
export function knownUnsupported(providerId: string): Set<string> {
  return new Set(unsupportedByProvider.get(providerId) ?? []);
}

/** Records a rejected parameter so later requests skip it immediately. */
export function rememberUnsupported(providerId: string, field: string): void {
  const existing = unsupportedByProvider.get(providerId) ?? new Set<string>();
  existing.add(field);
  unsupportedByProvider.set(providerId, existing);
}

export function resetUnsupported(providerId?: string): void {
  if (providerId) unsupportedByProvider.delete(providerId);
  else unsupportedByProvider.clear();
}

export interface CachePlan {
  /** Anthropic-style cache_control breakpoints (system, tools, conversation tail). */
  breakpoints: boolean;
  /** Breakpoints reserved for the conversation tail. */
  tailBreakpoints: number;
  /** Send prompt_cache_key so a session keeps hitting the same cache shard. */
  cacheKey: boolean;
  /** Send prompt_cache_retention. */
  retention?: string;
  /** Send the Anthropic prompt-caching beta header. */
  betaHeader: boolean;
}

export const MAX_ANTHROPIC_BREAKPOINTS = 4;

export function cachePlan(model: ResolvedModel): CachePlan {
  const compat = model.provider.compat ?? {};
  const mode = cacheMode(compat);
  if (mode === "off") {
    return { breakpoints: false, tailBreakpoints: 0, cacheKey: false, betaHeader: false };
  }

  const anthropic = model.api === "anthropic-messages";
  // The cache key is attempted on every OpenAI-compatible host: it is the only
  // way to keep a session pinned to one cache shard, and endpoints that reject
  // it are remembered so the cost is a single extra request per process.
  const supportsKey = compat.promptCacheKey ?? (anthropic ? false : true);
  // Extended retention is newer; only send it where it is known to work.
  const retention = compat.promptCacheRetention ?? (hostSupportsCacheKey(model.baseURL) ? "24h" : undefined);

  // Anthropic: system + last tool definition consume two breakpoints; the rest
  // cache the conversation tail so every turn extends the cached prefix.
  const tailBreakpoints = anthropic ? Math.max(0, Math.min(2, MAX_ANTHROPIC_BREAKPOINTS - 2)) : 0;

  return {
    breakpoints: anthropic,
    tailBreakpoints,
    cacheKey: supportsKey,
    ...(retention ? { retention } : {}),
    betaHeader: Boolean(compat.promptCacheBeta),
  };
}

/**
 * Stable per-session cache key. Sessions keep their key across turns so every
 * request lands on the same cache shard; a different model gets its own key.
 */
export function cacheKeyFor(sessionId: string, modelId: string): string {
  return `bb-${hashShort(`${sessionId}:${modelId}`, 16)}`;
}

export interface CacheMetrics {
  readTokens: number;
  writeTokens: number;
  inputTokens: number;
  /** Share of prompt tokens served from cache, 0..1. */
  hitRatio: number;
  /** Share of prompt tokens written to cache, 0..1. */
  writeRatio: number;
}

export function cacheMetrics(usage: Usage): CacheMetrics {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const input = usage.inputTokens;
  const promptTotal = input + read + write;
  return {
    readTokens: read,
    writeTokens: write,
    inputTokens: input,
    hitRatio: promptTotal > 0 ? read / promptTotal : 0,
    writeRatio: promptTotal > 0 ? write / promptTotal : 0,
  };
}

export function formatCacheSummary(usage: Usage): string | undefined {
  const metrics = cacheMetrics(usage);
  if (metrics.readTokens === 0 && metrics.writeTokens === 0) return undefined;
  const parts = [`cache ${(metrics.hitRatio * 100).toFixed(0)}%`];
  if (metrics.writeTokens) parts.push(`${(metrics.writeRatio * 100).toFixed(0)}% written`);
  return parts.join(" · ");
}

/**
 * Reports whether a provider error looks like a context-window overflow, which
 * the agent can survive by shrinking the effective window instead of failing.
 */
export function isContextOverflow(message: string, status?: number): boolean {
  const lowered = message.toLowerCase();
  if (status === 400 || status === 413 || status === 422) {
    if (/context length|context window|too many tokens|prompt is too long|maximum context|context_length_exceeded|reduce the length|exceeds the maximum|input is too long|request too large/.test(lowered)) {
      return true;
    }
  }
  return /context_length_exceeded|prompt is too long|exceeds the maximum number of tokens|maximum context length|reduce the length of the messages/.test(lowered);
}
