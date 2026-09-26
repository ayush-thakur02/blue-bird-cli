# Blue Bird CLI

A coding agent for the terminal. Point it at **any** model endpoint, describe the work, and it
reads, edits, searches, runs commands and verifies the result — inside your repository.

```
  Blue Bird v0.1.0                                              ~/work/api

  model       gpt-5.6-terra  (azure)
  endpoint    https://my-foundry.openai.azure.com/openai/v1
  effort      auto (high)
  permissions ask
  context     14 tools · 3 subagents · 2 instruction files
  branch      feat/retry-logic

  Type /help for commands. Ctrl+C interrupts, twice to exit.

❯ add retry with backoff to src/net/fetch.ts and run the tests

⏺ Read(src/net/fetch.ts)                        84 lines · 0.1s
⏺ Edit(src/net/fetch.ts)                        +18 −2 · 0.3s
  ⎯⎯⎯ src/net/fetch.ts
  @@ -31,6 +31,24 @@
  + const RETRIES = 3;
  + ...
⏺ Bash(npm test)                                exit 0 · 2.1s

Added bounded retry with jitter to `fetchJson`, mirroring the existing backoff helper in
`src/net/retry.ts`. Tests pass (`npm test`, 42 passed).
```

## Why Blue Bird

- **Any endpoint, no vendor lock-in.** OpenAI chat completions, OpenAI responses, Anthropic
  messages, Azure, Bedrock-style gateways, vLLM, Ollama, LM Studio, LiteLLM, OpenRouter — or all
  of them at once with automatic failover.
- **Prompt caching everywhere.** Anthropic gets four `cache_control` breakpoints (system, tools,
  two conversation turns); OpenAI-compatible endpoints get a stable per-session `prompt_cache_key`
  and 24h retention where supported. Endpoints that reject a cache hint are remembered and skipped
  from then on — so caching is always attempted, never repeated. Cache hits show up in `/cost`.
- **1M-token context by default.** Blue Bird assumes a 1,000,000-token window unless a model
  declares otherwise, compacts at 82% of it, and if a provider still rejects an oversized prompt it
  halves the window, compacts harder and retries instead of failing your turn.
- **Vision built in.** Point it at a screenshot, mockup or diagram with `@shot.png` (or let it call
  `view_image`) and a multimodal model actually looks at it — via `image_url`, `image` or
  `input_image` parts depending on the dialect.
- **Zero runtime dependencies.** Nothing to audit and nothing to install beyond the package itself —
  the CLI ships compiled JavaScript that Node runs directly, and the source checkout runs TypeScript
  natively on Node 22.18+.
- **A real harness, not a chat wrapper.** Tool orchestration, context compaction, checkpoints,
  permission presets, lifecycle hooks, subagents, skills, plan mode, session persistence.
- **Effort you control.** `auto` classifies each request and picks a reasoning level; override any
  time with `/effort` or `--effort`. Anthropic gets thinking budgets, OpenAI-compatible endpoints
  get `reasoning_effort`.
- **Built for the terminal.** Minimal, quiet UI: tool rows as single lines, diffs when files
  change, a status line that tells you the model, effort, context usage and cost.

## Install

```bash
npm install -g @not.ayushthakur/blue-bird-cli     # provides: bluebird, blue-bird, bb
```

Requires **Node 22.18+**. From a checkout:

```bash
npm install --include=dev
npm run typecheck && npm test
node src/cli.ts --help
```

Development runs the TypeScript sources directly (Node strips the types). The published package ships
compiled JavaScript in `dist/`, built by `npm run build` and wired in automatically at pack time —
Node refuses to strip types inside `node_modules`, so an install cannot run from source.

To use the checkout itself as the `bb` command, anywhere on the machine:

```bash
npm link                 # or: npm run link / bluebird link
bb --version             # confirms the linked binary answers
npm unlink -g @not.ayushthakur/blue-bird-cli   # or: bluebird unlink
```

`bluebird link` runs `npm link` for you, then checks the global bin directory and starts the linked
binary, so a broken or shadowed link is reported instead of silently installed.

## Quickstart

```bash
cd your-project
bluebird init                 # wizard: endpoint, model, API key
bluebird                      # start a session
bluebird "fix the failing test in src/parse.test.ts"
bluebird run "summarize this branch" --json
```

