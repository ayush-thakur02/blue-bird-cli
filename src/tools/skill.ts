import { ToolError } from "../util/errors.ts";
import { bestMatch } from "../util/text.ts";
import { optionalString, requiredString } from "./args.ts";
import { defineTool } from "./types.ts";

export const skillTool = defineTool({
  name: "skill",
  label: "Skill",
  description:
    "Load a skill: a step-by-step playbook maintained for this project. Call it as soon as a task matches a skill's description, then follow the instructions it returns.",
  tags: ["plan", "read"],
  readOnly: true,
  concurrencySafe: true,
  risk: "low",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name, as listed in the Skills section of this prompt." },
      arguments: { type: "string", description: "Optional arguments substituted into the skill's $ARGUMENTS placeholders." },
    },
    required: ["name"],
  },
  isEnabled(ctx) {
    return ctx.skills.length > 0;
  },
  describe(args) {
    return optionalString(args, "name", "skill") ?? "?";
  },
  async execute(args, ctx) {
    const name = requiredString(args, "name" in args ? ["name"] : ["skill", "command"], "skill");
    const skill =
      ctx.skills.find((entry) => entry.name === name) ??
      ctx.skills.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      const suggestion = bestMatch(name, ctx.skills.map((entry) => entry.name));
      throw new ToolError(`No skill named "${name}"`, {
        hint: hintFor(suggestion, ctx.skills.map((entry) => entry.name)),
      });
    }

    const raw = optionalString(args, "arguments", "args") ?? "";
    const body = skill.body.replace(/\$ARGUMENTS\b/g, raw.trim());
    const files = skill.files.length ? `\n\nBundled files (relative to ${skill.dir}):\n${skill.files.map((file) => `- ${file}`).join("\n")}` : "";

    return {
      content: `# Skill: ${skill.name}\n\n${body}${files}`,
      summary: `loaded ${skill.name}`,
      display: { kind: "text", title: `Skill · ${skill.name}`, text: body.slice(0, 4000), collapseAfter: 16 },
      meta: { readFiles: skill.files.map((file) => `${skill.dir}/${file}`).slice(0, 10) },
    };
  },
});

function hintFor(suggestion: string | undefined, names: string[]): string | undefined {
  if (suggestion) return `Did you mean "${suggestion}"?`;
  if (names.length) return `Available skills: ${names.join(", ")}`;
  return "No skills are installed. Add one under .bluebird/skills/<name>/SKILL.md";
}
