# Changelog

All notable changes to Blue Bird are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The published package could not start after a normal install: Node refuses to strip TypeScript types
  from files inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and 0.1.0 shipped
  only `.ts` sources. `npm run build` now emits `dist/` with rewritten import extensions, the bin
  wrapper prefers it, and the tarball ships it instead of `src/`. Verified by installing the packed
  tarball and running `bb --version`, `bb init` and `bb doctor` from it.
- `npm pack`/`npm publish` build `dist/` automatically (`prepack`), and CI runs the compiled entry
  point so a broken or missing build fails before a release.

## [0.1.0] - 2026-09-26

### Added

- Agent loop with streaming, parallel read-only tool execution, loop guards, cancellation, retries
  with backoff and automatic provider fallback (`src/core/agent.ts`).
- Provider adapters for OpenAI chat completions, OpenAI responses and Anthropic messages, plus an
  offline `mock` dialect that runs without a network (`src/providers/`).
- Prompt caching: four Anthropic `cache_control` breakpoints, a per-session `prompt_cache_key` for
  OpenAI-compatible endpoints, 24h retention where supported, and rejected hints remembered so they
  are not retried on every turn (`src/providers/caching.ts`).
- Context engine: 1M-token default window, token estimation, stale tool-output pruning, automatic
  compaction at 82%, and a halve-and-retry path when a provider rejects an oversized prompt
  (`src/core/context.ts`).
- 15 built-in tools — `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`, `bash`, `bash_output`,
  `kill_shell`, `todo_write`, `task`, `skill`, `view_image`, `web_fetch`, `web_search` — all routed
  through the permission engine (`src/tools/`).
- Permission engine with five presets (`read-only`, `ask`, `edits`, `auto`, `danger-full-access`),
  glob allow/deny rules, and a hard block on catastrophic commands.
- Reasoning effort control: `auto` classification per request plus `none` … `xhigh` levels, wired to
  Anthropic thinking budgets and OpenAI `reasoning_effort`.
- Sessions: persistence, resume, transcripts, export, pruning, and checkpoints that back `/undo`
  without git.
- Interactive UI: minimal tool rows, diffs, status line with model, effort, context usage and cost,
  markdown streaming, `@file` and `@image` attachments, `!command` passthrough.
- Extensions: `BLUEBIRD.md`/`AGENTS.md`/`CLAUDE.md` instruction files, project skills, custom slash
  commands, named subagents, and lifecycle hooks.
- Commands: `init`, `chat`, `resume`, `run`, `config`, `models`, `effort`, `permissions`,
  `sessions`, `tools`, `agents`, `skills`, `commands`, `doctor`, `completion`, `version`, `help`.
- `run` for automation: `--json` result object, `--stream` events, pipe-friendly stdin, exit codes.
- Zero runtime dependencies — Node builtins only, nothing installed alongside the CLI.

[Unreleased]: https://github.com/ayush-thakur02/blue-bird-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ayush-thakur02/blue-bird-cli/releases/tag/v0.1.0
