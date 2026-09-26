import { ToolError } from "../util/errors.ts";
import { formatCost, formatCount, truncate } from "../util/text.ts";
import { optionalBoolean, optionalNumber, optionalString, requiredString } from "./args.ts";
import { defineTool } from "./types.ts";

export const taskTool = defineTool({
  name: "task",
  label: "Task",
  description:
    "Delegate a self-contained piece of work to a subagent with its own context window. Use it for broad searches, reading many files, or independent investigations so the main context stays clean. The subagent returns a single report and cannot see this conversation.",
  tags: ["plan"],
  readOnly: false,
  concurrencySafe: true,
  risk: "medium",
  prompt:
    "A `task` subagent starts with no memory of this conversation. Include the goal, the files or modules involved, the constraints, and exactly what to return.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short label shown in the transcript (3-6 words)." },
      prompt: { type: "string", description: "Complete, self-contained brief for the subagent." },
      agent: { type: "string", description: "Named agent definition to use (see the Subagents section)." },
      model: { type: "string", description: "Optional model override, e.g. a cheaper model for exploration." },
      tools: { type: "array", items: { type: "string" }, description: "Restrict the subagent to these tools." },
      read_only: { type: "boolean", description: "Forbid the subagent from modifying anything." },
      max_turns: { type: "number", description: "Maximum assistant turns for the subagent." },
    },
    required: ["description", "prompt"],
  },
  isEnabled(ctx) {
    return Boolean(ctx.subagents) && ctx.config.raw.agent?.subagents?.enabled !== false;
  },
  describe(args) {
    return optionalString(args, "description") ?? truncate(optionalString(args, "prompt") ?? "subagent", 48);
  },
  async execute(args, ctx) {
    if (!ctx.subagents) {
      throw new ToolError("Subagents are not available in this session", {
        hint: "Enable them with agent.subagents.enabled = true (or run without --no-subagents).",
      });
    }
    const description = requiredString(args, ["description"], "task");
    const prompt = requiredString(args, ["prompt", "task", "instructions"], "task");
    const agentName = optionalString(args, "agent", "subagent_type", "type");
    const defined = ctx.subagents.list();
    if (agentName && defined.length && !defined.some((agent) => agent.name === agentName)) {
      throw new ToolError(`Unknown subagent "${agentName}"`, {
        hint: `Available: ${defined.map((agent) => agent.name).join(", ")}`,
      });
    }

    ctx.emit?.({ type: "subagent", description, model: optionalString(args, "model") ?? "inherited", status: "start" });
    const started = Date.now();
    try {
      const result = await ctx.subagents.run(
        {
          description,
          prompt,
          ...(agentName ? { agent: agentName } : {}),
          ...(optionalString(args, "model") ? { model: optionalString(args, "model")! } : {}),
          ...(Array.isArray(args.tools) ? { tools: args.tools.map((tool) => String(tool)) } : {}),
          ...(optionalBoolean(args, "read_only", "readonly") !== undefined ? { readOnly: optionalBoolean(args, "read_only", "readonly")! } : {}),
          ...(optionalNumber(args, "max_turns") ? { maxTurns: optionalNumber(args, "max_turns")! } : {}),
        },
        ctx.signal,
      );

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      ctx.emit?.({ type: "subagent", description, model: result.model, status: "done", detail: `${elapsed}s` });

      const usage = [
        `${formatCount(result.usage.inputTokens)} in / ${formatCount(result.usage.outputTokens)} out`,
        result.usage.costUsd ? formatCost(result.usage.costUsd) : undefined,
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        content: [
          `Subagent "${description}" finished in ${elapsed}s (${result.turns} turns, ${result.toolCalls} tool calls, ${usage}).`,
          "",
          result.text.trim() || "(the subagent produced no report)",
        ].join("\n"),
        summary: `${elapsed}s · ${result.turns} turns`,
        display: { kind: "text", title: description, text: result.text.slice(0, 6000), collapseAfter: 20 },
        meta: { volatile: true, durationMs: Date.now() - started },
      };
    } catch (error) {
      ctx.emit?.({ type: "subagent", description, model: "n/a", status: "error", detail: (error as Error).message });
      throw error;
    }
  },
});
