export type ErrorCode =
  | "config"
  | "provider"
  | "tool"
  | "permission"
  | "aborted"
  | "network"
  | "rate_limit"
  | "context_overflow"
  | "session"
  | "hook"
  | "io"
  | "usage";

export class BlueBirdError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "BlueBirdError";
    this.code = code;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? false;
  }
}

export class ConfigError extends BlueBirdError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super("config", message, opts);
    this.name = "ConfigError";
  }
}

export class ProviderError extends BlueBirdError {
  readonly status?: number;
  readonly provider?: string;
  /** Response headers of the failed request, when there was one (Retry-After lives here). */
  readonly headers?: Headers;

  constructor(
    message: string,
    opts: { status?: number; provider?: string; hint?: string; retryable?: boolean; cause?: unknown; headers?: Headers } = {},
  ) {
    super("provider", message, opts);
    this.name = "ProviderError";
    this.status = opts.status;
    this.provider = opts.provider;
    this.headers = opts.headers;
  }
}

export class ToolError extends BlueBirdError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super("tool", message, opts);
    this.name = "ToolError";
  }
}

export class AbortError extends BlueBirdError {
  constructor(message = "Operation cancelled") {
    super("aborted", message);
    this.name = "AbortError";
  }
}

export function abortError(): AbortError {
  return new AbortError();
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortError) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError" || /aborted|abort signal/i.test(error.message);
  }
  return false;
}

export function errorMessage(error: unknown): string {
  if (error instanceof BlueBirdError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function errorHint(error: unknown): string | undefined {
  if (error instanceof BlueBirdError) return error.hint;
  return undefined;
}

export function errorStack(error: unknown): string {
  if (error instanceof Error && error.stack) return error.stack;
  return errorMessage(error);
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof BlueBirdError) return error.retryable;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code)) {
      return true;
    }
    return /fetch failed|socket hang up|network|terminated/i.test(error.message);
  }
  return false;
}

export function describeHttpFailure(status: number, body: string): { message: string; hint?: string; retryable: boolean } {
  const trimmed = body.trim().slice(0, 600);
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const hints: Record<number, string> = {
    400: "The request was rejected. Check the model id and that the endpoint speaks this API dialect.",
    401: "Authentication failed. Verify the API key for this provider (bluebird config set providers.<id>.apiKey).",
    403: "Access denied. The key may lack permission for this model or deployment.",
    404: "Endpoint or model not found. Check baseURL and model id — baseURL usually ends in /v1.",
    413: "Request too large. Lower context.compactAt or clear the session.",
    422: "The provider could not process the request payload.",
    429: "Rate limited or out of quota. Blue Bird will back off and retry.",
    500: "Provider internal error. Retrying.",
    502: "Bad gateway from the provider. Retrying.",
    503: "Provider unavailable. Retrying.",
    504: "Provider gateway timeout. Retrying.",
  };
  return {
    message: `HTTP ${status}${trimmed ? `: ${trimmed}` : ""}`,
    hint: hints[status],
    retryable,
  };
}
