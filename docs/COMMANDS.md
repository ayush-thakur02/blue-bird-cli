# Commands

Two surfaces: `bluebird <command>` from the shell, and `/command` inside a session.

## Shell

```
bluebird [prompt] [flags]           start a session (optionally with a first task)
bluebird chat [prompt]              same, explicitly
bluebird run "<prompt>" [flags]     one task, no interaction
bluebird init [flags]               configure endpoint, model, key
bluebird resume [id]                resume the newest or a specific session
bluebird config <action>            get / set / list / unset / edit / path / providers / effort / permissions
bluebird models [--refresh]         configured models, or ask the endpoint
bluebird effort [level]             show or set the default effort
bluebird permissions [preset|allow|deny]
bluebird sessions <action>          list / show / export / rm / prune / stats
bluebird tools [name]               list built-in tools or describe one
bluebird agents | skills | commands list project extensions
bluebird doctor [--offline]         environment, config, credential and endpoint checks
bluebird link | unlink              link this checkout into the global npm prefix
bluebird completion bash|zsh|fish   shell completion script
bluebird help [command]             help
bluebird version
```

### Flags

| Flag | Applies to | Effect |
| --- | --- | --- |
| `-m, --model <id>` | session, run | Override the model |
| `--provider <id>` | session, run | Override the provider |
| `-e, --effort <level>` | session, run | `auto`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `-p, --permission <mode>` | session, run | Permission preset |
| `--plan` | session, run | Start in plan mode (read-only investigation) |
| `--resume <id>`, `-c/--continue` | session | Resume a session |
| `--print`, `--json`, `--stream` | run | Output formats (see below) |
| `--max-turns <n>` | run | Cap assistant turns |
| `-y, --yes` | run, init | Auto-approve prompts / skip questions |
| `--api-key-env <name>` | init | Keep the key in `.env` under `<name>`; the config stores `${<name>}` |
| `--api-key <value>` | init | Literal key, `${ENV_VAR}` reference, or the value written to `.env` with `--api-key-env` |
| `-q, --quiet` | run | Suppress progress output |
| `--no-memory`, `--no-subagents` | session, run | Disable instruction files / the task tool |
| `-C, --cwd <dir>` | all | Run against another directory |
| `--config <path>` | all | Use a specific config file |
| `--no-color` | all | Disable colors |
| `--offline` | doctor | Skip the network probe |
| `--global` | config, effort, permissions, init | Target `~/.bluebird/` |

Interactive sessions also check for a newer release (at most once a day) and install it in the
background when npm owns this copy; `BLUEBIRD_NO_UPDATE=1` or `"update": { "auto": false }` turns that
off. `bluebird doctor` reports what the last check found.

### Output formats for `run`

```
$ bluebird run "list the API routes" --json
{"type":"result","result":"…","session_id":"…","usage":{…},"turns":3,
 "tool_calls":5,"stop_reason":"end_turn","duration_ms":8123,
 "files_changed":[],"cost_usd":0.031}

$ bluebird run "fix lint" --stream
{"type":"tool_start","name":"bash","summary":"npx eslint ."}
{"type":"tool_end","name":"bash","isError":false,"summary":"exit 0 · 2.1s","durationMs":2100}
{"type":"turn_end","usage":{…},"stopReason":"end_turn"}
{"type":"result","result":"…"}
```

Exit codes: `0` success · `1` error (config, provider, task) · `130` interrupted.

## In-session

### Session control

| Command | Description |
| --- | --- |
| `/help` | Command list, including project commands |
| `/status` | Model, endpoint, key source, effort, permissions, context, session |
| `/context` | Context budget breakdown |
| `/cost` | Token totals and estimated cost |
| `/compact [note]` | Summarize the session; a note focuses the summary |
| `/clear` | Drop the conversation, keep the session |
| `/new` | Start a fresh session |
| `/sessions` | List recent sessions |
| `/resume <id>` | Switch to another session |
| `/export [file]` | Write the transcript as markdown |
| `/quit` | Exit (also Ctrl+D) |

### Model and behaviour

| Command | Description |
| --- | --- |
| `/effort [level]` | Show or set the reasoning effort (`auto` recommended) |
| `/model [name]` | Show available models or switch |
| `/provider [id]` | Show providers or switch |
| `/permissions [preset]` | Show or set the preset |
| `/permissions allow <rule>` | Add an allow rule for this session |
| `/permissions deny <rule>` | Add a deny rule |
| `/plan [on\|off]` | Toggle plan mode |
| `/verbose` | Toggle full tool output |

### Files and memory

