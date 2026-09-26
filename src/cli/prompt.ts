import readline from "node:readline";
import { sgr } from "../ui/ansi.ts";

export interface AskOptions {
  default?: string;
  /** Return an error message to reject the answer. */
  validate?: (value: string) => string | undefined;
  allowEmpty?: boolean;
}

export async function ask(question: string, options: AskOptions = {}): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const suffix = options.default ? ` ${dim(`[${options.default}]`)}` : "";
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${question}${suffix} `, resolve);
      });
      const value = answer.trim() || options.default || "";
      if (!value && !options.allowEmpty && !options.default) {
        process.stdout.write("  a value is required\n");
        continue;
      }
      const error = options.validate?.(value);
      if (error) {
        process.stdout.write(`  ${error}\n`);
        continue;
      }
      return value;
    }
  } finally {
    rl.close();
  }
}

export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise<string>((resolve) => {
    process.stdout.write(`${question} `);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (char === "\u001b") continue;
        value += char;
        process.stdout.write("*");
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? "Y/n" : "y/N";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} ${dim(`[${hint}]`)} `, resolve);
    });
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return defaultValue;
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

export async function choose<T extends string>(
  question: string,
  options: { value: T; label: string; hint?: string }[],
  defaultIndex = 0,
): Promise<T> {
  process.stdout.write(`${question}\n`);
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? "*" : " ";
    process.stdout.write(`  ${marker} ${index + 1}) ${option.label}${option.hint ? dim(`  ${option.hint}`) : ""}\n`);
  });
  const answer = await ask("Choose", {
    default: String(defaultIndex + 1),
    validate: (value) => {
      const index = Number(value);
      return Number.isInteger(index) && index >= 1 && index <= options.length ? undefined : `enter 1-${options.length}`;
    },
  });
  return options[Number(answer) - 1]!.value;
}

export function dim(text: string): string {
  return sgr(2)(text);
}

export function bold(text: string): string {
  return sgr(1)(text);
}

export function accent(text: string): string {
  return sgr(36)(text);
}
