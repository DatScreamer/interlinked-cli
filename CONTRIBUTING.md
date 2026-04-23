# Contributing to interlinked-cli

Thanks for wanting to contribute. This project accepts issues, bug reports,
and pull requests via GitHub at
<https://github.com/QuentinCody/interlinked-cli>.

## Development setup

```bash
git clone https://github.com/QuentinCody/interlinked-cli.git
cd interlinked-cli
npm install
npm run build
npm test
```

Requirements:

- Node.js 22 or newer (`engines.node: ">=22.0.0"`)
- `npm` (or `pnpm`/`yarn` — the project is npm-first but the source tree
  is package-manager-agnostic)

## Running the CLI locally

Two modes:

```bash
# Dev mode — runs source directly via `tsx` (no build needed)
npm run dev -- <command>

# Built mode — uses dist/
npm run build && node dist/index.js <command>
```

## The harness

A lot of this codebase is the **local harness server** (`src/harness/`) —
it evaluates agent hook events, runs 77 built-in guard rules, performs
quality + structural checks post-edit, and coordinates file reservations.
Understanding the harness is easiest by reading, in order:

1. `docs/architecture.md` — high-level overview
2. `docs/harness.md` — harness architecture + lifecycle
3. `docs/generated/guard-rules.md` — auto-generated catalog of all 77 rules
4. `docs/generated/quality-checks.md` — post-edit check catalog
5. `docs/generated/structural-checks.md` — structural-analysis catalog

Regenerate the `docs/generated/*.md` files anytime with `npm run docs`.

## Tests

```bash
npm test                 # full suite via vitest
npm run test:watch       # watch mode
npx vitest run path/to/specific.test.ts   # single file
```

All new code should ship with tests. The harness itself enforces a
`files_without_test` rule — CI won't go green with unreferenced source.

## Typecheck

Two scripts:

```bash
npm run typecheck          # fast path via tsgo (Go-native preview)
npm run typecheck:stable   # tsc --noEmit (always available)
```

The `prepublishOnly` gate uses `typecheck:stable` so publishes don't depend
on the optional `@typescript/native-preview` being resolvable.

## Code style

- **Biome** for formatting + linting: `npx biome check --write .`
- **TypeScript strict mode** throughout; no `any` without a type guard
- **ESM-only** — `"type": "module"` in package.json, use `.js` extensions
  in relative imports per the ESM spec
- **No default exports** except at CLI entry points — default exports are
  grep-hostile

## Commit style

Conventional commits, matching the pattern in `git log`:

- `feat(scope): …` — new feature
- `fix(scope): …` — bug fix
- `refactor(scope): …` — code restructure, no behavior change
- `test(scope): …` — tests only
- `docs(scope): …` — documentation
- `chore: …` — build/tooling/dependency updates
- `ci: …` — CI/CD changes

## Pull requests

Before opening a PR:

1. Run `npm run typecheck:stable` — must be clean
2. Run `npm test` — must pass
3. Run `npx biome check .` — must be clean
4. If you touched hook-related code: run the CLI locally and exercise the
   affected command with `npm run dev -- <cmd>`

Describe in the PR body:

- **What** changed and **why**
- What you tested
- Any risk you're aware of (perf, compatibility, UX)

Small, focused PRs are much easier to review than large ones. If a change
spans many areas, consider splitting it.

## Release process

Releases publish straight from this repo. To cut a release:

1. Bump `version` in `package.json` (semver).
2. Add an entry to `CHANGELOG.md`.
3. Commit to `main` and push.
4. Create a matching `vX.Y.Z` tag — `publish.yml` runs on tag push and does the
   rest via npm OIDC trusted publishing (no long-lived `NPM_TOKEN`).

The tag-vs-`package.json` version check in `publish.yml` will fail the publish
if the two don't match, so keep them in sync before tagging.

## Reporting bugs

- **Non-security bugs**: open a GitHub issue with a reproduction and your
  environment (`node -v`, `npm -v`, OS).
- **Security issues**: see [SECURITY.md](./SECURITY.md) — do NOT open a
  public issue.

## Licensing

By submitting a PR you agree that your contribution is licensed under the
MIT license (see [LICENSE](./LICENSE)).