| Command | Description |
| --- | --- |
| `/memory` | Instruction files in effect |
| `/tools [name]` | Tools and their parameters |
| `/agents`, `/skills` | Subagents and skills |
| `/diff` | Files changed in this session |
| `/checkpoints` | Restore points |
| `/undo` | Restore files from the last turn |

### Input syntax

| Syntax | Effect |
| --- | --- |
| `@path/to/file` | Attach the file's contents to your message (tab-completes) |
| `@path/to/shot.png` | Attach an image for a multimodal model (PNG, JPEG, GIF, WebP) |
| `!command` | Run a shell command directly, without the model |
| `#note` | Append the note to `BLUEBIRD.md` and reload instructions |
| trailing `\` | Continue the message on the next line |
| `Tab` | Complete `/commands` and `@paths` |
| `↑` / `↓` | History (Ctrl+P / Ctrl+N in multiline) |
| `Ctrl+C` | Interrupt the turn; twice exits |
| `Ctrl+D` | Exit |
| `Enter` while streaming | Queues your message for the next turn |
| `Alt+Enter` | Insert a newline |

### Reading the status line

```
main · gpt-5.6-terra · effort:auto (high) · cache 94% · 128k/1M · $0.42
```

`cache NN%` appears once the session has read a meaningful amount from the prompt cache. `/cost`
gives the exact split (read, written, hit ratio) and `/context` reports the effective window,
whether it was declared or assumed, and how much of the budget is in use.

## Tools

| Tool | Permission | Purpose |
| --- | --- | --- |
| `read` | read-only | File contents with line numbers, paging, binary detection; images are handed to the model |
| `write` | write | Create or replace a file (must have been read first) |
| `edit` | write | Exact string replacement with uniqueness checking |
| `multi_edit` | write | Several sequential replacements, atomic |
| `glob` | read-only | Find files by pattern, newest first, gitignore-aware |
| `grep` | read-only | Regex search with modes, context lines and result caps |
| `bash` | exec | Shell command with timeout, output capture, optional background |
| `bash_output` | read-only | Read/wait on a background command |
| `kill_shell` | exec | Stop background commands |
| `todo_write` | planning | Maintain the visible task list |
| `task` | subagent | Delegate to an isolated subagent |
| `skill` | read-only | Load a project skill |
| `view_image` | read-only | Look at a PNG/JPEG/GIF/WebP — screenshots, mockups, diagrams, photos |
| `web_fetch` | read-only | Fetch a URL as markdown |
| `web_search` | read-only | Web search (Tavily/Brave/Serper key, else DuckDuckGo) |

`view_image` and `@image` attachments are hidden for models that are known or declared text-only.
Set `supportsImages: true` on a model entry to override the detection.

## Project files

```
.bluebird/
├── config.json          committed: endpoint, model, effort, permissions, hooks
├── config.local.json    gitignored: personal overrides
├── sessions/            transcripts (meta + JSONL)
├── checkpoints/         undo snapshots
├── skills/<name>/SKILL.md
├── commands/<name>.md
├── agents/<name>.md
└── memory/*.md          accumulated notes (#note writes to BLUEBIRD.md instead)
```

`.env` sits next to `.bluebird/` (or at `~/.bluebird/.env` for the global config) and holds keys as
`NAME=value`. It is read on every run, never overrides the process environment, and `bluebird init`
writes to it with an update-in-place check instead of appending duplicates. `.env` is added to
`.gitignore` when `init` creates it.

### Custom commands

`.bluebird/commands/fix-issue.md`:

```markdown
---
description: Investigate and fix a GitHub issue
argument-hint: <issue-number>
---

Read issue #$1 with `gh issue view $1`, reproduce it, then fix it.

Full request: $ARGUMENTS
```

Then `/fix-issue 421` runs it with the model.

### Skills

`.bluebird/skills/release/SKILL.md`:

```markdown
---
name: release
description: Cut a release — version bump, changelog, tag
when_to_use: The user asks to release, publish or tag a version
---

1. Run `npm test` and `npm run build`.
2. Bump the version in package.json following semver.
3. Generate CHANGELOG entries from `git log --oneline $(git describe --tags --abbrev=0)..HEAD`.
4. Commit, tag, and print the exact push commands without running them.
```

### Subagents

`.bluebird/agents/security.md`:

```markdown
---
name: security
description: Audits a diff for injection, secret leakage and unsafe defaults
tools: [read, grep, glob]
read_only: true
---

Review the requested change as a security engineer. Report findings with file:line references and a
severity, or state clearly that you found nothing.
```

Use it with `task({ agent: "security", prompt: "audit the changes in src/auth" })`.
