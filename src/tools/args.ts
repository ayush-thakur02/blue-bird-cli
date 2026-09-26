import { ToolError } from "../util/errors.ts";
import type { JsonSchema } from "./types.ts";

type Args = Record<string, unknown>;

function first(args: Args, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * Like `first`, but keeps an empty string. `write` needs this: an empty
 * `content` is a valid request to create or truncate a file.
 */
function firstPresent(args: Args, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function presentString(args: Args, ...keys: string[]): string | undefined {
  const value = firstPresent(args, keys);
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function optionalString(args: Args, ...keys: string[]): string | undefined {
  const value = first(args, keys);
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function requiredString(args: Args, keys: string[], tool: string): string {
  const value = optionalString(args, ...keys);
  if (value === undefined || value.trim() === "") {
    throw new ToolError(`${tool} requires the "${keys[0]}" argument`, {
      hint: `Pass a string value for ${keys[0]}.`,
    });
  }
  return value;
}

export function optionalNumber(args: Args, ...keys: string[]): number | undefined {
  const value = first(args, keys);
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function optionalBoolean(args: Args, ...keys: string[]): boolean | undefined {
  const value = first(args, keys);
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(lowered)) return true;
    if (["false", "no", "0", "off"].includes(lowered)) return false;
  }
  return undefined;
}

export function optionalStringArray(args: Args, ...keys: string[]): string[] | undefined {
  const value = first(args, keys);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string") return [value];
  return undefined;
}

export function optionalObjectArray(args: Args, ...keys: string[]): Record<string, unknown>[] | undefined {
  const value = first(args, keys);
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateArgs(schema: JsonSchema, args: Args, toolName: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = (node: JsonSchema, value: unknown, location: string) => {
    // null is treated as absent throughout the arg helpers, so it is not a type error.
    if (value === undefined || value === null) return;
    if (node.type === "object" && node.properties) {
      if (typeof value !== "object" || Array.isArray(value)) {
        issues.push({ path: location, message: `expected an object` });
        return;
      }
      const record = value as Args;
      for (const required of node.required ?? []) {
        const child = record[required];
        if (child === undefined || child === null) {
          issues.push({ path: `${location}.${required}`, message: "is required" });
        }
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in node.properties)) issues.push({ path: `${location}.${key}`, message: "is not an accepted argument" });
        }
      }
      for (const [key, childSchema] of Object.entries(node.properties)) {
        if (record[key] === undefined || record[key] === null) continue;
        check(childSchema, record[key], location ? `${location}.${key}` : key);
      }
      return;
    }
    if (node.type === "array") {
      if (!Array.isArray(value)) {
        issues.push({ path: location, message: "expected an array" });
        return;
      }
      if (node.items) {
        value.forEach((entry, index) => check(node.items!, entry, `${location}[${index}]`));
      }
      return;
    }
    // The arg helpers coerce numbers, booleans and strings into each other, so
    // validation accepts anything they can recover from and rejects the rest.
    if (node.type === "string" && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      issues.push({ path: location, message: "expected a string" });
      return;
    }
    if (node.type === "number" || node.type === "integer") {
      const coerced = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof coerced !== "number" || !Number.isFinite(coerced)) {
        issues.push({ path: location, message: "expected a number" });
        return;
      }
      if (node.type === "integer" && !Number.isInteger(coerced)) {
        issues.push({ path: location, message: "expected an integer" });
        return;
      }
    }
    if (node.type === "boolean") {
      const coercible = typeof value === "boolean" || (typeof value === "string" && ["true", "false", "yes", "no", "1", "0", "on", "off"].includes(value.toLowerCase()));
      if (!coercible) {
        issues.push({ path: location, message: "expected a boolean" });
        return;
      }
    }
    if (node.enum && !node.enum.includes(value)) {
      issues.push({ path: location, message: `must be one of ${node.enum.map((entry) => JSON.stringify(entry)).join(", ")}` });
    }
  };

  check(schema, args, toolName);
  return issues;
}
