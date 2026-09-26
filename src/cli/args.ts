export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
  raw: string[];
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "json",
  "verbose",
  "debug",
  "yes",
  "force",
  "global",
  "all",
  "plan",
  "continue",
  "offline",
  "headless",
  "print",
  "stream",
  "quiet",
  "check",
  "list",
  "refresh",
  "danger",
  "include-archived",
]);

const SHORT_FLAGS: Record<string, string> = {
  m: "model",
  p: "permission",
  e: "effort",
  c: "continue",
  C: "cwd",
  h: "help",
  v: "version",
  y: "yes",
  q: "quiet",
  s: "session",
  d: "debug",
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  let command: string | undefined;
  let index = 0;

  const setFlag = (name: string, value: string | boolean) => {
    const existing = flags[name];
    if (existing === undefined) {
      flags[name] = value;
      return;
    }
    if (Array.isArray(existing)) {
      existing.push(String(value));
      return;
    }
    flags[name] = [String(existing), String(value)];
  };

  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const [name, inline] = splitOnce(body, "=");
      if (name.startsWith("no-") && name.length > 3) {
        // `--no-memory` has to be readable both as the flag the user typed and
        // as the negation of `memory`; previously only the stripped form was
        // recorded, so every call site asking for "no-memory" saw false.
        const disabled = inline === undefined ? true : !["false", "0", "no", "off"].includes(inline.toLowerCase());
        setFlag(name, disabled);
        setFlag(name.slice(3), !disabled);
        index += 1;
        continue;
      }
      if (inline !== undefined) {
        setFlag(name, inline);
        index += 1;
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        setFlag(name, true);
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && acceptsAsValue(next)) {
        setFlag(name, next);
        index += 2;
        continue;
      }
      setFlag(name, true);
      index += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const short = token.slice(1, 2);
      const rest = token.slice(2);
      const name = SHORT_FLAGS[short];
      if (!name) {
        positionals.push(token);
        index += 1;
        continue;
      }
      if (rest) {
        if (rest.startsWith("=")) {
          setFlag(name, rest.slice(1));
          index += 1;
          continue;
        }
        // `-qy` is a cluster of boolean flags; without this it was parsed as
        // `--quiet=y` and the second flag vanished.
        const cluster = [...rest];
        if (BOOLEAN_FLAGS.has(name) && cluster.every((char) => BOOLEAN_FLAGS.has(SHORT_FLAGS[char] ?? ""))) {
          setFlag(name, true);
          for (const char of cluster) setFlag(SHORT_FLAGS[char]!, true);
          index += 1;
          continue;
        }
        setFlag(name, rest);
        index += 1;
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        setFlag(name, true);
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && acceptsAsValue(next)) {
        setFlag(name, next);
        index += 2;
        continue;
      }
      setFlag(name, true);
      index += 1;
      continue;
    }

    if (!command) command = token;
    else positionals.push(token);
    index += 1;
  }

  return { command, positionals, flags, raw: [...argv] };
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

/** A leading `-` normally marks the next flag, but negative numbers are values. */
function acceptsAsValue(token: string): boolean {
  return !token.startsWith("-") || /^-\d/.test(token);
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  if (value === true) return true;
  if (value === false || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value !== "false" && value !== "0" && value !== "";
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}
