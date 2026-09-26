/**
 * Blue Bird CLI — public library surface.
 *
 * The CLI is the main entry point (`src/cli.ts`), but the harness is usable as
 * a library: build a Runtime, attach your own UI, and drive the agent loop.
 */
export { Runtime, detectGit, runtimeSummary, type RuntimeOptions, type GitInfo } from "./runtime.ts";
export { Agent, type AgentUi, type AgentOptions, type TurnResult } from "./core/agent.ts";
export { Session, listSessions, readTranscript, exportTranscript, type SessionMeta } from "./core/session.ts";
export { PermissionEngine, parseRule, ruleMatches } from "./core/permissions.ts";
export { CheckpointManager } from "./core/checkpoint.ts";
export { HookRunner } from "./core/hooks.ts";
export { SubagentRunner } from "./core/subagent.ts";
export { discoverMemory, formatMemoryPrompt, detectProjectTraits, memoryTemplate, type MemoryEntry } from "./core/memory.ts";
export {
  buildSystemPrompt,
  planModeSection,
  sessionStartReminder,
  type SystemPromptInput,
} from "./core/system-prompt.ts";
export { analyzeContext, planCompaction, pruneToolResults, structuralSummary, truncateToolOutput } from "./core/context.ts";
export { classifyEffort, resolveEffort, shiftEffort, EFFORT_ESCALATION_CAP } from "./core/effort.ts";
export { buildPayload as buildOpenAiPayload, toWireMessages, parseToolArguments } from "./providers/openai-chat.ts";
export { buildPayload as buildAnthropicPayload, toAnthropicMessages } from "./providers/anthropic.ts";
export { toResponsesInput } from "./providers/openai-responses.ts";
export { createProvider, ProviderCache, type Provider } from "./providers/index.ts";
export { ToolRegistry, defaultTools, createToolRegistry, readOnlyTools } from "./tools/index.ts";
export { defineTool, formatToolName, type Tool, type ToolContext, type ToolSpec } from "./tools/types.ts";
export { applyEdit } from "./tools/fs.ts";
export { BackgroundTasks, runCommand, stripAnsi } from "./tools/shell.ts";
export {
  loadConfig,
  loadRawConfig,
  resolveModel,
  resolveFallbackModels,
  listProviders,
  projectConfigPath,
  globalConfigPath,
  credentialsPath,
  saveConfigFile,
  validateConfig,
  redactConfig,
  mergeConfig,
  type LoadOptions,
} from "./config/load.ts";
export * from "./config/schema.ts";
export type {
  AgentDefinition,
  CommandDefinition,
  SkillDefinition,
  PermissionApi,
  PermissionRequest,
  PermissionVerdict,
  SubagentApi,
  UiSink,
  Usage,
  WorkspaceState,
} from "./core/contracts.ts";
export { createTheme, type Theme } from "./ui/theme.ts";
export { renderMarkdown, MarkdownStreamRenderer, defaultMarkdownTheme } from "./ui/markdown.ts";
export { unifiedDiff, makePatch, renderDiff, diffStats } from "./ui/diff.ts";
export { highlight, detectLanguageFromPath } from "./ui/highlight.ts";
export { APP_NAME, CLI_NAME, VERSION } from "./version.ts";
