import fs from "node:fs";
import path from "node:path";
import type { ApiFlavor, BlueBirdConfig, EffortSetting, PermissionPresetValue } from "../config/schema.ts";
import { EFFORT_DESCRIPTIONS, EFFORT_LEVELS } from "../config/schema.ts";
import {
  IMPLICIT_PROVIDER_ID,
  applyDefaults,
  credentialsPath,
  globalConfigPath,
  mergeConfig,
  projectConfigPath,
  readCredentials,
  resolveModel,
  saveConfigFile,
  writeCredential,
} from "../config/load.ts";
import { detectProjectTraits, memoryTemplate, BLUEBIRD_MEMORY_FILENAME } from "../core/memory.ts";
import { createProvider } from "../providers/index.ts";
import { CONFIG_VERSION, CLI_NAME } from "../version.ts";
import { DEFAULT_CONTEXT_WINDOW } from "../config/schema.ts";
import {
  ENV_FILE_NAME,
  describeEnvWrite,
  globalEnvFile,
  isEnvVarName,
  projectEnvFile,
  readEnvFileValues,
  upsertEnvVar,
  type EnvWriteResult,
} from "../config/env-file.ts";
import { fileExists, findWorkspaceRoot, readJsonSync, writeJsonAtomic, ensureDirSync } from "../util/paths.ts";
import { ConfigError } from "../util/errors.ts";
import { accent, ask, askSecret, bold, choose, confirm, dim } from "../cli/prompt.ts";

export interface InitOptions {
  cwd: string;
  yes?: boolean;
  force?: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  /** Name of the variable to keep in `.env` instead of the config file. */
  apiKeyEnv?: string;
  api?: string;
  effort?: string;
  permission?: string;
  providerId?: string;
  global?: boolean;
  check?: boolean;
  json?: boolean;
}

export interface InitResult {
  configPath: string;
  memoryPath?: string;
  envFile?: { path: string; key: string; action: string };
  wrote: boolean;
  probe?: { ok: boolean; detail: string };
  config: BlueBirdConfig;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const root = options.global ? process.env.HOME ?? options.cwd : findWorkspaceRoot(options.cwd);
  const configPath = options.global ? globalConfigPath() : projectConfigPath(root);
  const interactive = !options.yes && process.stdin.isTTY && process.stdout.isTTY;
  const existing = readJsonSync<BlueBirdConfig>(configPath);

  if (!options.json) {
    process.stdout.write("\n");
    process.stdout.write(`  ${bold("Blue Bird setup")}\n`);
    process.stdout.write(`  ${dim(configPath)}\n\n`);
  }

  if (existing && !options.force && !interactive) {
    if (!options.json) process.stdout.write(`  ${dim("Existing configuration found — merging new values into it.")}\n\n`);
  }

  let endpoint = options.endpoint;
  let model = options.model;
  let api = options.api as ApiFlavor | undefined;
  let apiKeyRef = options.apiKey;
  let effort = options.effort as EffortSetting | undefined;
  let permission = options.permission as PermissionPresetValue | undefined;
  const providerId = options.providerId && options.providerId !== IMPLICIT_PROVIDER_ID ? options.providerId : undefined;
  const envFile = options.global ? globalEnvFile() : projectEnvFile(root);
  let envWrite: EnvWriteResult | undefined;

  if (options.apiKeyEnv) {
    if (!isEnvVarName(options.apiKeyEnv)) {
      throw new ConfigError(`"${options.apiKeyEnv}" is not a valid environment variable name`, {
        hint: "Use letters, digits and underscores, starting with a letter or underscore, for example --api-key-env OPENAI_API_KEY.",
      });
    }
    apiKeyRef = `\${${options.apiKeyEnv}}`;
    const literal = secretFromFlag(options.apiKey);
    if (literal) {
      envWrite = upsertEnvVar(envFile, options.apiKeyEnv, literal);
      process.env[options.apiKeyEnv] = literal;
      if (!options.json) process.stdout.write(`  ${accent("✓")} ${describeEnvWrite(envWrite)}\n`);
    }
  }

