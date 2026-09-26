import { ProviderError, describeHttpFailure } from "../util/errors.ts";
import type { ApiFlavor, ProviderDef } from "../config/schema.ts";

export interface TransportOptions {
  signal: AbortSignal;
  /** Time to first byte in milliseconds. */
  connectTimeoutMs?: number;
  /** Maximum gap between stream chunks before aborting. */
  idleTimeoutMs?: number;
  retries?: number;
  providerId?: string;
}

export const DEFAULT_CONNECT_TIMEOUT = 60_000;
export const DEFAULT_IDLE_TIMEOUT = 180_000;

function azureHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith(".azure.com") || host.endsWith(".azurefd.net") || host.endsWith(".microsoft.com");
  } catch {
    return false;
  }
}

export interface AuthHeaders {
  [name: string]: string;
}

/**
 * Sends the key in every dialect the major gateways understand. Azure wants
 * `api-key`, Anthropic wants `x-api-key`, everything else reads a bearer token.
 */
export function authHeaders(args: { apiKey?: string; baseURL: string; api: ApiFlavor; style?: string }): AuthHeaders {
  const { apiKey, baseURL, api } = args;
  if (!apiKey) return {};
  const style = args.style ?? "auto";
  const headers: AuthHeaders = {};
  const isAzure = azureHost(baseURL);
  const useBearer = style === "bearer" || (style === "auto" && api !== "anthropic-messages" && !isAzure);
  if (style === "bearer" || (style === "auto" && useBearer)) headers.Authorization = `Bearer ${apiKey}`;
  if (style === "api-key" || (style === "auto" && isAzure && api !== "anthropic-messages")) headers["api-key"] = apiKey;
  if (style === "x-api-key" || api === "anthropic-messages") headers["x-api-key"] = apiKey;
  if (style === "auto" && isAzure) headers["api-key"] = apiKey;
  if (Object.keys(headers).length === 0) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export function baseHeaders(def: ProviderDef, apiKey: string | undefined, api: ApiFlavor): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "bluebird-cli/0.1.0",
    ...(def.headers ?? {}),
  };
  Object.assign(headers, authHeaders({ apiKey, baseURL: def.baseURL, api, style: def.compat?.authStyle }));
  return headers;
}