`init` writes `.bluebird/config.json` in the project (commit it — it holds the endpoint and model,
never a secret), creates `BLUEBIRD.md` for project instructions, and keeps local state out of git.

Pick **Store it in .env** in the wizard and the key lands in `<project>/.env` as `MY_KEY=…` while the
config keeps the `${MY_KEY}` reference. `.env` is appended to, never rewritten: an existing entry is
updated in place and an identical value leaves the file untouched. The file is added to `.gitignore`
and loaded on every run (the process environment always wins). Non-interactively:

```bash
bluebird init --endpoint https://host/v1 --model gpt-5 --api-key-env OPENAI_API_KEY --api-key sk-…
bluebird init --api-key-env OPENAI_API_KEY   # flag a name; set the value yourself later
```

Both `<project>/.env` and `~/.bluebird/.env` are read; `bluebird config path` prints both, and
`bluebird doctor` lists which files were loaded and which variables came from them.

### The config file

```jsonc
{
  "version": 1,
  "endpoint": "https://my-foundry.openai.azure.com/openai/v1",
  "api": "openai-completions",          // or anthropic-messages / openai-responses
  "model": "gpt-5.6-terra",
  "apiKey": "${AZURE_OPENAI_API_KEY}",  // env interpolation, ${VAR:-fallback} supported
  "contextWindow": 1000000,             // 1M by default; declare your real window
  "effort": "auto",
  "permissions": { "preset": "ask" }
}
```

That is the whole minimum. Everything else — multiple providers, fallbacks, context policy, hooks,
MCP servers, UI preferences — is optional and documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
Keys can also live in `~/.bluebird/credentials.json` (chmod 600) so nothing secret touches the repo.

### Caching and context

| What | Where it comes from |
| --- | --- |
| Anthropic cache breakpoints | System prompt, last tool definition, and the two most recent conversation turns (the API allows four) |
| OpenAI cache key | `prompt_cache_key` derived from the session id, so every turn hits the same cache shard |
| Extended retention | `prompt_cache_retention: "24h"` on OpenAI and Azure OpenAI |
| Automatic prefix caching | Everything else — DeepSeek, Gemini-style gateways, LiteLLM and friends |
| Rejected hints | Remembered per provider for the process, so a strict gateway costs one extra request, not one per turn |
| Cache reporting | `/cost` shows tokens read/written and the hit ratio; the status line shows `cache NN%` |

`contextWindow` defaults to **1,000,000** tokens. Declare it on the model (or via
`context.assumeWindow`) when your deployment is smaller; if a provider still rejects a prompt as too
long, Blue Bird halves the effective window for the session, compacts, and retries automatically.

### Looking at images

```bash
bluebird "@designs/checkout.png what is wrong with the spacing here?"
bluebird "review @before.png and @after.png and tell me what changed"
```

Any PNG, JPEG, GIF or WebP mentioned with `@` is attached to the message, and the agent can also
call `view_image` on its own. Both paths go through the same limits (`images.maxBytes`,
`images.maxPerMessage`) and the same permission model. Text-only models are detected and the
attachment is skipped with a warning instead of breaking the request.

### Command surface

| Command | What it does |
| --- | --- |
| `bluebird [prompt]` | Interactive session, optionally with a first task |
| `bluebird run "<prompt>"` | One task, no interaction (`--json`, `--stream` for automation) |
| `bluebird init` | Configure endpoint, model, key, effort and permissions |
| `bluebird resume [id]` / `-c` | Continue a session |
| `bluebird config get/set/list/path` | Inspect and edit configuration |
| `bluebird models [--refresh]` | List configured models, or ask the endpoint |
| `bluebird effort [level]` | Show or set the default reasoning effort |
| `bluebird permissions [preset]` | Show or set permission mode, add allow/deny rules |
| `bluebird sessions list/show/export/rm` | Manage project sessions |
| `bluebird tools [name]` | List built-in tools or describe one |
| `bluebird agents` / `skills` / `commands` | Inspect project extensions |
| `bluebird doctor` | Verify environment, config, credentials and endpoint |
| `bluebird link` / `unlink` | Make `bb` available in every directory (`npm link`) |
| `bluebird completion bash\|zsh\|fish` | Shell completions |

