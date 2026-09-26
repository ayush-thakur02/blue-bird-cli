import { ToolRegistry } from "./registry.ts";
import { editTool, multiEditTool, readTool, writeTool } from "./fs.ts";
import { viewImageTool } from "./image.ts";
import { globTool, grepTool } from "./search.ts";
import { bashOutputTool, bashTool, killShellTool } from "./shell.ts";
import { skillTool } from "./skill.ts";
import { taskTool } from "./task.ts";
import { todoTool } from "./todo.ts";
import { webFetchTool, webSearchTool } from "./web.ts";
import type { Tool } from "./types.ts";

export function defaultTools(): Tool[] {
  return [
    readTool,
    writeTool,
    editTool,
    multiEditTool,
    globTool,
    grepTool,
    bashTool,
    bashOutputTool,
    killShellTool,
    todoTool,
    taskTool,
    skillTool,
    viewImageTool,
    webFetchTool,
    webSearchTool,
  ];
}

export function createToolRegistry(extra: Tool[] = []): ToolRegistry {
  return new ToolRegistry([...defaultTools(), ...extra]);
}

export function readOnlyTools(): Tool[] {
  return defaultTools().filter((tool) => tool.readOnly);
}

export { ToolRegistry } from "./registry.ts";
export type { Tool, ToolContext, ToolSpec } from "./types.ts";
export type { ToolDisplay, ToolDisplayResult, ToolResultMeta } from "../core/display.ts";
