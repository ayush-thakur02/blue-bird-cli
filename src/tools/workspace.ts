import { ToolError } from "../util/errors.ts";
import { containsPath, relativePath, resolveFrom } from "../util/paths.ts";
import type { ToolContext } from "./types.ts";

export function allowedRoots(ctx: ToolContext): string[] {
  const extra = (ctx.config.raw.permissions?.additionalDirectories ?? []).map((dir) => resolveFrom(ctx.cwd, dir));
  return [ctx.root, ctx.cwd, ...extra];
}

export function resolveTarget(ctx: ToolContext, raw: string): string {
  return resolveFrom(ctx.cwd, raw);
}

export function isAllowedPath(ctx: ToolContext, absolute: string): boolean {
  return allowedRoots(ctx).some((base) => containsPath(base, absolute));
}

export function ensureInsideWorkspace(ctx: ToolContext, absolute: string, verb: string): void {
  if (isAllowedPath(ctx, absolute)) return;
  throw new ToolError(`Refusing to ${verb} ${absolute}: it is outside the workspace`, {
    hint: `The workspace root is ${ctx.root}. Add the directory to permissions.additionalDirectories to allow it.`,
  });
}

export function displayPath(ctx: ToolContext, absolute: string): string {
  return relativePath(ctx.cwd, absolute);
}