  if (interactive) {
    if (!api) {
      api = await choose<ApiFlavor>(
        "Which API dialect does your endpoint speak?",
        [
          { value: "openai-completions", label: "OpenAI chat completions", hint: "/v1/chat/completions — OpenAI, Azure, vLLM, Ollama, Groq, DeepSeek, OpenRouter" },
          { value: "anthropic-messages", label: "Anthropic messages", hint: "Claude and Anthropic-compatible gateways" },
          { value: "openai-responses", label: "OpenAI responses", hint: "newer /v1/responses deployments" },
          { value: "mock", label: "No endpoint yet (offline mock)", hint: "explore the CLI without a model" },
        ],
        0,
      );
    }

    if (api === "mock") {
      endpoint = endpoint ?? "mock://local";
      model = model ?? "bluebird-mock-1";
    } else {
      endpoint = endpoint ?? (await ask("Endpoint base URL", { default: guessEndpoint(), validate: validateUrl }));
      model = model ?? (await ask("Model id", { validate: validateModel }));
    }

    if (api !== "mock" && apiKeyRef === undefined) {
      const decision = await choose(
        "How should Blue Bird find the API key?",
        [
          { value: "dotenv", label: `Store it in ${path.basename(envFile)}`, hint: "loaded automatically on every run, kept out of git" },
          { value: "env", label: "Read it from an environment variable", hint: "nothing secret lands in the config file" },
          { value: "credentials", label: "Store it in ~/.bluebird/credentials.json", hint: "kept out of the project, chmod 600" },
          { value: "inline", label: "Write it into the config file", hint: "only for throwaway or local endpoints" },
          { value: "none", label: "No key needed", hint: "local servers such as Ollama or vLLM" },
        ],
        0,
      );
      if (decision === "dotenv") {
        const name = await ask("Environment variable name", { default: guessEnvName(endpoint), validate: validateEnvName });
        apiKeyRef = `\${${name}}`;
        const key = (await askSecret("Paste the API key (hidden):")).trim();
        if (key) {
          envWrite = upsertEnvVar(envFile, name, key);
          process.env[name] = key;
          process.stdout.write(`  ${accent("✓")} ${describeEnvWrite(envWrite)}\n`);
        } else {
          process.stdout.write(`  ${dim(`no key entered — ${name} must be set before the first run`)}\n`);
        }
      } else if (decision === "env") {
        const name = await ask("Environment variable name", { default: guessEnvName(endpoint), validate: validateEnvName });
        apiKeyRef = `\${${name}}`;
        const found = keySource(name, root, Boolean(options.global));
        if (found) {
          process.stdout.write(`  ${accent("✓")} ${name} is already set ${found === "shell" ? "in this shell" : `in ${found}`}\n`);
        } else {
          process.stdout.write(`  ${dim(`note: ${name} is not set in this shell or in ${envFile}`)}\n`);
          if (await confirm(`Store it in ${path.basename(envFile)} now?`, false)) {
            const key = (await askSecret("Paste the API key (hidden):")).trim();
            if (key) {
              envWrite = upsertEnvVar(envFile, name, key);
              process.env[name] = key;
              process.stdout.write(`  ${accent("✓")} ${describeEnvWrite(envWrite)}\n`);
            }
          }
        }
      } else if (decision === "credentials") {
        const key = await askSecret("Paste the API key (hidden):");
        if (key.trim()) {
          const file = writeCredential(providerId ?? IMPLICIT_PROVIDER_ID, key.trim());
          process.stdout.write(`  ${dim(`stored in ${file}`)}\n`);
        }
      } else if (decision === "inline") {
        apiKeyRef = await askSecret("Paste the API key (hidden):");
      }
    }

    effort = effort ?? (await chooseEffort());
    permission = permission ?? (await choosePermission());
  }

  endpoint = endpoint ?? guessEndpoint();
  api = api ?? "openai-completions";
  model = model ?? (api === "mock" ? "bluebird-mock-1" : "gpt-4o-mini");
  effort = effort ?? "auto";
  permission = permission ?? "ask";

  const patch: BlueBirdConfig = {
    version: CONFIG_VERSION,
    effort,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    permissions: { preset: permission, network: true, trusted: true },
  };

