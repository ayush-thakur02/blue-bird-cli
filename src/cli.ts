import path from "node:path";
import { parseArgs, flagBool, flagNumber, flagString } from "./cli/args.ts";
import { CLI_NAME, VERSION, CONFIG_DIR } from "./version.ts";
import { runChat } from "./commands/chat.ts";
import { runHeadless } from "./commands/run.ts";
import { runInit } from "./commands/init.ts";
import { runConfigCommand } from "./commands/config-cmd.ts";
import { runSessionsCommand } from "./commands/sessions.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runLinkCommand } from "./commands/link.ts";
import { runModelsCommand, runToolsCommand } from "./commands/models.ts";
import { listSessions } from "./core/session.ts";
import { findWorkspaceRoot } from "./util/paths.ts";
import { accent, bold, dim } from "./cli/prompt.ts";
import { BlueBirdError } from "./util/errors.ts";
import { refreshColor } from "./ui/ansi.ts";

const COMMANDS = new Set([
  "init",
  "run",
  "chat",
  "resume",
  "config",
  "models",
  "model",
  "effort",
  "permissions",
  "sessions",
  "doctor",
  "link",
  "unlink",
  "tools",
  "agents",
  "skills",
  "commands",
  "version",
  "help",
  "completion",
]);

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (flagBool(args, "version") || args.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const cwdFlag = flagString(args, "cwd");
  const cwd = cwdFlag ? path.resolve(cwdFlag) : process.cwd();
  if (cwdFlag) process.chdir(cwd);

  if (flagBool(args, "no-color")) {
    process.env.NO_COLOR = "1";
    refreshColor();
  }

  const command = args.command && COMMANDS.has(args.command) ? args.command : undefined;

  // `--help run` and `help run` are the same request.
  if (flagBool(args, "help")) {
    printHelp(command ?? args.positionals[0]);
    return 0;
  }

  if (!command && argv.length === 0) {
    return runChat({ cwd, args });
  }

  switch (command) {
    case "help":
      printHelp(args.positionals[0]);
      return 0;

    case "init": {
      const result = await runInit({
        cwd,
        yes: flagBool(args, "yes"),
        force: flagBool(args, "force"),
        global: flagBool(args, "global"),
        check: flagBool(args, "check"),
        json: flagBool(args, "json"),
        ...(flagString(args, "endpoint") ? { endpoint: flagString(args, "endpoint")! } : {}),
        ...(flagString(args, "model") ? { model: flagString(args, "model")! } : {}),
        ...(flagString(args, "api-key") ? { apiKey: flagString(args, "api-key")! } : {}),
        ...(flagString(args, "api-key-env") ? { apiKeyEnv: flagString(args, "api-key-env")! } : {}),
        ...(flagString(args, "api") ? { api: flagString(args, "api")! } : {}),
        ...(flagString(args, "effort") ? { effort: flagString(args, "effort")! } : {}),
        ...(flagString(args, "permission") ? { permission: flagString(args, "permission")! } : {}),
        ...(flagString(args, "provider") ? { providerId: flagString(args, "provider")! } : {}),
      });
      if (flagBool(args, "json")) {
        process.stdout.write(
          `${JSON.stringify(
            {
              config_path: result.configPath,
              memory_path: result.memoryPath ?? null,
              env_file: result.envFile ? { path: result.envFile.path, key: result.envFile.key, action: result.envFile.action } : null,
              probe: result.probe ?? null,
            },
            null,
            2,
          )}\n`,
        );
      }
      return result.wrote ? 0 : 1;
    }

    case "config": {
      const action = args.positionals[0] ?? "list";
      return runConfigCommand({
        cwd,
        action,
        ...(args.positionals[1] ? { key: args.positionals[1] } : {}),
        ...(args.positionals[2] ? { value: args.positionals.slice(2).join(" ") } : {}),
        global: flagBool(args, "global"),
        json: flagBool(args, "json"),
        ...(flagString(args, "config") ? { configPath: flagString(args, "config")! } : {}),
      });
    }

    case "effort": {
      return runConfigCommand({
        cwd,
        action: "effort",
        ...(args.positionals[0] ? { value: args.positionals[0] } : {}),
        global: flagBool(args, "global"),
        json: flagBool(args, "json"),
      });
    }

    case "permissions": {
      return runConfigCommand({
        cwd,
        action: "permissions",
        ...(args.positionals.length ? { value: args.positionals.join(" ") } : {}),
        global: flagBool(args, "global"),
        json: flagBool(args, "json"),
      });
    }

    case "models":
    case "model": {
      return runModelsCommand({
        cwd,
        refresh: flagBool(args, "refresh"),
        json: flagBool(args, "json"),
        ...(flagString(args, "provider") ? { provider: flagString(args, "provider")! } : {}),
      });
    }

    case "tools": {
      return runToolsCommand({
        cwd,
        ...(args.positionals[0] ? { name: args.positionals[0] } : {}),
        json: flagBool(args, "json"),
        disableSubagents: flagBool(args, "no-subagents"),
      });
    }

    case "doctor": {
      return runDoctor({ cwd, json: flagBool(args, "json"), offline: flagBool(args, "offline") });
    }

    case "link":
    case "unlink": {
      return runLinkCommand({ action: command, json: flagBool(args, "json") });
    }

    case "sessions": {
      return runSessionsCommand({
        cwd,
        action: args.positionals[0] ?? "list",
        ...(args.positionals[1] ? { id: args.positionals[1] } : {}),
        ...(args.positionals[2] ? { target: args.positionals[2] } : {}),
        ...(flagNumber(args, "limit") !== undefined ? { limit: flagNumber(args, "limit")! } : {}),
        ...(flagNumber(args, "days") !== undefined ? { days: flagNumber(args, "days")! } : {}),
        json: flagBool(args, "json"),
        includeArchived: flagBool(args, "all"),
      });
    }

    case "agents": {
      const { Runtime } = await import("./runtime.ts");
      const runtime = await Runtime.create({ cwd, logLevel: "error" });
      const providers = runtime.config.raw.providers ?? {};
      if (Object.keys(providers).length === 0 && !runtime.config.raw.endpoint) {
        // Runtime.create throws before this point, so this is only reached with a valid config.
      }
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(runtime.agents, null, 2)}\n`);
      } else {
        process.stdout.write(`${bold(`${runtime.agents.length} subagents`)}\n\n`);
        for (const agent of runtime.agents) {
          process.stdout.write(`  ${accent(agent.name.padEnd(10))} ${agent.description}\n`);
          process.stdout.write(`      ${dim(agent.source === "builtin" ? "built-in" : agent.source)}\n`);
        }
      }
      runtime.dispose();
      return 0;
    }

    case "skills": {
      const { Runtime } = await import("./runtime.ts");
      const runtime = await Runtime.create({ cwd, logLevel: "error" });
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(runtime.skills, null, 2)}\n`);
      } else if (runtime.skills.length === 0) {
        process.stdout.write(`${dim(`No skills installed. Add ${CONFIG_DIR}/skills/<name>/SKILL.md`)}\n`);
      } else {
        process.stdout.write(`${bold(`${runtime.skills.length} skills`)}\n\n`);
        for (const skill of runtime.skills) {
          process.stdout.write(`  ${accent(skill.name.padEnd(16))} ${skill.description}\n`);
          process.stdout.write(`      ${dim(skill.source)}\n`);
        }
      }
      runtime.dispose();
      return 0;
    }

    case "commands": {
      const { Runtime } = await import("./runtime.ts");
      const runtime = await Runtime.create({ cwd, logLevel: "error" });
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(runtime.commands, null, 2)}\n`);
      } else if (runtime.commands.length === 0) {
        process.stdout.write(`${dim(`No custom commands. Add ${CONFIG_DIR}/commands/<name>.md`)}\n`);
      } else {
        for (const entry of runtime.commands) {
          process.stdout.write(`  ${accent(`/${entry.name}`.padEnd(18))} ${entry.description}\n`);
        }
      }
      runtime.dispose();
      return 0;
    }

    case "resume": {
      const id = args.positionals[0];
      const resumeId = id ?? latestSessionId(cwd);
      if (!resumeId) {
        process.stderr.write("bluebird: no session to resume in this project\n");
        return 1;
      }
      return runChat({ cwd, args, resumeId });
    }

    case "chat": {
      const prompt = args.positionals.join(" ").trim();
      return runChat({ cwd, args, ...(prompt ? { initialPrompt: prompt } : {}), planMode: flagBool(args, "plan") });
    }

    case "run": {
      const prompt = args.positionals.join(" ").trim() || (await readStdin());
      if (!prompt.trim()) {
        process.stderr.write("bluebird: nothing to run — pass a prompt or pipe one on stdin\n");
        return 1;
      }
      const format = flagBool(args, "json") ? "json" : flagBool(args, "stream") ? "stream-json" : "text";
      return runHeadless({ cwd, args, prompt, outputFormat: format, quiet: flagBool(args, "quiet") });
    }

    case "completion": {
      const shell = args.positionals[0] ?? "bash";
      process.stdout.write(completionScript(shell));
      return 0;
    }

    default: {
      // A near-miss on a command name is a typo, not a prompt. Without this the
      // mistyped command silently became a model request.
      const typed = args.command ?? "";
      const near = nearestCommand(typed);
      if (near) {
        process.stderr.write(`bluebird: unknown command "${typed}" — did you mean \`bluebird ${near}\`?\n\n`);
        return 1;
      }
      const prompt = [args.command, ...args.positionals].filter(Boolean).join(" ").trim();
      const resumeId = flagString(args, "resume") ?? (flagBool(args, "continue") ? latestSessionId(cwd) : undefined);
      if (!prompt) {
        if (resumeId) {
          return runChat({ cwd, args, resumeId, planMode: flagBool(args, "plan") });
        }
        printHelp();
        return 0;
      }
      const headless = flagBool(args, "print") || flagBool(args, "json") || !process.stdin.isTTY;
      if (headless) {
        return runHeadless({
          cwd,
          args,
          prompt,
          outputFormat: flagBool(args, "json") ? "json" : flagBool(args, "stream") ? "stream-json" : "text",
          quiet: flagBool(args, "quiet"),
        });
      }
      return runChat({
        cwd,
        args,
        initialPrompt: prompt,
        planMode: flagBool(args, "plan"),
        ...(resumeId ? { resumeId } : {}),
      });
    }
  }
}

