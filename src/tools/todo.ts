import { ToolError } from "../util/errors.ts";
import { optionalObjectArray } from "./args.ts";
import { defineTool } from "./types.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: TodoItem[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      todos.push({ content: entry, status: "pending" });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const content = (record.content ?? record.task ?? record.title ?? record.text) as string | undefined;
    if (!content) continue;
    const rawStatus = String(record.status ?? "pending").toLowerCase().replace(/[\s-]/g, "_");
    const status: TodoStatus =
      rawStatus === "completed" || rawStatus === "complete" || rawStatus === "done"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "active" || rawStatus === "doing"
          ? "in_progress"
          : "pending";
    todos.push({
      content: String(content),
      status,
      ...(record.activeForm ? { activeForm: String(record.activeForm) } : {}),
    });
  }
  return todos;
}

export const todoTool = defineTool({
  name: "todo_write",
  label: "Todos",
  description:
    "Create or update the task list for the current work. Send the full list every time; exactly one item may be in_progress. Use it for anything with three or more distinct steps.",
  tags: ["plan"],
  risk: "low",
  readOnly: false,
  concurrencySafe: false,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete task list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative description of the task." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: "Present continuous form shown while the task runs." },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  describe(args) {
    const todos = parseTodos(args.todos ?? optionalObjectArray(args, "todos", "items"));
    const done = todos.filter((todo) => todo.status === "completed").length;
    return `${done}/${todos.length} done`;
  },
  async execute(args, ctx) {
    const todos = parseTodos(args.todos ?? args.items);
    if (todos.length === 0) {
      ctx.emit?.({ type: "todos", todos: [] });
      return { content: "Task list cleared.", summary: "cleared" };
    }
    const inProgress = todos.filter((todo) => todo.status === "in_progress");
    if (inProgress.length > 1) {
      throw new ToolError("Only one task may be in_progress at a time", {
        hint: "Mark the others pending or completed and send the list again.",
      });
    }

    ctx.emit?.({ type: "todos", todos });
    const rendered = todos
      .map((todo) => `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]"} ${todo.content}`)
      .join("\n");
    const summary = `${todos.filter((todo) => todo.status === "completed").length}/${todos.length} complete`;
    return {
      content: `Task list updated.\n${rendered}`,
      summary,
      display: { kind: "list", title: "Tasks", lines: rendered.split("\n") },
      meta: { quiet: false, volatile: false },
    };
  },
});

export function formatTodos(todos: TodoItem[]): string {
  return todos
    .map((todo) => `${todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "▶" : "☐"} ${todo.content}`)
    .join("\n");
}

export function todoProgress(todos: TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return `${done}/${todos.length}`;
}
