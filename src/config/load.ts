import path from "node:path";
import { ConfigError } from "../util/errors.ts";
import {
  bluebirdHome,
  expandHome,
  fileExists,
  findUp,
  findWorkspaceRoot,
  hashShort,
  isDirectory,
  isProjectBoundary,
  readJsonSync,
  safeRealPath,
  writeJsonAtomic,
} from "../util/paths.ts";
import { formatCount } from "../util/text.ts";
import { envFileCandidates, loadEnvFiles, projectEnvFile, globalEnvFile } from "./env-file.ts";
import { CONFIG_DIR, CONFIG_VERSION } from "../version.ts";
import {
  API_FLAVORS,
  DEFAULT_AGENT,
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGES,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_MEMORY,
  DEFAULT_PERMISSIONS,
  DEFAULT_SESSIONS,
  DEFAULT_UI,
  DEFAULT_UPDATE,
  EFFORT_LEVELS,
  isEffortSetting,
  type ApiFlavor,
  type BlueBirdConfig,
  type ModelDef,
  type HookEventValue,
  type ProviderDef,
  type ResolvedConfig,
  type ResolvedModel,
} from "./schema.ts";

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT };
export const IMPLICIT_PROVIDER_ID = "default";

const CONFIG_ENV_KEYS = {
  endpoint: "BLUEBIRD_ENDPOINT",
  apiKey: "BLUEBIRD_API_KEY",
  model: "BLUEBIRD_MODEL",
  provider: "BLUEBIRD_PROVIDER",
  effort: "BLUEBIRD_EFFORT",
  permissions: "BLUEBIRD_PERMISSIONS",
  api: "BLUEBIRD_API",
} as const;

export interface LoadOptions {
  cwd: string;
  /** Explicit --config path. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip project + global files (used by `bluebird init`). */
  skipFiles?: boolean;
  /** Only read the global file (used by `bluebird config --global`). */
  globalOnly?: boolean;
  /** Skip project + global `.env` files. Defaults to false. */
  loadEnvFiles?: boolean;
}

export function projectConfigPath(root: string): string {
  return path.join(root, CONFIG_DIR, "config.json");
}

export function projectLocalConfigPath(root: string): string {
  return path.join(root, CONFIG_DIR, "config.local.json");
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(bluebirdHome(env), "config.json");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(bluebirdHome(env), "credentials.json");
}

export function settingsPath(root: string): string {
  return path.join(root, CONFIG_DIR, "settings.json");
}