function latestSessionId(cwd: string): string | undefined {
  const root = findWorkspaceRoot(cwd);
  const sessions = listSessions(path.join(root, CONFIG_DIR, "sessions"), { limit: 1 });
  return sessions[0]?.id;
}

/**
 * A command name one edit away from what the user typed. Deliberately strict —
 * the first argument is usually prompt text, so only a genuine near-miss on a
 * multi-character command qualifies.
 */
function nearestCommand(typed: string): string | undefined {
  if (typed.length < 4 || !/^[a-z][a-z-]*$/i.test(typed)) return undefined;
  let best: string | undefined;
  for (const name of COMMANDS) {
    if (name.length < 4) continue;
    const allowed = Math.abs(name.length - typed.length) <= 1 ? 1 : 0;
    if (allowed === 0) continue;
    if (editDistance(typed.toLowerCase(), name) <= allowed) best = best && best.length <= name.length ? best : name;
  }
  return best === typed ? undefined : best;
}

function editDistance(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let index = 0; index <= b.length; index += 1) previous[index] = index;
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost);
    }
    for (let column = 0; column <= b.length; column += 1) previous[column] = current[column]!;
  }
  return previous[b.length]!;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function printHelp(topic?: string): void {
  if (topic) {
    const entry = HELP_TOPICS[topic];
    if (entry) {
      process.stdout.write(`${entry}\n`);
      return;
    }
  }
  process.stdout.write(helpText());
}

