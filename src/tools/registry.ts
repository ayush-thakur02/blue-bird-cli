import type { PermissionRequest } from "../core/contracts.ts";
import type { ImageAttachment, ToolCallBlock } from "../core/messages.ts";
import { truncateToolOutput } from "../core/context.ts";
import { ToolError, errorMessage, isAbortError } from "../util/errors.ts";
import { relativePath } from "../util/paths.ts";
import { validateArgs } from "./args.ts";
import type { Tool, ToolCallOutcome, ToolContext, ToolSpec } from "./types.ts";

export class ToolRegistry {
  private readonly tools: Tool[];
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    this.tools = tools;
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  all(): Tool[] {
    return this.tools;
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  enabled(ctx: ToolContext): Tool[] {
    return this.tools.filter((tool) => (tool.isEnabled ? tool.isEnabled(ctx) : true));
  }

  specs(ctx: ToolContext): ToolSpec[] {
    return this.enabled(ctx).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
  }

  names(ctx: ToolContext): string[] {
    return this.enabled(ctx).map((tool) => tool.name);
  }

  describe(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): string {
    if (tool.describe) {
      try {
        return tool.describe(args, ctx);
      } catch {
        // fall through to the generic description
      }
    }
    const target =
      (args.file_path as string) ??
      (args.path as string) ??
      (args.pattern as string) ??
      (args.command as string) ??
      (args.description as string) ??
      "";
    return target ? `${tool.name}(${truncateInline(String(target))})` : tool.name;
  }

  permissionRequest(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): PermissionRequest {
    const paths = collectPaths(args, ctx);
    const command = typeof args.command === "string" ? args.command : undefined;
    const detail = buildDetail(tool, args);
    return {
      tool: tool.name,
      args,
      summary: this.describe(tool, args, ctx),
      risk: tool.risk ?? (tool.readOnly ? "low" : "medium"),
      readOnly: Boolean(tool.readOnly),
      ...(paths.length ? { paths } : {}),
      ...(command ? { command } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  async run(call: ToolCallBlock, ctx: ToolContext): Promise<ToolCallOutcome> {
    const started = Date.now();
    const tool = this.byName.get(call.name);

    const finish = (outcome: Partial<ToolCallOutcome> & { content: string }): ToolCallOutcome => ({
      callId: call.id,
      name: call.name,
      args: call.args,
      isError: false,
      durationMs: Date.now() - started,
      ...outcome,
    });

    if (!tool) {
      const suggestion = suggestTool(call.name, this.tools.map((entry) => entry.name));
      return finish({
        content: `Unknown tool "${call.name}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Available tools: ${this.tools
          .map((entry) => entry.name)
          .join(", ")}`,
        isError: true,
      });
    }

    if (call.parseError) {
      return finish({
        content: `Could not parse the arguments for ${call.name}: ${call.parseError}. Re-issue the call with valid JSON.`,
        isError: true,
      });
    }

    let args = call.args;
    try {
      // Every issue is fatal, not just a missing field: silently discarding a
      // type or enum error made the tool schemas decorative.
      const issues = validateArgs(tool.parameters, args, call.name);
      if (issues.length) {
        const shown = issues.slice(0, 4).map((issue) => `${issue.path} ${issue.message}`);
        const more = issues.length > shown.length ? ` (and ${issues.length - shown.length} more)` : "";
        return finish({
          content: `${call.name} was called with invalid arguments: ${shown.join("; ")}${more}. Fix the arguments and try again.`,
          isError: true,
        });
      }
      if (tool.prepare) args = await tool.prepare(args, ctx);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return finish({ content: `${call.name} rejected the arguments: ${errorMessage(error)}`, isError: true });
    }

    try {
      const result = await tool.execute(args, ctx);
      const maxChars = ctx.config.raw.context?.maxToolOutputChars ?? 24_000;
      const truncated = truncateToolOutput(result.content ?? "", maxChars);
      const images = limitImages(result.images, ctx.config.raw.images?.maxPerMessage ?? 8);
      return finish({
        content: truncated.content || "(no output)",
        isError: result.isError ?? false,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.display ? { display: result.display } : {}),
        ...(images.length ? { images } : {}),
        meta: { ...(result.meta ?? {}), ...(truncated.truncated ? { truncated: true } : {}), durationMs: Date.now() - started },
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = error instanceof ToolError ? error.message : errorMessage(error);
      const hint = error instanceof ToolError && error.hint ? `\n${error.hint}` : "";
      return finish({
        content: `${call.name} failed: ${message}${hint}`,
        isError: true,
      });
    }
  }
}

function limitImages(images: ImageAttachment[] | undefined, budget: number): ImageAttachment[] {
  if (!images?.length) return [];
  if (images.length <= budget) return images;
  return images.slice(0, Math.max(1, budget));
}

function collectPaths(args: Record<string, unknown>, ctx: ToolContext): string[] {
  const out: string[] = [];
  const keys = ["file_path", "path", "notebook_path", "directory"];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value) out.push(value);
  }
  for (const key of ["edits", "files", "paths"]) {
    const value = args[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") out.push(entry);
        else if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const candidate = record.file_path ?? record.path;
          if (typeof candidate === "string") out.push(candidate);
        }
      }
    }
  }
  return out.filter((value, index) => out.indexOf(value) === index && value.length > 0);
}

function buildDetail(tool: Tool, args: Record<string, unknown>): string | undefined {
  if (tool.name === "bash" && typeof args.command === "string") {
    return typeof args.description === "string" ? args.description : undefined;
  }
  if (typeof args.content === "string") return `${args.content.length} characters being written`;
  if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    return `replacing ${JSON.stringify(args.old_string.slice(0, 60))} with ${JSON.stringify(args.new_string.slice(0, 60))}`;
  }
  return undefined;
}

function truncateInline(text: string, max = 72): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function suggestTool(name: string, available: string[]): string | undefined {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  let best: { name: string; score: number } | undefined;
  for (const candidate of available) {
    const target = candidate.toLowerCase().replace(/[^a-z]/g, "");
    if (target === normalized) return candidate;
    if (target.includes(normalized) || normalized.includes(target)) {
      const score = Math.abs(target.length - normalized.length);
      if (!best || score < best.score) best = { name: candidate, score };
    }
  }
  return best?.name;
}

export function formatPathsForDisplay(ctx: ToolContext, paths: string[]): string[] {
  return paths.map((value) => relativePath(ctx.cwd, value));
}
