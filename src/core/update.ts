import path from "node:path";
import { spawn } from "node:child_process";
import { bluebirdHome, fileExists, readJsonSync, writeJsonAtomic } from "../util/paths.ts";
import { npmCommand, npmGlobalPackageDirs, npmGlobalPrefix } from "../util/npm.ts";
import { DEFAULT_UPDATE, type BlueBirdConfig } from "../config/schema.ts";
import { PACKAGE_NAME, VERSION } from "../version.ts";

const CHECK_TIMEOUT_MS = 1500;
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}/latest`;

export interface UpdateState {
  /** Epoch ms of the last check that reached the registry. */
  checkedAt?: number;
  /** Newest version the registry reported. */
  latest?: string;
  /** Version a background update installed; the next start picks it up. */
  installed?: string;
  installedAt?: number;
  /** Last check failure, surfaced by `bluebird doctor`. */
  error?: string;
  /** Last failed background install, reported to the user instead of retried. */
  installError?: string;
  installErrorAt?: number;
}

export function updateStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(bluebirdHome(env), "update.json");
}

export function readUpdateState(env: NodeJS.ProcessEnv = process.env): UpdateState {
  const parsed = readJsonSync<UpdateState>(updateStatePath(env));
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function writeUpdateState(state: UpdateState, env: NodeJS.ProcessEnv = process.env): void {
  try {
    writeJsonAtomic(updateStatePath(env), state);
  } catch {
    // A read-only home directory must never break a session.
  }
}

/** Numeric semver comparison; a prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core = "", pre = ""] = value.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((piece) => Number(piece) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function isNewer(candidate: string, current: string = VERSION): boolean {
  return compareVersions(candidate, current) > 0;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed !== "" && trimmed !== "0" && trimmed !== "false" && trimmed !== "no";
}

/** A published install has no sources; a checkout does, and is updated with git. */
export function isSourceCheckout(packageRoot: string): boolean {
  return fileExists(path.join(packageRoot, "src", "cli.ts"));
}

/** Why the automatic check and install are skipped, or undefined when they may run. */
export function skipReason(options: {
  config?: BlueBirdConfig;
  env?: NodeJS.ProcessEnv;
  tty: boolean;
  packageRoot: string;
}): string | undefined {
  const env = options.env ?? process.env;
  if (enabled(env.BLUEBIRD_NO_UPDATE)) return "BLUEBIRD_NO_UPDATE is set";
  if (options.config?.update?.auto === false) return "update.auto is false";
  if (enabled(env.CI)) return "CI environment";
  if (!options.tty) return "no interactive terminal";
  if (isSourceCheckout(options.packageRoot)) return "running from a source checkout";
  return undefined;
}

export interface UpdateCheck {
  /** The newest version the registry reported, when one is known. */
  latest?: string;
  /** True when `latest` is newer than the running version. */
  newer: boolean;
  /** False when the cached answer was still fresh or the request failed. */
  checked: boolean;
  error?: string;
}

/**
 * Asks the registry for the newest version, at most once per interval. Failures
 * are recorded, never thrown: an offline machine must still start.
 */
export async function checkForUpdate(
  options: {
    current?: string;
    state?: UpdateState;
    intervalHours?: number;
    now?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<UpdateCheck> {
  const env = options.env ?? process.env;
  const current = options.current ?? VERSION;
  const state = options.state ?? readUpdateState(env);
  const interval = (options.intervalHours ?? DEFAULT_UPDATE.checkIntervalHours) * 3_600_000;
  const now = options.now ?? Date.now();

  if (state.latest && state.checkedAt && now - state.checkedAt < interval) {
    return { latest: state.latest, newer: isNewer(state.latest, current), checked: false };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(REGISTRY_LATEST_URL, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`registry responded ${response.status}`);
    const body = (await response.json()) as { version?: string };
    if (!body.version) throw new Error("registry response carried no version");
    writeUpdateState({ ...state, checkedAt: now, latest: body.version }, env);
    return { latest: body.version, newer: isNewer(body.version, current), checked: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeUpdateState({ ...state, checkedAt: now, error: message }, env);
    return {
      ...(state.latest ? { latest: state.latest } : {}),
      newer: state.latest ? isNewer(state.latest, current) : false,
      checked: false,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function installArgs(version: string): string[] {
  return ["install", "-g", `${PACKAGE_NAME}@${version}`];
}

/** Whether this copy lives in the npm global prefix, so npm is allowed to replace it. */
export function isNpmGlobalInstall(packageRoot: string, prefix: string | undefined): boolean {
  if (!prefix) return false;
  const root = path.resolve(packageRoot);
  return npmGlobalPackageDirs(prefix, PACKAGE_NAME).some((candidate) => root === path.resolve(candidate));
}

export interface InstallOutcome {
  ok: boolean;
  detail: string;
}

/** Starts `npm install -g` detached: it outlives this process if the user quits. */
export function spawnInstall(
  version: string,
  options: { env?: NodeJS.ProcessEnv; onExit?: (outcome: InstallOutcome) => void } = {},
): void {
  const child = spawn(npmCommand(), installArgs(version), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(options.env ?? {}), npm_config_update_notifier: "false" },
  });
  child.on("error", (error) => options.onExit?.({ ok: false, detail: error.message }));
  child.on("exit", (code) =>
    options.onExit?.(code === 0 ? { ok: true, detail: `installed ${version}` } : { ok: false, detail: `npm exited with ${code}` }),
  );
  child.unref();
}

export type UpdatePlan = { action: "install" } | { action: "notice"; notice: string };

/**
 * What to do about an available version: install it, or tell the user why not.
 * A copy npm does not own is only ever reported, and a failed install is
 * reported for one interval instead of being retried on every start.
 */
export function planUpdate(options: {
  state: UpdateState;
  version: string;
  canInstall: boolean;
  intervalHours?: number;
  now?: number;
}): UpdatePlan {
  const manual = `run \`npm install -g ${PACKAGE_NAME}\``;
  if (!options.canInstall) return { action: "notice", notice: `update available: ${options.version} — ${manual}` };

  const interval = (options.intervalHours ?? DEFAULT_UPDATE.checkIntervalHours) * 3_600_000;
  const now = options.now ?? Date.now();
  if (options.state.installError && options.state.installErrorAt && now - options.state.installErrorAt < interval) {
    return { action: "notice", notice: `update to ${options.version} failed (${options.state.installError}) — ${manual}` };
  }
  return { action: "install" };
}

