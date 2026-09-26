# Releasing

Blue Bird ships compiled JavaScript (`dist/`, built by `tsc` at pack time), so a release is a version
bump, a changelog entry, a commit and a tag. The tag is what publishes.

## One-time setup

The package is published as **`@not.ayushthakur/blue-bird-cli`**. The unscoped name `blue-bird-cli` is
rejected by npm with `E403 Package name too similar to existing package bluebird-cli`, so the scope is
what makes the name publishable. Scopes require public access, which `publishConfig.access` in
`package.json` supplies.

1. `npm login` with an account that can publish `@not.ayushthakur/blue-bird-cli`.
2. The first publish claims the name:
   `npm publish --access public` (add `--otp=<code>` when the account enforces 2FA).
3. Connect GitHub Actions to npm. **Trusted publishing (recommended, no secret):** on npmjs.com open
   the package → *Settings* → *Trusted Publisher* → *GitHub Actions* and set
   owner `ayush-thakur02`, repository `blue-bird-cli`, workflow `release.yml`.
   Configurations created after 2026-09-03 default to staged publishing only — enable the direct
   `npm publish` action too, or the workflow's publish step is rejected.
   *Token alternative:* create a granular access token with **Bypass 2FA** checked and publish rights,
   add it as the repository secret `NPM_TOKEN`, then in `.github/workflows/release.yml` add
   `registry-url: https://registry.npmjs.org` to the `setup-node` step and
   `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the publish step.

## First release

The version in `package.json` is already the version you are shipping, so tag it as it is:

```bash
git add -A && git commit -m "feat: initial release"
npm run release -- 0.1.0 --dry-run     # shows the changelog promotion and the tag
npm run release -- 0.1.0
git push --follow-tags                 # the tag starts the release workflow
```

## Routine release

```bash
npm run release -- patch      # or minor / major / 0.4.0
git push --follow-tags
```

`npm run release` does the following, in order:

| Step | Detail |
| --- | --- |
| Guard | refuses a dirty working tree, a version that already exists as a tag, or a changelog that already has a section for the target version |
| Verify | `npm run verify` (typecheck + tests), skippable with `--no-verify` |
| Version | rewrites `package.json`, `src/version.ts` (`VERSION`) and `package-lock.json` together |
| Changelog | promotes `## [Unreleased]` to `## [<version>] - <date>`, opens a fresh Unreleased section, repoints the compare links. If Unreleased holds no entries, the section is generated from the commits since the last tag |
| Commit + tag | `chore(release): v<version>`, then an annotated tag `v<version>` |

Flags: `--dry-run` (print the plan, change nothing), `--push` (push branch and tag), `--publish`
(`npm publish` locally instead of letting CI do it), `--no-verify`, `--allow-dirty`.

Publishing locally first is fine: the release workflow checks the registry, skips `npm publish` when
the version is already there, and still creates the GitHub release. Both paths can be used in either
order.

## What the tag publishes

`.github/workflows/release.yml` runs on any `v*` tag, checks that the tag matches `package.json`,
runs the full verify, then publishes with `--access public --provenance` and creates a GitHub release
from the generated notes. Provenance attestations require the `id-token: write` permission the
workflow already declares.

## Manual fallback

```bash
npm run verify
npm version patch --no-git-tag-version      # package.json only
# edit src/version.ts and package-lock.json to the same version
# move the CHANGELOG Unreleased entries under the new version
git commit -am "chore(release): v0.1.1"
git tag -a v0.1.1 -m v0.1.1
npm publish --access public
git push --follow-tags
```

## Things that must stay in sync

- `version` in `package.json` — the source of truth
- `VERSION` in `src/version.ts` — what `bluebird --version` and the banner print
- `version` in `package-lock.json` (root and `packages[""].version`)
- the `v<version>` git tag — the release workflow refuses to publish when the tag disagrees
- `CHANGELOG.md` — one section per released version

`test/release.test.ts` asserts the first two agree and that the published file list still contains
`bin/`, `src/`, `docs/`, `LICENSE` and `CHANGELOG.md`, so a mis-tagged release fails in CI rather
than on the registry.

## Smoke test before pushing a tag

```bash
npm run verify
npm run build                             # tsc -p tsconfig.build.json
npm run pack:check                        # the exact file list npm would upload (bin, dist, docs …)
node dist/cli.js --version                # the entry point the tarball ships
node bin/bluebird.js --version            # the bin wrapper resolves dist/ then src/
npm link && bb --version && npm unlink -g @not.ayushthakur/blue-bird-cli
```

An installed copy must run from `dist/`: Node refuses to strip types from files inside `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is why 0.1.0 was unusable after
`npm install -g` and 0.1.1 added the build.

Published versions are immutable: if something is wrong, fix it, release the next patch, and
`npm deprecate @not.ayushthakur/blue-bird-cli@<version> "<reason>"` the bad one.
