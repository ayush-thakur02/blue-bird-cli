import type {
  Logger,
  PermissionApi,
  PermissionPreset,
  PermissionRequest,
  PermissionVerdict,
  PromptApi,
} from "./contracts.ts";
import os from "node:os";
import { containsPath, relativePath, resolveFrom, safeRealPath } from "../util/paths.ts";
import { matchesGlob } from "../util/text.ts";

export interface PermissionEngineOptions {
  preset: PermissionPreset;
  allow?: string[];
  deny?: string[];
  trusted?: boolean;
  allowDangerous?: boolean;
  network?: boolean;
  cwd: string;
  workspaceRoot: string;
  additionalDirectories?: string[];
  prompt: PromptApi;
  logger: Logger;
  /** Called when the user chooses to persist an allow rule. */
  onPersistRule?: (rule: string) => void;
}

interface ParsedRule {
  tool: string;
  spec?: string;
  raw: string;
}

const CATASTROPHIC: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME|\/\*)\s*$/i, reason: "recursive delete of the filesystem root or home directory" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\.git\b/i, reason: "deleting the git repository" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "formatting a filesystem" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|vd)/i, reason: "writing raw bytes to a block device" },
  { pattern: />\s*\/dev\/(sd|nvme|hd|vd)/i, reason: "writing raw bytes to a block device" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/, reason: "fork bomb" },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/i, reason: "world-writable root filesystem" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "shutting down the machine" },
  { pattern: /\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, reason: "piping a remote script straight into a shell" },
  { pattern: /\bwget\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, reason: "piping a remote script straight into a shell" },
];

const RISKY: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b/i, reason: "running with elevated privileges" },
  { pattern: /\bgit\s+push\b[^\n]*--force/i, reason: "force pushing" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "discarding working-tree changes" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, reason: "deleting untracked files" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bcargo\s+publish\b/i, reason: "publishing a package" },
  { pattern: /\b(curl|wget|nc|ncat|telnet)\b/i, reason: "outbound network access from the shell" },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/i, reason: "granting world-writable permissions" },
  { pattern: /\bkill\s+-9\s+-1\b|\bpkill\s+-9\b/i, reason: "killing processes broadly" },
  { pattern: /\b(crontab|systemctl|launchctl)\b/i, reason: "changing system services" },
  { pattern: /\bssh\b|\bscp\b|\brsync\b[^\n]*:/i, reason: "reaching another host" },
];

const NETWORK_COMMANDS = /\b(curl|wget|npm\s+(install|i|add)|yarn\s+add|pnpm\s+(add|install)|pip\s+install|pip3\s+install|go\s+get|cargo\s+add|git\s+(clone|pull|fetch)|npx|pnpx|docker\s+pull)\b/i;

export function parseRule(raw: string): ParsedRule {
  const match = /^\s*([A-Za-z_*][\w*]*)\s*(?:\(\s*(.*?)\s*\))?\s*$/.exec(raw);
  if (!match) return { tool: raw.trim(), raw };
  return { tool: match[1] ?? raw.trim(), ...(match[2] ? { spec: match[2] } : {}), raw };
}

function specMatches(spec: string, candidates: string[]): boolean {
  const normalizedSpec = spec.trim();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (normalizedSpec === "*" || normalizedSpec === "**") return true;
    if (normalizedSpec.endsWith(":*")) {
      const prefix = normalizedSpec.slice(0, -2);
      if (candidate === prefix || candidate.startsWith(`${prefix} `) || candidate.startsWith(`${prefix}/`)) return true;
      continue;
    }
    if (matchesGlob(normalizedSpec, candidate)) return true;
    if (matchesGlob(normalizedSpec, safeRealPath(candidate))) return true;
    const relative = candidate.replace(/^\.\//, "");
    if (matchesGlob(normalizedSpec, relative)) return true;
    if (matchesGlob(`**/${normalizedSpec}`, relative)) return true;
  }
  return false;
}