export function joinUrl(baseURL: string, path: string, query?: Record<string, string>): string {
  const url = new URL(`${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export function withQuery(url: string, query: Record<string, string>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of entries) parsed.searchParams.set(key, value);
  return parsed.toString();
}

export interface PostJsonArgs {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  options: TransportOptions;
}

export async function postJson(args: PostJsonArgs): Promise<Response> {
  // Connection-level retries only: once the response is in, a bad status is the
  // agent loop's business (it also owns failover), so the two layers never
  // multiply each other's attempt counts.
  const maxRetries = Math.max(0, args.options.retries ?? 0);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await connectOnce(args);
    } catch (error) {
      lastError = error;
      if (args.options.signal.aborted) throw error;
      const retryable = error instanceof ProviderError && error.retryable;
      if (!retryable || attempt === maxRetries) throw error;
      const delay = retryAfterMs(error.headers) ?? backoffDelay(attempt + 1, 400, 8_000);
      await sleep(delay, args.options.signal);
    }
  }
  throw lastError;
}

async function connectOnce(args: PostJsonArgs): Promise<Response> {
  const { url, body, headers, options } = args;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
  let timedOut = false;
  const connectController = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    connectController.abort();
  }, connectTimeoutMs);
  const signal = AbortSignal.any([options.signal, connectController.signal]);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (timedOut) {
      throw new ProviderError(`Request timed out after ${Math.round(connectTimeoutMs / 1000)}s`, {
        retryable: true,
        provider: options.providerId,
        hint: "Increase providers.<id>.timeoutMs or check network reachability.",
        cause: error,
      });
    }
    throw new ProviderError(`Network error talking to ${safeHost(url)}: ${(error as Error).message}`, {
      retryable: true,
      provider: options.providerId,
      cause: error,
    });
  } finally {
    // Cleared as soon as the response headers are in: the connect budget must not
    // double as a cap on total stream duration, or a long generation is aborted
    // mid-flight and misreported as a user cancellation. `idleTimeoutMs` guards
    // the body from here on.
    clearTimeout(timer);
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function ensureOk(response: Response, providerId: string | undefined, context: string): Promise<void> {
  if (response.ok) return;
  const body = await safeText(response);
  const { message, hint, retryable } = describeHttpFailure(response.status, body);
  throw new ProviderError(`${context} failed — ${message}`, {
    status: response.status,
    retryable,
    provider: providerId,
    headers: response.headers,
    ...(hint ? { hint } : {}),
  });
}

export async function getJson<T>(args: {
  url: string;
  headers: Record<string, string>;
  options: TransportOptions;
}): Promise<T> {
  const timeout = AbortSignal.timeout(args.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT);
  const signal = AbortSignal.any([args.options.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(args.url, { headers: args.headers, signal });
  } catch (error) {
    throw new ProviderError(`Network error talking to ${safeHost(args.url)}: ${(error as Error).message}`, {
      retryable: true,
      provider: args.options.providerId,
      cause: error,
    });
  }
  await ensureOk(response, args.options.providerId, `GET ${safeHost(args.url)}`);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProviderError(`Expected JSON from ${safeHost(args.url)} but received: ${text.slice(0, 200)}`, {
      provider: args.options.providerId,
      cause: error,
    });
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Streams server-sent events, yielding the payload after each `data:` prefix.
 * Handles multi-line data fields, comments, CRLF and non-SSE JSON responses.
 */
export async function* sseEvents(
  response: Response,
  options: TransportOptions,
): AsyncGenerator<string, void, void> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;

  try {
    while (true) {
      const chunk = await withIdleTimeout(reader, idleMs, options);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const rawLine = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trimStart();
          if (payload) yield payload;
        }
        index = buffer.indexOf("\n");
      }
    }
    const tail = (buffer + decoder.decode()).trim();
    if (tail) {
      if (tail.startsWith("data:")) {
        yield tail.slice(5).trimStart();
      } else if (tail.startsWith("{") || tail.startsWith("[")) {
        yield tail;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }
}

interface StreamReadResult {
  done: boolean;
  value?: Uint8Array;
}

async function withIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  options: TransportOptions,
): Promise<StreamReadResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderError(`Stream stalled for ${Math.round(idleMs / 1000)}s with no data`, {
              retryable: true,
              provider: options.providerId,
            }),
          );
        }, idleMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parses either an SSE stream or a single JSON body into provider events. */
export async function* jsonOrSse<T>(response: Response, options: TransportOptions): AsyncGenerator<T, void, void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for await (const payload of sseEvents(response, options)) {
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload) as T;
      } catch {
        const salvaged = salvageJson(payload);
        if (salvaged) yield salvaged as T;
      }
    }
    return;
  }
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("data:")) {
    for (const line of trimmed.split("\n")) {
      const value = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!value || value === "[DONE]") continue;
      try {
        yield JSON.parse(value) as T;
      } catch {
        // ignore malformed line
      }
    }
    return;
  }
  try {
    yield JSON.parse(trimmed) as T;
  } catch {
    const salvaged = salvageJson(trimmed);
    if (salvaged) yield salvaged as T;
    else throw new ProviderError(`Endpoint returned a non-JSON response: ${trimmed.slice(0, 300)}`, {
      provider: options.providerId,
      hint: "Check that baseURL points at the API root (for example .../v1) and that the path is reachable.",
    });
  }
}

function salvageJson(text: string): unknown | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const slice = text.slice(start);
  for (let end = slice.length; end > 1; end -= 1) {
    const candidate = slice.slice(0, end);
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelay(attempt: number, base = 500, max = 15_000): number {
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.random() * exponential * 0.3;
  return Math.round(exponential + jitter);
}

/**
 * `Retry-After` in milliseconds, accepting either a `Headers` object or a whole
 * response. Returns `fallback` when the header is absent or unparseable.
 */
export function retryAfterMs(source: Headers | Response | undefined, fallback?: number): number | undefined {
  const headers = source instanceof Headers ? source : source?.headers;
  const header = headers?.get("retry-after");
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  return fallback;
}