  if (providerId) {
    patch.provider = providerId;
    patch.providers = {
      [providerId]: {
        displayName: providerId,
        api,
        baseURL: endpoint,
        ...(apiKeyRef ? { apiKey: apiKeyRef } : {}),
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        compat: { promptCache: "auto" },
        models: [{ id: model, contextWindow: DEFAULT_CONTEXT_WINDOW }],
      },
    };
  } else {
    patch.endpoint = endpoint;
    patch.api = api;
    patch.model = model;
    if (apiKeyRef) {
      if (apiKeyRef.startsWith("${") || apiKeyRef.startsWith("env:")) {
        patch.apiKey = apiKeyRef.startsWith("env:") ? `\${${apiKeyRef.slice(4)}}` : apiKeyRef;
      } else {
        patch.apiKey = apiKeyRef;
      }
    }
  }

  const merged = applyDefaults(mergeConfig(existing ?? { version: CONFIG_VERSION }, patch));
  ensureDirSync(path.dirname(configPath));
  saveConfigFile(configPath, merged);

  let memoryPath: string | undefined;
  if (!options.global) {
    const candidate = path.join(root, BLUEBIRD_MEMORY_FILENAME);
    if (!fileExists(candidate)) {
      const traits = detectProjectTraits(root);
      fs.writeFileSync(candidate, memoryTemplate(root, traits));
      memoryPath = candidate;
    }
    updateGitignore(root, envWrite ? [ENV_FILE_NAME] : []);
  } else if (envWrite) {
    updateGitignore(root, [ENV_FILE_NAME]);
  }

  const unresolvedKey = apiKeyRef && hasRef(apiKeyRef) ? unresolvedEnvName(apiKeyRef) : undefined;
  const missingKey = unresolvedKey && !keySource(unresolvedKey, root, Boolean(options.global)) ? unresolvedKey : undefined;

  let probe: { ok: boolean; detail: string } | undefined;
  if (options.check || interactive) {
    if (!options.json) process.stdout.write(`  ${dim("checking the endpoint…")}\n`);
    probe = await probeEndpoint(merged, options.cwd);
    if (!options.json) {
      process.stdout.write(probe.ok ? `  ${accent("✓")} ${probe.detail}\n` : `  ${dim("!")} ${probe.detail}\n`);
    }
  }

  if (!options.json) {
    process.stdout.write(`\n  ${accent("✓")} wrote ${configPath}\n`);
    if (memoryPath) process.stdout.write(`  ${accent("✓")} created ${path.relative(root, memoryPath)} (project instructions)\n`);
    if (missingKey) {
      process.stdout.write(
        `  ${dim("!")} ${missingKey} is not set in this shell or in ${envFile} — ${CLI_NAME} cannot authenticate until it is ${dim(`(${CLI_NAME} init --api-key-env ${missingKey})`)}\n`,
      );
    }
    process.stdout.write(
      `  ${accent("✓")} context window ${(DEFAULT_CONTEXT_WINDOW / 1_000_000).toFixed(0)}M tokens with prompt caching ${dim("(declare contextWindow on the model if your deployment is smaller)")}\n`,
    );
    process.stdout.write(`\n  Next:\n`);
    process.stdout.write(`    ${dim("$")} ${CLI_NAME}                 start an interactive session\n`);
    process.stdout.write(`    ${dim("$")} ${CLI_NAME} "fix the failing test"   run one task and exit\n`);
    process.stdout.write(`    ${dim("$")} ${CLI_NAME} doctor            verify the endpoint, key and context window\n`);
    process.stdout.write(`    ${dim("$")} ${CLI_NAME} help              all commands and flags\n\n`);
  }

  return {
    configPath,
    ...(memoryPath ? { memoryPath } : {}),
    ...(envWrite ? { envFile: { path: envWrite.path, key: envWrite.key, action: envWrite.action } } : {}),
    wrote: true,
    ...(probe ? { probe } : {}),
    config: merged,
  };
}

async function chooseEffort(): Promise<EffortSetting> {
  const options = [
    { value: "auto" as const, label: "auto", hint: "Blue Bird picks per request (recommended)" },
    ...EFFORT_LEVELS.map((level) => ({ value: level, label: level, hint: EFFORT_DESCRIPTIONS[level] })),
  ];
  return choose<EffortSetting>("Default reasoning effort?", options, 0);
}