function helpText(): string {
  return `${bold("bluebird")} ${dim(`v${VERSION}`)} — a coding agent for your terminal

${bold("USAGE")}
  ${CLI_NAME} [prompt]                     interactive session, optionally with a first task
  ${CLI_NAME} run "<prompt>" [flags]       one task, no interaction (pipe-friendly)
  ${CLI_NAME} <command> [args]             see commands below

${bold("COMMANDS")}
  init                 configure the endpoint, model and API key for this repo
  chat                 start an interactive session explicitly
  resume [id]          resume the most recent session (or a specific one)
  config <action>      get/set/list configuration, providers, effort, permissions
  models [--refresh]   list configured models (or ask the endpoint)
  effort [level]       show or set the default reasoning effort
  permissions [preset] show or set the permission preset, or add allow/deny rules
  sessions <action>    list, show, export, prune, delete project sessions
  tools [name]         list built-in tools or describe one
  agents | skills      list subagents and skills available in this project
  doctor               verify environment, configuration, credentials and endpoint
  link | unlink        link this checkout into the global npm prefix (npm link)
  completion <shell>   print a bash/zsh/fish completion script
  version | help       version and this help

${bold("KEY FLAGS")}
  -m, --model <id>         override the model for this run
      --provider <id>      override the provider
  -e, --effort <level>     auto | none | minimal | low | medium | high | xhigh | max
  -p, --permission <mode>  read-only | ask | edits | auto | danger-full-access
      --plan               start in plan mode (read-only investigation)
      --resume <id>        resume a session
  -c, --continue           continue the most recent session
      --print              non-interactive output (implied when piped)
      --json               machine readable result object
      --stream             streaming JSON events for automation
      --max-turns <n>      cap assistant turns for this run
  -q, --quiet              suppress progress output
      --no-memory          ignore BLUEBIRD.md / AGENTS.md for this run
      --no-subagents       disable the task tool
      --config <path>      use a specific config file
  -C, --cwd <dir>          run against another directory
      --no-color           disable colors

${bold("EXAMPLES")}
  ${CLI_NAME} init --endpoint https://host/openai/v1 --model gpt-5 --api-key '\${MY_KEY}'
  ${CLI_NAME} "add retry logic to src/net/fetch.ts and run the tests"
  ${CLI_NAME} "@designs/checkout.png what is wrong with this layout?"
  ${CLI_NAME} run "summarize the diff on this branch" --json
  ${CLI_NAME} --effort xhigh --plan "how would you split this monolith?"
  git diff | ${CLI_NAME} run "write a conventional commit message for this"

${bold("INSIDE A SESSION")}
  /help for the command list · @file to attach a file · @shot.png to attach an image
  !cmd runs a shell command · #note remembers something · Tab completes commands and paths
`;
}

