# How to use the Interlinked CLI

This page is a short router, not a manual. For the full picture, start with
the [README](../README.md) — this page only points you at the deeper docs.

The local harness (hooks, guard rules, activity log) is the product. An
Interlinked MCP Server is optional, for teams that want shared coordination.
You do not need one to use the CLI.

## Quickstart

The package is not published to npm. Install from source (Node.js 22+, macOS
or Linux):

```bash
git clone https://github.com/QuentinCody/interlinked-cli.git
cd interlinked-cli
npm ci
npm run build          # produces dist/index.js + dist/hook-entry.js
npm link               # exposes `interlinked` and `interlinked-hook` on PATH
```

Then, in the project you want to guard:

```bash
interlinked enable            # hooks + skills, auto-detecting every agent runner
interlinked harness start     # start the local guard server
interlinked status            # show what's configured
```

Restart or reload your agent so it picks up the new skills. `enable` is the
canonical onboarding command — see the README's *Which onboarding command do
I run?* section if you're deciding between `enable`, `setup`, and `init`.

## Where to go next

| Doc | Read this for |
|---|---|
| [`../README.md`](../README.md) | Value proposition, full quick start, day-to-day commands |
| [`harness.md`](./harness.md) | Harness architecture: guard evaluation, reservations, quality checks |
| [`command-reference.md`](./command-reference.md) | Every command and flag |
| [`generated/`](./generated/) | Auto-generated reference: guard rules, quality checks, structural checks, configuration |

Server-backed commands (`login`, `sync`, `tasks`, `inbox`) need an Interlinked
MCP Server URL. Point the CLI at one with `interlinked enable --server <url>`
or `interlinked login --server <url>`.
