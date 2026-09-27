# Changelog

All notable changes to Blue Bird are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-27

### Added

- **`max` reasoning effort**, one level above `xhigh` for problems where a wrong answer costs more
  than the thinking. It maps to `reasoning_effort: "max"` on OpenAI-style endpoints and a 64k
  thinking budget on Anthropic; `auto` reaches it only when the prompt asks for the largest budget
  by name, so the classifier never drifts into the most expensive level on its own.
- **The input box is a text area.** Long lines wrap onto the next row instead of scrolling sideways,
  the box grows with them and follows the caret past eight rows, and `↑`/`↓` walk the wrapped rows of
  a draft before they fall back to history. Wrapping slices on grapheme boundaries, so wide
  characters and emoji are never cut in half.

### Fixed

- **A dropped-tools retry is no longer silent.** Azure reasoning deployments reject function calls on
  `/v1/chat/completions`, and the compatibility ladder used to strip `tools` and continue, leaving a
  model with no way to read or edit anything — it answered by asking for "file and terminal access",
  which reads as a permissions bug. Every provider now says so in the transcript the moment function
  calling is dropped, and names the API that supports it (`api: "openai-responses"`).

## [0.2.0] - 2026-09-26

### Added

- `bluebird` updates itself: interactive sessions check the registry at most once a day (cached in
  `~/.bluebird/update.json`) and install a newer release with `npm install -g` in the background,
  printing one line when it lands. Only a copy npm installed is replaced — checkouts, CI and
  non-interactive runs are skipped, and anything else gets the command to run instead. Opt out with
  `BLUEBIRD_NO_UPDATE=1` or `"update": { "auto": false }`; `bluebird doctor` reports the last check.

### Fixed

- The input box walked one row up the screen on every keystroke, taking the transcript with it. The
  cursor is left on a known row inside the block, and the erase moves back by exactly that offset
  instead of the whole block height (`src/ui/screen.ts`).
- The caret was drawn one cell left of the typed text, and permission prompts erased a line of
  transcript above the box because their option row was drawn outside the block.
- Ctrl+C could leave a session alive but deaf: raw stdin kept the event loop running after teardown,
  and an in-flight request was never cancelled on exit. Stopping the input now releases the terminal,
  quitting aborts the turn, and a non-zero exit can no longer hang on a stray handle.
- An interrupt now cancels the queued messages behind it (`dropped N queued messages`) instead of
  starting the next one immediately, and it also stops `!command` passthrough, which previously ran
  to completion because preprocessing had no signal.

## [0.1.1] - 2026-09-26

### Fixed

- The published package could not start after a normal install: Node refuses to strip TypeScript types
  from files inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and 0.1.0 shipped
  only `.ts` sources. `npm run build` now emits `dist/` with rewritten import extensions, the tarball
  ships `dist/` instead of `src/`, and the bin wrapper runs the sources in a checkout and the compiled
  output when installed. Verified by installing the packed tarball and running `bb --version`,
  `bb init` and `bb doctor` from it.
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

[Unreleased]: https://github.com/ayush-thakur02/blue-bird-cli/compare/v0.3.0...HEAD
[0.1.0]: https://github.com/ayush-thakur02/blue-bird-cli/releases/tag/v0.1.0
[0.1.1]: https://github.com/ayush-thakur02/blue-bird-cli/compare/v0.1.0...v0.1.1
[0.2.0]: https://github.com/ayush-thakur02/blue-bird-cli/compare/v0.1.1...v0.2.0
[0.3.0]: https://github.com/ayush-thakur02/blue-bird-cli/compare/v0.2.0...v0.3.0