export interface AutoUpdateResult {
  /** Line to show the user before the input box takes over the terminal. */
  notice?: string;
  /** Resolves with the installed version once the background install finishes. */
  installed?: Promise<string | undefined>;
}

/**
 * Checks for a newer release and installs it in the background. Only a copy that
 * npm itself installed is updated; anything else gets a notice with the command
 * to run, so a checkout or a pnpm/yarn install is never clobbered.
 */
export async function autoUpdateOnStart(options: {
  config: BlueBirdConfig;
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  tty: boolean;
}): Promise<AutoUpdateResult> {
  const env = options.env ?? process.env;
  if (skipReason({ config: options.config, env, tty: options.tty, packageRoot: options.packageRoot })) return {};

  const state = readUpdateState(env);
  const check = await checkForUpdate({ state, env });
  if (!check.newer || !check.latest) return {};

  const version = check.latest;
  const canInstall = isNpmGlobalInstall(options.packageRoot, npmGlobalPrefix());
  const plan = planUpdate({
    state,
    version,
    canInstall,
    ...(options.config.update?.checkIntervalHours !== undefined ? { intervalHours: options.config.update.checkIntervalHours } : {}),
  });
  if (plan.action === "notice") return { notice: plan.notice };

  const installed = new Promise<string | undefined>((resolve) => {
    spawnInstall(version, {
      env,
      onExit: (outcome) => {
        const current = readUpdateState(env);
        if (outcome.ok) {
          writeUpdateState({ ...current, installed: version, installedAt: Date.now(), installError: undefined }, env);
          resolve(version);
          return;
        }
        writeUpdateState({ ...current, installError: outcome.detail, installErrorAt: Date.now() }, env);
        resolve(undefined);
      },
    });
  });
  return { installed };
}