/** Search order, lowest precedence first. */
export function configSearchPaths(options: LoadOptions): string[] {
  const env = options.env ?? process.env;
  if (options.configPath) return [expandHome(options.configPath)];
  if (options.globalOnly) return [globalConfigPath(env)];
  const found = findUp(options.cwd, [path.join(CONFIG_DIR, "config.json")]);
  const discovered = found ? path.dirname(path.dirname(found)) : undefined;
  const root = discovered && !isProjectBoundary(discovered) ? discovered : options.cwd;
  const candidates = [
    globalConfigPath(env),
    path.join(root, CONFIG_DIR, "config.json"),
    path.join(root, CONFIG_DIR, "config.local.json"),
  ];
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

export interface RawConfigResult {
  raw: BlueBirdConfig;
  sources: string[];
  warnings: string[];
  envOverrides: string[];
  /** `.env` files that were read, highest precedence first. */
  envFiles: string[];
  /** Variables that came from those files rather than the shell. */
  envKeys: string[];
  /** Directory of the nearest project config, when one exists. */
  projectRoot: string;
}

export function loadRawConfig(options: LoadOptions): RawConfigResult {
  const warnings: string[] = [];
  const sources: string[] = [];
  const env = options.env ?? process.env;
  const projectRoot = resolveProjectRoot(options);
  const fromEnvFiles =
    options.loadEnvFiles === false
      ? { files: [] as string[], keys: [] as string[] }
      : loadEnvFiles(envFileCandidates(projectRoot, env), env);

  let merged: BlueBirdConfig = { version: CONFIG_VERSION };

  if (!options.skipFiles) {
    for (const candidate of configSearchPaths(options)) {
      if (!fileExists(candidate)) continue;
      const parsed = readJsonSync<Record<string, unknown>>(candidate);
      if (!parsed || typeof parsed !== "object") {
        warnings.push(`Ignoring unreadable config: ${candidate}`);
        continue;
      }
      sources.push(candidate);
      merged = mergeConfig(merged, parsed as unknown as BlueBirdConfig);
    }
  }

  const envOverrides: string[] = [];
  if (env[CONFIG_ENV_KEYS.endpoint]) {
    merged.endpoint = env[CONFIG_ENV_KEYS.endpoint];
    envOverrides.push(CONFIG_ENV_KEYS.endpoint);
  }
  if (env[CONFIG_ENV_KEYS.apiKey]) {
    merged.apiKey = env[CONFIG_ENV_KEYS.apiKey];
    envOverrides.push(CONFIG_ENV_KEYS.apiKey);
  }
  if (env[CONFIG_ENV_KEYS.model]) {
    merged.model = env[CONFIG_ENV_KEYS.model];
    envOverrides.push(CONFIG_ENV_KEYS.model);
  }
  if (env[CONFIG_ENV_KEYS.provider]) {
    merged.provider = env[CONFIG_ENV_KEYS.provider];
    envOverrides.push(CONFIG_ENV_KEYS.provider);
  }
  if (env[CONFIG_ENV_KEYS.api]) {
    merged.api = env[CONFIG_ENV_KEYS.api] as ApiFlavor;
    envOverrides.push(CONFIG_ENV_KEYS.api);
  }
  if (env[CONFIG_ENV_KEYS.effort]) {
    const value = env[CONFIG_ENV_KEYS.effort]!;
    if (isEffortSetting(value)) {
      merged.effort = value;
      envOverrides.push(CONFIG_ENV_KEYS.effort);
    } else {
      warnings.push(`Ignoring invalid ${CONFIG_ENV_KEYS.effort}=${value}`);
    }
  }
  if (env[CONFIG_ENV_KEYS.permissions]) {
    merged.permissions = { ...(merged.permissions ?? DEFAULT_PERMISSIONS), preset: env[CONFIG_ENV_KEYS.permissions] as never };
    envOverrides.push(CONFIG_ENV_KEYS.permissions);
  }

  return {
    raw: applyDefaults(merged),
    sources,
    warnings,
    envOverrides,
    envFiles: fromEnvFiles.files,
    envKeys: fromEnvFiles.keys,
    projectRoot,
  };
}

function resolveProjectRoot(options: LoadOptions): string {
  const found = findUp(options.cwd, [CONFIG_DIR, "config.json"]);
  if (found) {
    const candidate = found.endsWith("config.json") ? path.dirname(path.dirname(found)) : path.dirname(found);
    if (!isProjectBoundary(candidate)) return candidate;
  }
  return findWorkspaceRoot(options.cwd);
}

export function applyDefaults(raw: BlueBirdConfig): BlueBirdConfig {
  return {
    ...raw,
    version: raw.version ?? CONFIG_VERSION,
    effort: raw.effort ?? DEFAULT_CONFIG.effort,
    context: { ...DEFAULT_CONTEXT, ...(raw.context ?? {}) },
    ui: { ...DEFAULT_UI, ...(raw.ui ?? {}) },
    agent: {
      ...DEFAULT_AGENT,
      ...(raw.agent ?? {}),
      subagents: { ...DEFAULT_AGENT.subagents, ...(raw.agent?.subagents ?? {}) },
    },
    permissions: { ...DEFAULT_PERMISSIONS, ...(raw.permissions ?? {}) },
    memory: { ...DEFAULT_MEMORY, ...(raw.memory ?? {}) },
    sessions: { ...DEFAULT_SESSIONS, ...(raw.sessions ?? {}) },
    update: { ...DEFAULT_UPDATE, ...(raw.update ?? {}) },
    images: { ...DEFAULT_IMAGES, ...(raw.images ?? {}) },
  };
}

export function mergeConfig(base: BlueBirdConfig, patch: Partial<BlueBirdConfig> | BlueBirdConfig): BlueBirdConfig {
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as unknown as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeObject(current, value as Record<string, unknown>);
    } else if (isPlainObject(value)) {
      out[key] = mergeObject({}, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as unknown as BlueBirdConfig;
}

function mergeObject(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeObject(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expands ${VAR}, ${VAR:-fallback} and $VAR from the environment. */
export function expandEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(ENV_PATTERN, (match, braced, fallback, bare) => {
    const name = (braced ?? bare) as string;
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback as string;
    return match;
  });
}

function hasUnresolvedEnv(value: string | undefined): boolean {
  return Boolean(value && /\$\{?[A-Za-z_]/.test(value));
}

export function listProviders(raw: BlueBirdConfig): Record<string, ProviderDef> {
  const providers: Record<string, ProviderDef> = {};
  for (const [id, def] of Object.entries(raw.providers ?? {})) {
    providers[id] = { ...def };
  }
  if (raw.endpoint) {
    const existing = providers[IMPLICIT_PROVIDER_ID];
    const contextWindow = raw.contextWindow ?? existing?.contextWindow;
    const maxOutput = raw.maxOutput ?? existing?.maxOutput;
    providers[IMPLICIT_PROVIDER_ID] = {
      ...(existing ?? { api: raw.api ?? "openai-completions" }),
      displayName: existing?.displayName ?? "Project endpoint",
      api: raw.api ?? existing?.api ?? "openai-completions",
      baseURL: raw.endpoint,
      ...(raw.apiKey ? { apiKey: raw.apiKey } : {}),
      ...(raw.apiKeyEnv ? { apiKeyEnv: raw.apiKeyEnv } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      models: existing?.models ?? [],
    };
  }
  return providers;
}

export function findProviderId(raw: BlueBirdConfig, requested?: string): string | undefined {
  const providers = listProviders(raw);
  const ids = Object.keys(providers);
  if (ids.length === 0) return undefined;
  if (requested && providers[requested]) return requested;
  if (raw.provider && providers[raw.provider]) return raw.provider;
  if (providers[IMPLICIT_PROVIDER_ID]) return IMPLICIT_PROVIDER_ID;
  if (raw.fallbacks?.length) {
    const first = splitModelRef(raw.fallbacks[0]!).provider;
    if (first && providers[first]) return first;
  }
  return ids[0];
}

export function splitModelRef(ref: string): { provider?: string; model: string } {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    if (provider && model && !provider.includes(":") && !model.startsWith("//")) {
      return { provider, model };
    }
  }
  return { model: trimmed };
}

function modelFromList(def: ProviderDef, modelId: string): ModelDef | undefined {
  const models = def.models ?? [];
  return (
    models.find((entry) => entry.id === modelId) ??
    models.find((entry) => entry.id.toLowerCase() === modelId.toLowerCase()) ??
    models.find((entry) => entry.name && entry.name.toLowerCase() === modelId.toLowerCase())
  );
}

export interface ResolveModelOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Explicit provider id. */
  provider?: string;
  /** Explicit model id (may itself be "provider/model"). */
  model?: string;
  /** Allow falling back to env keys such as OPENAI_API_KEY for the implicit provider. */
  allowGenericEnvKeys?: boolean;
}

export function resolveModel(
  raw: BlueBirdConfig,
  options: ResolveModelOptions = {},
  warnings: string[] = [],
): ResolvedModel {
  const env = options.env ?? process.env;
  const providers = listProviders(raw);
  const known = Object.keys(providers);

  if (known.length === 0) {
    throw new ConfigError("No model endpoint configured", {
      hint:
        "Run `bluebird init` to point Blue Bird at an endpoint, or set one directly:\n" +
        "  bluebird config set endpoint https://your-host/v1\n" +
        "  bluebird config set model your-model-id\n" +
        "  bluebird config set apiKey '${YOUR_API_KEY}'",
    });
  }

  const requested = options.model ?? raw.model;
  const fromRef = requested ? splitModelRef(requested) : { model: "" };
  const providerId =
    options.provider ??
    fromRef.provider ??
    findProviderId(raw, raw.provider) ??
    known[0]!;

  const def = providers[providerId];
  if (!def) {
    throw new ConfigError(`Unknown provider "${providerId}"`, {
      hint: `Configured providers: ${known.join(", ")}. Add it under "providers" in your config or pick one with --provider.`,
    });
  }

  const modelId = fromRef.model || def.models?.[0]?.id;
  if (!modelId) {
    throw new ConfigError(`No model selected for provider "${providerId}"`, {
      hint: `Run \`bluebird config set model <id>\` or list models in the provider's "models" array.`,
    });
  }

  const declared = modelFromList(def, modelId);
  if (!declared && (def.models?.length ?? 0) > 0) {
    warnings.push(
      `Model "${modelId}" is not listed under provider "${providerId}"; assuming provider defaults. Declare it to get accurate context and pricing.`,
    );
  }

  const api = (declared?.api ?? def.api ?? "openai-completions") as ApiFlavor;
  if (!API_FLAVORS.includes(api)) {
    throw new ConfigError(`Unknown api "${String(api)}" for provider "${providerId}"`, {
      hint: `Valid values: ${API_FLAVORS.join(", ")}`,
    });
  }

  let baseURL = expandEnv(def.baseURL ?? "", env);
  if (!baseURL) {
    throw new ConfigError(`Provider "${providerId}" has no baseURL`, {
      hint: "Set providers.<id>.baseURL (or the top-level `endpoint`) to the API root, e.g. https://host/openai/v1",
    });
  }
  if (!/^(https?|mock):\/\//i.test(baseURL)) {
    throw new ConfigError(`Provider "${providerId}" baseURL must start with http:// or https:// (got "${baseURL}")`);
  }
  baseURL = baseURL.replace(/\/+$/, "");

  const keyLookup = resolveApiKey({ providerId, def, env, allowGenericEnvKeys: options.allowGenericEnvKeys ?? true });
  if (keyLookup.warning) warnings.push(keyLookup.warning);

  const declaredWindow = declared?.contextWindow ?? def.contextWindow;
  const contextWindow =
    declaredWindow ??
    (Number(env.BLUEBIRD_CONTEXT_WINDOW ?? 0) || raw.context?.assumeWindow || DEFAULT_CONTEXT_WINDOW);
  const maxOutput = declared?.maxOutput ?? def.maxOutput ?? DEFAULT_MAX_OUTPUT;
  if (!declaredWindow) {
    warnings.push(
      `Assuming a ${formatCount(contextWindow)} token context window for "${modelId}". ` +
        `Declare contextWindow on the model (or context.assumeWindow) to match your provider exactly.`,
    );
  }

  const query = { ...(def.query ?? {}), ...(declared?.query ?? {}) };
  const model: ModelDef = {
    id: declared?.id ?? modelId,
    ...(declared?.name ? { name: declared.name } : {}),
    contextWindow,
    maxOutput,
    ...(declared?.pricing ? { pricing: declared.pricing } : {}),
    ...(Object.keys(query).length ? { query } : {}),
    ...(declared?.supportsEffort !== undefined ? { supportsEffort: declared.supportsEffort } : {}),
    ...(declared?.supportsTools !== undefined ? { supportsTools: declared.supportsTools } : {}),
    ...(declared?.supportsImages !== undefined ? { supportsImages: declared.supportsImages } : {}),
    /** True when the window is an assumption rather than a declaration. */
    assumedWindow: !declaredWindow,
  };

  return {
    providerId,
    provider: def,
    model,
    api,
    baseURL,
    ...(keyLookup.key ? { apiKey: keyLookup.key } : {}),
    apiKeySource: keyLookup.source,
    contextWindow,
    maxOutput,
    ...(declared?.pricing ? { pricing: declared.pricing } : {}),
    label: providerId === IMPLICIT_PROVIDER_ID ? model.id : `${providerId}/${model.id}`,
  };
}

export interface ApiKeyLookup {
  key?: string;
  source: ResolvedModel["apiKeySource"];
  warning?: string;
}

export function resolveApiKey(args: {
  providerId: string;
  def: ProviderDef;
  env?: NodeJS.ProcessEnv;
  allowGenericEnvKeys?: boolean;
}): ApiKeyLookup {
  const env = args.env ?? process.env;
  const { def, providerId } = args;

  const inline = def.apiKey ? expandEnv(def.apiKey, env) : undefined;
  if (inline && !hasUnresolvedEnv(inline)) {
    return { key: inline, source: "inline" };
  }
  if (inline && hasUnresolvedEnv(inline)) {
    return {
      source: "none",
      warning: `Provider "${providerId}" apiKey references an environment variable that is not set: ${inline}`,
    };
  }

  const envNames = [def.apiKeyEnv, providerId !== IMPLICIT_PROVIDER_ID ? `BLUEBIRD_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY` : undefined]
    .filter((value): value is string => Boolean(value));
  for (const name of envNames) {
    const value = env[name];
    if (value) return { key: value, source: "env" };
  }

  if (def.apiKeyFile) {
    const file = expandHome(def.apiKeyFile);
    if (fileExists(file)) {
      const key = readJsonSync<string>(file);
      if (typeof key === "string" && key.trim()) return { key: key.trim(), source: "file" };
    }
  }

  const credentials = readCredentials(env);
  const byId = credentials.providers?.[providerId];
  if (byId) return { key: byId, source: "file" };
  const origin = originOf(def.baseURL);
  const byHost = origin ? credentials.hosts?.[origin] : undefined;
  if (byHost) return { key: byHost, source: "file" };

  if (args.allowGenericEnvKeys !== false) {
    const generic = genericKeyFor(defapi(def), env);
    if (generic) return { key: generic, source: "env" };
  }

  return { source: "none" };
}

function defapi(def: ProviderDef): ApiFlavor {
  return (def.api ?? "openai-completions") as ApiFlavor;
}

function genericKeyFor(api: ApiFlavor, env: NodeJS.ProcessEnv): string | undefined {
  if (api === "anthropic-messages") return env.ANTHROPIC_API_KEY || undefined;
  if (api === "openai-completions" || api === "openai-responses") return env.OPENAI_API_KEY || undefined;
  if (api === "mock") return "mock";
  return undefined;
}

export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(expandEnv(url));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

interface CredentialsFile {
  providers?: Record<string, string>;
  hosts?: Record<string, string>;
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): CredentialsFile {
  const file = credentialsPath(env);
  const parsed = readJsonSync<CredentialsFile>(file);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function writeCredential(providerId: string, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = credentialsPath(env);
  const credentials = readCredentials(env);
  credentials.providers = { ...(credentials.providers ?? {}), [providerId]: key };
  writeJsonAtomic(file, credentials, { mode: 0o600 });
  return file;
}

export function resolveFallbackModels(raw: BlueBirdConfig, options: ResolveModelOptions = {}): ResolvedModel[] {
  const out: ResolvedModel[] = [];
  const providers = listProviders(raw);
  for (const ref of raw.fallbacks ?? []) {
    const parsed = splitModelRef(ref);
    // "provider/model" is explicit. A bare name is documented as either a
    // provider or a model id and the two are indistinguishable, so prefer an
    // exact provider match — the only reading that actually reaches a different
    // endpoint. Without this, "backup" resolved to a nonexistent model on the
    // primary provider rather than to the backup provider.
    const candidate = parsed.provider
      ? { provider: parsed.provider, model: parsed.model }
      : providers[parsed.model]
        ? { provider: parsed.model, model: "" } // "" selects that provider's first model
        : { model: parsed.model };
    try {
      out.push(resolveModel(raw, { ...options, ...candidate }, []));
    } catch {
      // Unresolvable fallbacks are reported by `bluebird doctor`, not fatal here.
    }
  }
  return out;
}

export interface LoadConfigOverrides {
  provider?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  configPath?: string;
}

export function loadConfig(options: LoadOptions & { overrides?: LoadConfigOverrides } = { cwd: process.cwd() }): ResolvedConfig {
  const env = options.env ?? process.env;
  const { raw, sources, warnings, envOverrides, projectRoot } = loadRawConfig(options);
  const overrides = options.overrides ?? {};

  const model = resolveModel(
    raw,
    {
      env,
      cwd: options.cwd,
      ...(overrides.provider ? { provider: overrides.provider } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
    },
    warnings,
  );

  let effort = raw.effort ?? "auto";
  if (overrides.effort) {
    if (!isEffortSetting(overrides.effort)) {
      throw new ConfigError(`Invalid effort "${overrides.effort}"`, { hint: `Choose one of: auto, ${EFFORT_LEVELS.join(", ")}` });
    }
    effort = overrides.effort;
  }
  if (!isEffortSetting(effort)) {
    warnings.push(`Invalid effort "${String(effort)}" in config; using "auto"`);
    effort = "auto";
  }

  if (overrides.permissions) {
    raw.permissions = { ...raw.permissions, preset: overrides.permissions as never };
  }

  const home = bluebirdHome(env);
  const cwd = safeRealPath(options.cwd);
  const root = isDirectory(projectRoot) ? projectRoot : cwd;

  return {
    raw,
    cwd,
    root,
    ...(sources.length ? { configPath: sources[sources.length - 1] } : {}),
    globalConfigPath: globalConfigPath(env),
    home,
    sources,
    model,
    effort,
    envOverrides,
    warnings,
  };
}

export function projectDataDir(resolved: Pick<ResolvedConfig, "root" | "raw">, kind: string): string {
  const dir = resolved.raw.sessions?.dir ?? CONFIG_DIR;
  return path.join(resolved.root, dir, kind);
}

export function workspaceId(root: string): string {
  return `${path.basename(root)}-${hashShort(root, 8)}`;
}

export function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") {
    if (Array.isArray(value)) return value.map((entry) => redactValue(key, entry));
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v);
      return out;
    }
    return value;
  }
  if (/apikey|token|secret|password|authorization/i.test(key)) {
    if (value.length <= 8) return "********";
    return `${value.slice(0, 3)}…${value.slice(-4)}`;
  }
  if (/\$\{?[A-Za-z_]/.test(value)) return value;
  return value;
}

export function redactConfig(raw: BlueBirdConfig): BlueBirdConfig {
  return redactValue("root", raw) as BlueBirdConfig;
}

export function validateConfig(raw: BlueBirdConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    warnings.push(`Config version ${raw.version} differs from supported version ${CONFIG_VERSION}`);
  }
  if (raw.effort !== undefined && !isEffortSetting(raw.effort)) {
    errors.push(`effort must be "auto" or one of ${EFFORT_LEVELS.join(", ")} (got ${JSON.stringify(raw.effort)})`);
  }
  if (raw.api !== undefined && !API_FLAVORS.includes(raw.api)) {
    errors.push(`api must be one of ${API_FLAVORS.join(", ")} (got ${JSON.stringify(raw.api)})`);
  }
  for (const [id, def] of Object.entries(raw.providers ?? {})) {
    if (!def.baseURL && !raw.endpoint) errors.push(`providers.${id}.baseURL is required`);
    if (def.api && !API_FLAVORS.includes(def.api)) {
      errors.push(`providers.${id}.api must be one of ${API_FLAVORS.join(", ")}`);
    }
    if (def.baseURL && !/^https?:\/\//i.test(expandEnv(def.baseURL))) {
      errors.push(`providers.${id}.baseURL must start with http:// or https://`);
    }
    if (def.retries !== undefined && (!Number.isInteger(def.retries) || def.retries < 0)) {
      errors.push(`providers.${id}.retries must be a non-negative integer`);
    }
    if (def.insecure) {
      warnings.push(
        `providers.${id}.insecure is not honoured: Blue Bird uses the built-in fetch client, which has no per-request TLS switch. ` +
          `Trust the certificate (NODE_EXTRA_CA_CERTS=/path/to/ca.pem) or point the provider at an http:// endpoint.`,
      );
    }
    for (const [modelIndex, model] of (def.models ?? []).entries()) {
      if (!model.id) errors.push(`providers.${id}.models[${modelIndex}].id is required`);
      if (model.api && !API_FLAVORS.includes(model.api)) {
        errors.push(`providers.${id}.models[${modelIndex}].api must be one of ${API_FLAVORS.join(", ")}`);
      }
    }
  }
  if (raw.context?.compactAt !== undefined && (raw.context.compactAt <= 0 || raw.context.compactAt > 1)) {
    errors.push("context.compactAt must be a fraction between 0 and 1");
  }
  if (raw.permissions?.preset && !["read-only", "ask", "edits", "auto", "danger-full-access"].includes(raw.permissions.preset)) {
    errors.push(`permissions.preset must be one of read-only, ask, edits, auto, danger-full-access`);
  }
  for (const [index, hook] of (raw.hooks ?? []).entries()) {
    if (!hook.command) errors.push(`hooks[${index}].command is required`);
    if (UNWIRED_HOOK_EVENTS.has(hook.event)) {
      warnings.push(
        `hooks[${index}] listens for "${hook.event}", which Blue Bird does not fire yet, so this hook will never run. ` +
          `Fired events: ${[...WIRED_HOOK_EVENTS].join(", ")}.`,
      );
    }
    if (hook.matcher) {
      try {
        new RegExp(hook.matcher);
      } catch {
        errors.push(`hooks[${index}].matcher is not a valid regular expression`);
      }
      if (WIRED_HOOK_EVENTS.has(hook.event) && !MATCHABLE_HOOK_EVENTS.has(hook.event)) {
        warnings.push(
          `hooks[${index}].matcher is ignored for "${hook.event}": that event carries nothing to match on.`,
        );
      }
    }
  }
  if (raw.mcpServers && Object.keys(raw.mcpServers).length > 0) {
    warnings.push(
      `mcpServers is configured but MCP support is not implemented yet, so those servers are not started. ` +
        `Expose the same tools through hooks or a project skill instead.`,
    );
  }
  return { errors, warnings };
}

/** Hook events the agent loop actually fires. */
export const WIRED_HOOK_EVENTS = new Set<HookEventValue>([
  "session.start",
  "prompt.submit",
  "tool.before",
  "tool.after",
  "turn.end",
  "compact.before",
]);

/** Declared and accepted in config, but no code path emits them yet. */
export const UNWIRED_HOOK_EVENTS = new Set<HookEventValue>(["session.end", "notification"]);

/** Wired events whose payload has a field a matcher can be applied to. */
const MATCHABLE_HOOK_EVENTS = new Set<HookEventValue>([
  "tool.before",
  "tool.after",
  "prompt.submit",
  "turn.end",
  "compact.before",
]);

export function saveConfigFile(file: string, config: BlueBirdConfig): void {
  const ordered: Record<string, unknown> = {};
  const preferred = [
    "$schema",
    "version",
    "endpoint",
    "api",
    "apiKey",
    "apiKeyEnv",
    "model",
    "provider",
    "fallbacks",
    "effort",
    "providers",
    "permissions",
    "context",
    "ui",
    "agent",
    "hooks",
    "mcpServers",
    "memory",
    "sessions",
    "includeDirectories",
  ];
  for (const key of preferred) {
    if (key in (config as unknown as Record<string, unknown>)) {
      ordered[key] = (config as unknown as Record<string, unknown>)[key];
    }
  }
  for (const [key, value] of Object.entries(config as unknown as Record<string, unknown>)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  writeJsonAtomic(file, ordered);
}
