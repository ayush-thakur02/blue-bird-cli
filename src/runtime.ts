import path from "node:path";
import fs from "node:fs";
import type {
  AgentDefinition,
  ConfirmPrompt,
  CommandDefinition,
  HookApi,
  Logger,
  PromptApi,
  SkillDefinition,
  UiSink,
} from "./core/contracts.ts";
import { defaultWorkspaceState, type Usage, type WorkspaceState } from "./core/contracts.ts";
import { loadConfig, resolveFallbackModels, type LoadConfigOverrides } from "./config/load.ts";
import type { ResolvedConfig, ResolvedModel, UiConfig } from "./config/schema.ts";
import { ProviderCache } from "./providers/index.ts";
import { createToolRegistry, type ToolRegistry } from "./tools/index.ts";
import { BackgroundTasks } from "./tools/shell.ts";
import { Agent, type AgentUi } from "./core/agent.ts";
import { Session, findSessionAnywhere, listSessions, pruneSessions, type SessionMeta } from "./core/session.ts";
import { PermissionEngine } from "./core/permissions.ts";
import { HookRunner } from "./core/hooks.ts";
import { CheckpointManager } from "./core/checkpoint.ts";
import { SubagentRunner } from "./core/subagent.ts";
import { discoverMemory, type MemoryDiscovery } from "./core/memory.ts";
import { extensionDirs, loadAgents, loadCommands, loadSkills, mergeAgents } from "./core/extensions.ts";
import { createLogger } from "./util/logger.ts";
import { ConfigError } from "./util/errors.ts";
import { bluebirdHome, ensureDirSync, expandHome, fileExists, resolveFrom } from "./util/paths.ts";
import { gitStatusFiles } from "./util/walk.ts";

export interface RuntimeOptions {
  cwd: string;
  overrides?: LoadConfigOverrides;
  configPath?: string;
  sessionId?: string;
  /** Resume an existing session by id (loads its transcript). */
  resumeId?: string;
  planMode?: boolean;
  headless?: boolean;
  promptApi?: PromptApi;
  uiOverrides?: Partial<UiConfig>;
  disableMemory?: boolean;
  disableSubagents?: boolean;
  maxTurns?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  logFile?: string;
}

export interface GitInfo {
  branch?: string;
  status?: string;
  isRepo: boolean;
}

export class Runtime {
  config: ResolvedConfig;
  session: Session;
  agent: Agent;
  registry: ToolRegistry;
  providers: ProviderCache;
  permissions: PermissionEngine;
  hooks: HookApi;
  checkpoints: CheckpointManager;
  memory: MemoryDiscovery;
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  commands: CommandDefinition[];
  subagents: SubagentRunner | undefined;
  background: BackgroundTasks;
  state: WorkspaceState;
  logger: Logger;
  git: GitInfo;
  model: ResolvedModel;
  readonly options: RuntimeOptions;
  private promptApi: PromptApi;
  private attachedUi?: AgentUi;
  private readonly sessionDir: string;
  private readonly checkpointDir: string;
  private readonly globalIndex: string;