Inside a session: `/help`, `/effort`, `/model`, `/plan`, `/permissions`, `/compact`, `/context`,
`/cost`, `/undo`, `/diff`, `/memory`, `/sessions`, `/export`, plus `@file` attachments,
`!command` shell passthrough and `#note` memory capture. See [docs/COMMANDS.md](docs/COMMANDS.md).

## How it works

```
prompt ─▶ system prompt ─▶ provider stream ─▶ assistant message
                ▲                                   │
                │                                   ▼
        context engine ◀── tool results ◀── tool registry ──▶ permission engine
        (compaction,            ▲                                    │
         pruning, budgets)      └── subagents (task tool) ◀──────────┘
```

- **The loop** (`src/core/agent.ts`) streams a response, executes tool calls (read-only ones in
  parallel), feeds results back, and repeats until the model stops calling tools. Loop guards catch
  repeated identical calls; retries with backoff and provider fallback handle flaky endpoints.
- **The context engine** (`src/core/context.ts`) estimates tokens, prunes stale tool output, and at
  `context.compactAt` summarizes older turns with the model (falling back to a deterministic
  structural summary) so long sessions keep working.
- **Tools** (`src/tools/`) are plain objects with JSON schemas: `read`, `write`, `edit`,
  `multi_edit`, `glob`, `grep`, `bash`, `bash_output`, `kill_shell`, `todo_write`, `task`, `skill`,
  `view_image`, `web_fetch`, `web_search`. Every one of them goes through the permission engine.
- **Checkpoints** (`src/core/checkpoint.ts`) snapshot file content before each mutation, so `/undo`
  restores the previous state without git.
- **Subagents** (`src/core/subagent.ts`) run isolated loops for `task` calls, keeping big
  investigations out of the main context.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Permissions

Five presets: `read-only`, `ask` (default), `edits`, `auto`, `danger-full-access`. On top of the
preset you can allow or deny anything with glob rules:

```jsonc
"permissions": {
  "preset": "auto",
  "deny": ["bash(rm -rf:*)", "edit(.env*)"],
  "allow": ["bash(npm test:*)", "edit(src/**)"]
}
```

Deliberately catastrophic commands (`rm -rf /`, `mkfs`, `dd` to a block device, `curl | sh`) are
blocked even in `danger-full-access` unless `permissions.allowDangerous` is set.

## Extending it

| Extension | Location | What it gives you |
| --- | --- | --- |
| Instructions | `BLUEBIRD.md`, `AGENTS.md`, `CLAUDE.md`, `.bluebird/memory/*.md` | Project rules loaded into every session |
| Skills | `.bluebird/skills/<name>/SKILL.md` | Step-by-step playbooks the agent loads on demand |
| Commands | `.bluebird/commands/<name>.md` | Your own `/slash` commands with `$ARGUMENTS` |
| Subagents | `.bluebird/agents/<name>.md` | Named roles for the `task` tool |
| Hooks | `hooks[]` in config | Shell callbacks on session, prompt, tool and compaction events |
| MCP | `mcpServers{}` in config | External tool servers (in progress) |

`~/.bluebird/` is the global equivalent of `.bluebird/` for anything you want everywhere.

## Automation

```bash
# machine-readable result
bluebird run "extract the API routes into a table" --json

# streaming events for a CI log
bluebird run "fix lint errors" --stream --yes --max-turns 20

# pipe a diff in, get a commit message
git diff | bluebird run "write a conventional commit message"
```

Exit codes: `0` success, `1` failure (config, provider or task error), `130` interrupted.

## Development

```bash
npm run typecheck     # tsc --noEmit (strict, erasableSyntaxOnly)
npm test              # node --test, no test framework dependency
npm run verify        # both
npm run build         # tsc -p tsconfig.build.json → dist/ (what the tarball ships)
npm run pack:check    # the file list npm would publish (builds first)
```

## Releasing

```bash
npm run release -- patch --dry-run   # show the version bump, changelog and tag
npm run release -- patch             # verify, bump, changelog, commit, tag
git push --follow-tags               # the tag publishes through GitHub Actions
```

`package.json`, `src/version.ts`, `package-lock.json` and `CHANGELOG.md` move together, so the version
cannot drift between the CLI banner and the registry. The full process — npm trusted publishing, the
first release, and the manual fallback — is in [docs/RELEASING.md](docs/RELEASING.md).

MIT licensed.