export function ruleMatches(rule: ParsedRule, request: PermissionRequest, cwd: string): boolean {
  if (rule.tool !== "*" && rule.tool.toLowerCase() !== request.tool.toLowerCase()) return false;
  if (!rule.spec) return true;
  const candidates: string[] = [];
  if (request.command) candidates.push(request.command.trim());
  for (const filePath of request.paths ?? []) {
    candidates.push(filePath);
    candidates.push(relativePath(cwd, filePath));
    candidates.push(relativePath(cwd, filePath).replace(/^\.\//, ""));
  }
  return specMatches(rule.spec, candidates);
}

export class PermissionEngine implements PermissionApi {
  preset: PermissionPreset;
  private readonly options: PermissionEngineOptions;
  private readonly allowRules: ParsedRule[];
  private readonly denyRules: ParsedRule[];
  private readonly sessionAllow = new Set<string>();
  private readonly sessionDeny = new Set<string>();
  private alwaysAllowAll = false;

  constructor(options: PermissionEngineOptions) {
    this.options = options;
    this.preset = options.preset;
    this.allowRules = (options.allow ?? []).map(parseRule);
    this.denyRules = (options.deny ?? []).map(parseRule);
  }

  get presets() {
    return this.preset;
  }

  setPreset(preset: PermissionPreset): void {
    this.preset = preset;
    this.options.preset = preset;
  }

  resetSessionGrants(): void {
    this.sessionAllow.clear();
    this.sessionDeny.clear();
    this.alwaysAllowAll = false;
  }

  rules(): { allow: string[]; deny: string[] } {
    return {
      allow: this.allowRules.map((rule) => rule.raw),
      deny: this.denyRules.map((rule) => rule.raw),
    };
  }

  addRule(decision: "allow" | "deny", rule: string): void {
    if (decision === "allow") this.allowRules.push(parseRule(rule));
    else this.denyRules.push(parseRule(rule));
  }

  /** Adds a session-scoped grant, used by the "allow for this session" choice. */
  grantSession(request: PermissionRequest): void {
    this.sessionAllow.add(this.keyFor(request));
  }

  grantAll(): void {
    this.alwaysAllowAll = true;
  }

  denySession(request: PermissionRequest): void {
    this.sessionDeny.add(this.keyFor(request));
  }

  private keyFor(request: PermissionRequest): string {
    const target = request.command ?? request.paths?.[0] ?? request.summary;
    return `${request.tool}::${target}`;
  }

  async check(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionVerdict> {
    const key = this.keyFor(request);

    if (this.sessionDeny.has(key)) return { allowed: false, via: "session:deny", reason: "Denied earlier in this session" };

    for (const rule of this.denyRules) {
      if (ruleMatches(rule, request, this.options.cwd)) {
        return { allowed: false, via: `rule:deny ${rule.raw}`, reason: `Blocked by deny rule "${rule.raw}"` };
      }
    }

    if (this.preset === "danger-full-access" && this.options.allowDangerous) {
      return { allowed: true, via: "preset:danger-full-access" };
    }

    const catastrophic = this.detectCatastrophic(request);
    if (catastrophic) {
      const allowed = await this.ask(request, { forced: true, reason: catastrophic, signal });
      return allowed;
    }

    if (this.alwaysAllowAll || this.sessionAllow.has(key)) {
      return { allowed: true, via: "session:allow" };
    }

    for (const rule of this.allowRules) {
      if (ruleMatches(rule, request, this.options.cwd)) {
        return { allowed: true, via: `rule:allow ${rule.raw}` };
      }
    }

    // An untrusted workspace never gets an implicit yes. Rules the user wrote
    // and read-only inspection still work; everything that mutates or executes
    // has to be confirmed, whatever the preset says.
    if (this.options.trusted === false && !request.readOnly) {
      return this.ask(request, { signal, reason: "permissions.trusted is false for this workspace" });
    }

    if (this.preset === "danger-full-access") {
      return { allowed: true, via: "preset:danger-full-access" };
    }

    if (request.readOnly && this.preset !== "read-only") {
      if (request.tool === "web_fetch" || request.tool === "web_search") {
        if (this.options.network === false) {
          return { allowed: false, via: "config:network", reason: "Network tools are disabled (permissions.network = false)" };
        }
        return this.ask(request, { signal });
      }
      return { allowed: true, via: `preset:${this.preset}` };
    }

    if (this.preset === "read-only") {
      const reason = `Blueprint is in read-only mode: ${request.tool} cannot run`;
      return { allowed: false, via: "preset:read-only", reason };
    }

    const risky = this.detectRisky(request);
    const outside = this.outsideWorkspace(request);

    if (this.preset === "auto" && !risky && !outside) {
      return { allowed: true, via: "preset:auto" };
    }

    if (this.preset === "edits" && !risky) {
      if (request.tool === "write" || request.tool === "edit" || request.tool === "multi_edit") {
        if (!outside) return { allowed: true, via: "preset:edits" };
      }
      if (request.tool === "bash" && this.isTrivialCommand(request)) {
        return { allowed: true, via: "preset:edits" };
      }
    }

    return this.ask(request, { signal, reason: risky ?? outside });
  }

  private isTrivialCommand(request: PermissionRequest): boolean {
    const command = (request.command ?? "").trim();
    return /^(ls|pwd|cat|head|tail|wc|file|stat|tree|rg|grep|find|fd|git\s+(status|diff|log|show|branch|remote|rev-parse)|node\s+(-v|--version)|npm\s+-v|npm\s+(test|run\s+(test|lint|typecheck|build|check))|pnpm\s+(test|run\s+\w+)|yarn\s+(test|run\s+\w+)|python3?\s+-m\s+(pytest|unittest)|pytest|cargo\s+(test|check|build)|go\s+(test|build|vet)|make\s+\w+|tsc)\b/.test(
      command,
    );
  }

  private detectCatastrophic(request: PermissionRequest): string | undefined {
    if (!request.command) return undefined;
    for (const entry of CATASTROPHIC) {
      if (entry.pattern.test(request.command)) return entry.reason;
    }
    return undefined;
  }

  private detectRisky(request: PermissionRequest): string | undefined {
    if (request.risk === "high") return "high-risk operation";
    if (!request.command) return undefined;
    for (const entry of RISKY) {
      if (entry.pattern.test(request.command)) return entry.reason;
    }
    if (this.options.network === false && NETWORK_COMMANDS.test(request.command)) return "network access is disabled";
    return undefined;
  }

  private outsideWorkspace(request: PermissionRequest): string | undefined {
    for (const filePath of request.paths ?? []) {
      if (!this.isAllowedPath(filePath)) return `path outside the workspace: ${filePath}`;
    }
    if (request.command) {
      const match = request.command.match(/(?<![\w./-])(\/(?:[\w.@+-]+\/)*[\w.@+-]+)/g);
      for (const candidate of match ?? []) {
        if (isIncidentalAbsolutePath(candidate)) continue;
        if (!this.isAllowedPath(candidate)) return `command touches ${candidate}, outside the workspace`;
      }
    }
    return undefined;
  }

  isAllowedPath(filePath: string): boolean {
    const absolute = resolveFrom(this.options.cwd, filePath);
    if (containsPath(this.options.workspaceRoot, absolute)) return true;
    for (const extra of this.options.additionalDirectories ?? []) {
      if (containsPath(resolveFrom(this.options.cwd, extra), absolute)) return true;
    }
    return false;
  }

  private async ask(
    request: PermissionRequest,
    options: { forced?: boolean; reason?: string; signal?: AbortSignal },
  ): Promise<PermissionVerdict> {
    const reason = options.reason;
    const optionsList = options.forced
      ? [
          { value: "deny", label: "Deny", key: "n", description: "Do not run this", danger: true },
          ...(this.options.allowDangerous
            ? []
            : [{ value: "danger", label: "Allow dangerous commands this session", key: "d", danger: true }]),
          { value: "yes", label: "Run anyway", key: "y", danger: true },
        ]
      : [
          { value: "yes", label: "Allow once", key: "y" },
          { value: "session", label: "Allow for this session", key: "s" },
          { value: "persist", label: "Always allow (save to config)", key: "a" },
          { value: "deny", label: "Deny", key: "n", danger: true },
        ];

    const choice = await this.options.prompt.confirm({
      title: options.forced ? `Dangerous operation blocked: ${request.tool}` : `Allow ${request.tool}?`,
      detail: request.summary,
      ...(request.detail ? { body: request.detail } : {}),
      tone: options.forced || request.risk === "high" ? "warn" : "info",
      options: optionsList,
      defaultOption: options.forced ? "deny" : "yes",
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (choice === "yes") return { allowed: true, via: "user:once" };
    if (choice === "session") {
      this.grantSession(request);
      return { allowed: true, via: "user:session" };
    }
    if (choice === "persist") {
      this.grantSession(request);
      const rule = this.ruleFor(request);
      this.allowRules.push(parseRule(rule));
      this.options.onPersistRule?.(rule);
      return { allowed: true, via: `user:persisted ${rule}` };
    }
    if (choice === "danger") {
      this.options.allowDangerous = true;
      this.grantSession(request);
      return { allowed: true, via: "user:danger" };
    }
    return {
      allowed: false,
      via: "user:deny",
      reason: options.forced ? `Blocked: ${reason ?? request.summary}` : "The user denied this action",
    };
  }

  ruleFor(request: PermissionRequest): string {
    if (request.command) {
      const head = request.command.trim().split(/\s+/).slice(0, 2).join(" ");
      return `${request.tool}(${head}:*)`;
    }
    const target = request.paths?.[0];
    if (target) {
      const relative = relativePath(this.options.cwd, target);
      const directory = relative.includes("/") ? `${relative.split("/")[0]}/**` : relative;
      return `${request.tool}(${directory})`;
    }
    return request.tool;
  }
}

export function describeRequest(request: PermissionRequest): string {
  if (request.command) return request.command;
  if (request.paths?.length) return request.paths.join(", ");
  return request.summary;
}

/** Device nodes and the OS temp directory that commands routinely touch without risk. */
const INCIDENTAL_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty"]);

function isIncidentalAbsolutePath(candidate: string): boolean {
  if (INCIDENTAL_PATHS.has(candidate)) return true;
  const tmp = os.tmpdir();
  return candidate === tmp || candidate.startsWith(`${tmp}/`);
}