async function choosePermission(): Promise<PermissionPresetValue> {
  return choose<PermissionPresetValue>(
    "Default permission mode?",
    [
      { value: "ask", label: "ask", hint: "confirm file writes and commands (recommended)" },
      { value: "edits", label: "edits", hint: "auto-approve edits inside the project, still confirm shell" },
      { value: "auto", label: "auto", hint: "run freely, confirm only risky or out-of-workspace actions" },
      { value: "read-only", label: "read-only", hint: "never modify anything" },
      { value: "danger-full-access", label: "danger-full-access", hint: "no prompts at all" },
    ],
    0,
  );
}

function validateUrl(value: string): string | undefined {
  if (value.startsWith("mock://")) return undefined;
  if (!/^https?:\/\/.+/i.test(value)) return "must start with http:// or https://";
  return undefined;
}

function validateModel(value: string): string | undefined {
  if (/\s/.test(value)) return "model ids cannot contain spaces";
  if (!value) return "a model id is required";
  return undefined;
}

function guessEndpoint(): string {
  return process.env.BLUEBIRD_ENDPOINT ?? "https://api.openai.com/v1";
}

function guessEnvName(endpoint: string): string {
  if (process.env.BLUEBIRD_API_KEY) return "BLUEBIRD_API_KEY";
  try {
    const host = new URL(endpoint).hostname;
    if (host.endsWith(".azure.com")) return "AZURE_OPENAI_API_KEY";
    if (host.includes("anthropic")) return "ANTHROPIC_API_KEY";
    if (host.includes("openai")) return "OPENAI_API_KEY";
    if (host.includes("deepseek")) return "DEEPSEEK_API_KEY";
    return `${host.split(".")[0]!.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  } catch {
    return "BLUEBIRD_API_KEY";
  }
}

export async function probeEndpoint(config: BlueBirdConfig, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const warnings: string[] = [];
  try {
    const model = resolveModel(config, { cwd }, warnings);
    if (!model.apiKey && model.api !== "mock") {
      return { ok: false, detail: `no API key found for provider "${model.providerId}" — set ${guessEnvName(model.baseURL)} or add one with \`bluebird config set apiKey\`` };
    }
    const provider = createProvider({ id: model.providerId, def: model.provider, ...(model.apiKey ? { apiKey: model.apiKey } : {}) });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await provider.probe(controller.signal);
      return { ok: result.ok, detail: result.detail };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

function updateGitignore(root: string, extra: readonly string[] = []): void {
  const file = path.join(root, ".gitignore");
  const header = "# Blue Bird — keep local session state and secrets out of version control";
  const entries = [".bluebird/sessions/", ".bluebird/checkpoints/", ".bluebird/config.local.json", ...extra];
  try {
    const existing = fileExists(file) ? fs.readFileSync(file, "utf8") : "";
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) return;
    const lines = existing && !present.has(header) ? [header, ...missing] : missing;
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, `${existing}${separator}${existing ? "\n" : ""}${lines.join("\n")}\n`);
  } catch {
    // a read-only workspace is not fatal
  }
}

function validateEnvName(value: string): string | undefined {
  return isEnvVarName(value) ? undefined : "use letters, digits and underscores, starting with a letter or underscore";
}

/** Where a variable the config references is already defined: the shell, an env file, or nowhere. */
function keySource(name: string, root: string, global: boolean): "shell" | string | undefined {
  if (process.env[name]) return "shell";
  const files = global ? [globalEnvFile(), projectEnvFile(root)] : [projectEnvFile(root), globalEnvFile()];
  for (const file of files) {
    if (readEnvFileValues(file)[name] !== undefined) return file;
  }
  return undefined;
}

/** A literal secret from `--api-key`; `${VAR}` / `env:VAR` / `$VAR` are references, not secrets. */
function secretFromFlag(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || hasRef(trimmed)) return undefined;
  return trimmed;
}

function hasRef(value: string): boolean {
  return value.startsWith("$") || value.startsWith("env:");
}

/** The variable name inside a `${VAR}`, `${VAR:-fallback}`, `$VAR` or `env:VAR` reference. */
function unresolvedEnvName(ref: string): string {
  const match = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(ref.startsWith("env:") ? ref.slice(4) : ref);
  return match?.[1] ?? "";
}

export function describeConfigLocation(): string {
  return `project (${projectConfigPath(process.cwd())}) or global (${globalConfigPath()})`;
}

export function ensureCredentialsScaffold(): string {
  const file = credentialsPath();
  if (!fileExists(file)) writeJsonAtomic(file, readCredentials(), { mode: 0o600 });
  return file;
}