const HELP_TOPICS: Record<string, string> = {
  init: `bluebird init [flags]

  --endpoint <url>    API base URL, usually ending in /v1
  --model <id>        model or deployment id
  --api-key <value>   literal key or \${ENV_VAR}
  --api <dialect>     openai-completions | anthropic-messages | openai-responses | mock
  --effort <level>    default reasoning effort
  --permission <mode> default permission preset
  --provider <id>     write the endpoint under providers.<id> instead of the top level
  --check             probe the endpoint after writing
  --api-key-env <name> keep the key in .env as <name> instead of the config file
  --global            write to ~/.bluebird/config.json instead of .bluebird/config.json
  -y, --yes           no prompts: use flags and defaults
  -f, --force         overwrite without asking
`,
  link: `bluebird link [--json]

  Links this checkout into the global npm prefix, so \`bb\`, \`bluebird\` and
  \`blue-bird\` work in every directory, then runs the linked binary to confirm it
  answers. Equivalent to running \`npm link\` in the package directory.

  bluebird unlink      remove the global links again (\`npm unlink -g @not.ayushthakur/blue-bird-cli\`)

  Without a global install the source entry point still works:
    node /path/to/blue-bird-cli/src/cli.ts --help
`,
};

async function cli(): Promise<void> {
  installPipeGuard();
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    if (error instanceof BlueBirdError) {
      process.stderr.write(`\n  ${error.message}\n`);
      if (error.hint) process.stderr.write(`  ${error.hint.split("\n").join("\n  ")}\n\n`);
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`\n  Unexpected error:\n  ${message}\n\n`);
    process.exitCode = 1;
  }
}

/**
 * `bluebird run ... | head` closes stdout mid-write. Without this the process
 * dies with an unhandled EPIPE stack trace instead of exiting quietly like
 * every other unix tool.
 */
function installPipeGuard(): void {
  const onStreamError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
}

void cli();

function completionScript(shell: string): string {
  const commands = [...COMMANDS].join(" ");
  const flags = "--model --provider --effort --permission --plan --resume --continue --print --json --stream --max-turns --quiet --no-memory --no-subagents --config --cwd --no-color --help --version";
  if (shell === "zsh") {
    return `#compdef bluebird
_bluebird() {
  local -a commands
  commands=(${commands})
  _arguments '1:command:(${commands})' '*:prompt:_files' ${flags
    .split(" ")
    .map((flag) => `'${flag}'`)
    .join(" ")}
}
compdef _bluebird bluebird
`;
  }
  if (shell === "fish") {
    return commands
      .split(" ")
      .map((name) => `complete -c bluebird -n "__fish_use_subcommand" -a "${name}"`)
      .join("\n") + "\n";
  }
  return `_bluebird_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
    return
  fi
  COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )
}
complete -F _bluebird_complete bluebird
`;
}
