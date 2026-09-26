import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function shortId(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function prefixedId(prefix: string): string {
  return `${prefix}_${shortId(10)}`;
}

export function sessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${shortId(6)}`;
}

export function callId(): string {
  return `call_${shortId(12)}`;
}

export function messageId(): string {
  return `msg_${shortId(12)}`;
}