  private constructor(args: {
    options: RuntimeOptions;
    config: ResolvedConfig;
    session: Session;
    registry: ToolRegistry;
    providers: ProviderCache;
    permissions: PermissionEngine;
    hooks: HookApi;
    checkpoints: CheckpointManager;
    memory: MemoryDiscovery;
    agents: AgentDefinition[];
    skills: SkillDefinition[];
    commands: CommandDefinition[];
    background: BackgroundTasks;
    state: WorkspaceState;
    logger: Logger;
    git: GitInfo;
    model: ResolvedModel;
    promptApi: PromptApi;
    sessionDir: string;
    checkpointDir: string;
    globalIndex: string;
  }) {
    this.options = args.options;
    this.config = args.config;
    this.session = args.session;
    this.registry = args.registry;
    this.providers = args.providers;
    this.permissions = args.permissions;
    this.hooks = args.hooks;
    this.checkpoints = args.checkpoints;
    this.memory = args.memory;
    this.agents = args.agents;
    this.skills = args.skills;
    this.commands = args.commands;
    this.background = args.background;
    this.state = args.state;
    this.logger = args.logger;
    this.git = args.git;
    this.model = args.model;
    this.promptApi = args.promptApi;
    this.sessionDir = args.sessionDir;
    this.checkpointDir = args.checkpointDir;
    this.globalIndex = args.globalIndex;

    const provider = this.providers.get(this.model);
    const fallbacks = resolveFallbackModels(this.config.raw, { env: process.env });
    this.agent = new Agent({
      session: this.session,
      config: this.config,
      registry: this.registry,
      provider,
      providers: this.providers,
      model: this.model,
      fallbacks,
      permissions: this.permissions,
      hooks: this.hooks,
      checkpoints: this.checkpoints,
      state: this.state,
      ui: {},
      sink: {
        progress() {},
        notice() {},
        status() {},
        log: (level, message) => this.logger[level](message),
      },
      memory: this.memory,
      agents: this.agents,
      skills: this.skills,
      logger: this.logger,
      background: this.background,
      planMode: this.options.planMode ?? false,
      effort: defaultEffort(this.config),
      effortAuto: (this.config.effort ?? "auto") === "auto",
      ...(this.options.headless ? { mode: "headless" as const } : {}),
      ...(this.options.maxTurns ? { maxTurns: this.options.maxTurns } : {}),
    });
    this.agent.setGit(this.git.branch);

    if (this.options.disableSubagents !== true && this.config.raw.agent?.subagents?.enabled !== false) {
      this.subagents = new SubagentRunner({
        config: this.config,
        registry: this.registry,
        providers: this.providers,
        model: this.model,
        fallbacks,
        permissions: this.permissions,
        hooks: this.hooks,
        checkpoints: this.checkpoints,
        sink: silentSink(this.logger),
        logger: this.logger,
        agents: this.agents,
        sessionDir: this.sessionDir,
        parentSessionId: this.session.id,
        onEvent: (event) => this.attachedUi?.subagentEvent?.({
          description: event.description,
          status: event.type,
          ...(event.detail ? { detail: event.detail } : {}),
        }),
        maxConcurrent: this.config.raw.agent?.subagents?.maxConcurrent ?? 4,
      });
      this.agent.attach({ subagents: this.subagents });
    }
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const cwd = resolveFrom(process.cwd(), options.cwd || ".");
    const config = loadConfig({
      cwd,
      ...(options.configPath ? { configPath: expandHome(options.configPath) } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    });

    const logger = createLogger({
      level: options.logLevel ?? (process.env.BLUEBIRD_DEBUG ? "debug" : "warn"),
      ...(options.logFile ? { file: options.logFile } : {}),
    });

    const home = bluebirdHome();
    const sessionDir = path.join(config.root, config.raw.sessions?.dir ?? ".bluebird", "sessions");
    const checkpointDir = path.join(config.root, config.raw.sessions?.dir ?? ".bluebird", "checkpoints");
    const globalIndex = path.join(home, "sessions.json");
    if (config.raw.sessions?.persist !== false) {
      ensureDirSync(sessionDir);
      pruneSessions(sessionDir, config.raw.sessions?.retentionDays ?? 30);
    }

    const git = await detectGit(config.root);

    const commands = loadCommands(extensionDirs({ root: config.root, home }).commands);
    const skills = loadSkills(extensionDirs({ root: config.root, home }).skills);
    const agents = mergeAgents(loadAgents(extensionDirs({ root: config.root, home }).agents));

    const memory =
      options.disableMemory === true || config.raw.memory?.autoLoad === false
        ? { entries: [], missingImports: [], truncated: false, totalChars: 0 }
        : discoverMemory({
            cwd: config.cwd,
            root: config.root,
            home,
            ...(config.raw.memory?.files ? { extraFiles: config.raw.memory.files } : {}),
            ...(config.raw.memory?.autoLoad !== undefined ? { autoLoad: config.raw.memory.autoLoad } : {}),
            ...(config.raw.memory?.learnings !== undefined ? { learnings: config.raw.memory.learnings } : {}),
          });

    const registry = createToolRegistry();
    const providers = new ProviderCache();
    const state = defaultWorkspaceState();
    const background = new BackgroundTasks();

    const promptApi: PromptApi = options.promptApi ?? {
      async confirm(_prompt: ConfirmPrompt) {
        return "deny";
      },
    };

    let runtimeRef: Runtime | undefined;
    const promptForwarder: PromptApi = {
      confirm: (prompt) => (runtimeRef ? runtimeRef.promptFor().confirm(prompt) : promptApi.confirm(prompt)),
    };

    const permissions = new PermissionEngine({
      preset: config.raw.permissions?.preset ?? "ask",
      allow: config.raw.permissions?.allow ?? [],
      deny: config.raw.permissions?.deny ?? [],
      trusted: config.raw.permissions?.trusted ?? true,
      allowDangerous: config.raw.permissions?.allowDangerous ?? false,
      network: config.raw.permissions?.network !== false,
      cwd: config.cwd,
      workspaceRoot: config.root,
      additionalDirectories: [
        ...(config.raw.permissions?.additionalDirectories ?? []),
        ...(config.raw.includeDirectories ?? []),
      ],
      prompt: promptForwarder,
      logger,
      onPersistRule: (rule) => {
        try {
          const localPath = path.join(config.root, ".bluebird", "config.local.json");
          const existing = fileExists(localPath) ? (JSON.parse(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>) : {};
          const permissionsBlock = (existing.permissions ?? {}) as Record<string, unknown>;
          const allow = new Set([...(Array.isArray(permissionsBlock.allow) ? (permissionsBlock.allow as string[]) : []), rule]);
          existing.permissions = { ...permissionsBlock, allow: [...allow] };
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, `${JSON.stringify(existing, null, 2)}\n`);
          logger.info(`Saved permission rule to ${localPath}`);
        } catch (error) {
          logger.warn(`Could not persist permission rule: ${(error as Error).message}`);
        }
      },
    });

    const hooks = new HookRunner({
      hooks: config.raw.hooks ?? [],
      cwd: config.cwd,
      logger,
      env: { BLUEBIRD_SESSION_CWD: config.cwd },
    });

    const session = await openSession({
      config,
      sessionDir,
      globalIndex,
      resumeId: options.resumeId,
      sessionId: options.sessionId,
      git,
    });

    const checkpointManager = new CheckpointManager({ dir: checkpointDir, sessionId: session.id, logger });

    const runtime = new Runtime({
      options,
      config,
      session,
      registry,
      providers,
      permissions,
      hooks,
      checkpoints: checkpointManager,
      memory,
      agents,
      skills,
      commands,
      background,
      state,
      logger,
      git,
      model: config.model,
      promptApi,
      sessionDir,
      checkpointDir,
      globalIndex,
    });

    for (const warning of config.warnings) logger.warn(warning);
    runtimeRef = runtime;
    await runtime.runSessionStartHook();
    return runtime;
  }

  /** Fires the `session.start` hook; failures are logged, never fatal. */
  private async runSessionStartHook(): Promise<void> {
    try {
      await this.hooks.run(
        "session.start",
        { event: "session.start", sessionId: this.session.id, cwd: this.config.cwd, model: this.model.model.id },
        new AbortController().signal,
      );
    } catch (error) {
      this.logger.warn(`session.start hook failed: ${(error as Error).message}`);
    }
  }

  /** Wire the interactive UI into permission prompts and agent events. */
  attachUi(ui: { agentUi: AgentUi; sink: UiSink; promptApi: PromptApi }): void {
    this.promptApi = ui.promptApi;
    this.attachedUi = ui.agentUi;
    this.agent.attach({ ui: ui.agentUi, sink: ui.sink });
  }

  promptFor(): PromptApi {
    return this.promptApi;
  }

  switchModel(model: ResolvedModel): void {
    this.model = model;
    this.agent.setModel(model, this.providers.get(model));
    this.session.update({ model: model.model.id, provider: model.providerId });
  }

  sessionUsage(): Usage {
    return this.session.info().usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  }

  sessionMeta(): SessionMeta {
    return this.session.info();
  }

  listSessions(limit = 20): SessionMeta[] {
    return listSessions(this.sessionDir, { limit });
  }

  changeSession(session: Session, planMode?: boolean): void {
    this.session = session;
    this.agent.attach({ session });
    if (planMode !== undefined) this.agent.setPlanMode(planMode);
    this.agent.invalidateSystemPrompt();
  }

  dispose(): void {
    this.background.killAll();
    this.session.flush(true);
  }

  get paths() {
    return { sessionDir: this.sessionDir, checkpointDir: this.checkpointDir, globalIndex: this.globalIndex };
  }
}

async function openSession(args: {
  config: ResolvedConfig;
  sessionDir: string;
  globalIndex: string;
  resumeId?: string;
  sessionId?: string;
  git: GitInfo;
}): Promise<Session> {
  const { config } = args;
  if (args.resumeId) {
    const found = findSessionAnywhere(args.resumeId, args.globalIndex);
    if (!found) {
      throw new ConfigError(`Session "${args.resumeId}" was not found`, {
        hint: "List sessions with `bluebird sessions list` (or /sessions inside a session).",
      });
    }
    const session = new Session({
      dir: path.dirname(found.meta.id ? path.join(args.sessionDir, `${found.meta.id}.meta.json`) : args.sessionDir),
      root: config.root,
      cwd: config.cwd,
      model: found.meta.model,
      provider: found.meta.provider,
      effort: found.meta.effort,
      id: found.meta.id,
      persist: config.raw.sessions?.persist !== false,
      globalIndex: args.globalIndex,
      ...(args.git.branch ? { gitBranch: args.git.branch } : {}),
    });
    session.messages = found.messages;
    if (found.meta.title) session.setTitle(found.meta.title);
    return session;
  }

  return new Session({
    dir: args.sessionDir,
    root: config.root,
    cwd: config.cwd,
    model: config.model.model.id,
    provider: config.model.providerId,
    effort: config.effort,
    ...(args.sessionId ? { id: args.sessionId } : {}),
    persist: config.raw.sessions?.persist !== false,
    globalIndex: args.globalIndex,
    ...(args.git.branch ? { gitBranch: args.git.branch } : {}),
  });
}

export async function detectGit(root: string): Promise<GitInfo> {
  try {
    const status = await gitStatusFiles(root);
    if (!status.isRepo) return { isRepo: false };
    return {
      isRepo: true,
      ...(status.branch ? { branch: status.branch } : {}),
      ...(status.statuses.length ? { status: status.statuses.slice(0, 20).join(", ") } : {}),
    };
  } catch {
    return { isRepo: false };
  }
}

function defaultEffort(config: ResolvedConfig): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const effort = config.effort;
  if (effort && effort !== "auto") return effort;
  return "medium";
}

function silentSink(logger: Logger): UiSink {
  return {
    progress() {},
    notice() {},
    status() {},
    log: (level, message) => logger[level](message),
  };
}

export function runtimeSummary(runtime: Runtime): string[] {
  const { config, session, git } = runtime;
  return [
    `model       ${config.model.label}`,
    `provider    ${config.model.providerId} (${config.model.api})`,
    `endpoint    ${config.model.baseURL}`,
    `effort      ${config.effort}`,
    `permission  ${config.raw.permissions?.preset ?? "ask"}`,
    `session     ${session.id}`,
    `cwd         ${config.cwd}`,
    `root        ${config.root}`,
    ...(git.branch ? [`branch      ${git.branch}`] : []),
    `config      ${config.sources.length ? config.sources.join(", ") : "(defaults only)"}`,
    `state       ${config.raw.sessions?.dir ?? ".bluebird"}/ under ${config.root}`,
  ];
}
