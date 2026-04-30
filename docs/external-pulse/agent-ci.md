# Agent CI

- **Source:** https://github.com/redwoodjs/agent-ci • https://agent-ci.dev/ (homepage unreachable when fetched 2026-04-29; clone at `reference-repos/agent-ci`)
- **Encountered:** 2026-04-29, second worked example after CodeWiki
- **Verdict:** lane 4 (pattern) + half-day lane-3 spike (invoke-as-subprocess from `interlinked verify`). License gate restricts deeper adoption — see §2.

## 1. Core idea (one sentence, your words)

Agent CI runs unmodified GitHub Actions workflows on the developer's machine by emulating the GitHub.com server-side APIs (Twirp endpoints, Azure Block Blob, cache REST) so the same official `actions/runner` binary that runs jobs on GitHub.com runs them locally, with bind-mounted caches replacing the cloud cache and pause-on-failure containers replacing teardown-and-restart on a failed step.

## 2. Deterministic or agentic?

**Fully deterministic.** No LLM calls in the codebase. The "agent" angle is purely UX: an `AI_AGENT=1` env var (alias for `--quiet`) and a `--json` flag emitting NDJSON events tuned for agent consumption, plus pause-on-failure container lifecycle (the container is kept alive for fix-and-retry loops). The system itself is plain orchestration plus protocol emulation.

**License — hard gate.** FSL-1.1-MIT (Functional Source License, MIT Future License) — fair-source, converting to MIT after two years. Acceptable uses: invoke as a subprocess (we're a consumer), learn architectural patterns (uncopyrightable). Blocked uses today: forking the substrate code, building a paid product around equivalent capability. Re-evaluate after the FSL→MIT conversion date if substrate borrowing or paid reuse becomes interesting.

## 3. Substrate vs. surface

- **Surface:** CLI distributed as `@redwoodjs/agent-ci` (commands: `run`, `retry`, `abort`).
- **Substrate** (in `packages/`): `dtu-github-actions` is the cloud-API emulator (Twirp + Azure Block Blob + cache REST), `ts-runner` is the TypeScript runner integration, `cli` is the user-facing wrapper. Plus Docker bind-mount orchestration replacing GitHub's cloud cache, `tart` for Apple-Silicon macOS jobs, and an NDJSON event stream.

License blocks substrate borrowing. The remaining usable lever for us is invoke-as-subprocess.

## 4. Lane

**Lane 4 (pattern) primarily, with a thin lane-3 (invoke-as-subprocess) integration option.**

- Lane 4 — the *pattern* worth recording: "agent-consumable CI feedback with structured NDJSON events and pause-on-failure containers for fix-retry loops." Validates the interlinked thesis (deterministic feedback as the rate-limiter on agent code generation) at a layer below harness checks. File as a design touchstone for any future agency-cloud feature that wants CI-shaped feedback.
- Lane 3 — `interlinked verify` could optionally shell out to `npx @redwoodjs/agent-ci run --all --json --quiet`, parse the NDJSON, and surface failures alongside harness findings. License-clean (we're consuming the CLI, not embedding the substrate).

Not lane 5 (paid-product reuse). License blocks it for two years, and competing with GitHub Actions itself isn't on either paid-product roadmap.

## 5. Smallest spike

Half a day. Add an opt-in flag to `interlinked verify` (working name `--include-ci`) that:

1. Detects whether `npx agent-ci` is available; skips silently if not.
2. Detects whether Docker is running; skips silently if not (so non-Docker users aren't blocked).
3. Shells out to `npx @redwoodjs/agent-ci run --all --json --quiet` for the current branch.
4. Parses NDJSON events; surfaces failures in the existing `verify` output schema as a new section.
5. Advisory-only by default until a soak window confirms low FP rate.

Integration-only — no embedded code. If users find value, the flag becomes a sticky default in CI-using projects; otherwise it stays opt-in.

## 6. Artifact

Memory note + half-day spike PR (when prioritized).

## 7. Surface

- **interlinked-cli** — the spike (`verify --include-ci`).
- *Not* guardrails-cloud or agency-cloud as a packaged feature: license-blocked for two years, and competing with GitHub Actions isn't on either roadmap.

## Notes

- Architecture worth studying. Rather than re-implementing GitHub Actions (the `act` tool's approach), Agent CI emulates the **server-side API** the official runner talks to. Quote: *"It doesn't wrap or shim the runner: it **replaces the cloud API** that the official GitHub Actions Runner talks to, so the same runner binary that executes your jobs on GitHub.com executes them locally, bit-for-bit."* Useful precedent for "compatibility via API emulation, not behavior re-implementation."
- High-leverage substrate detail: bind-mount caching. `node_modules` / pnpm store / Playwright browsers / runner tool cache live on the host and are bind-mounted into the container — no upload, no download, no tar/untar. Replaces seconds of network round-trip with ~0 ms.
- `AI_AGENT=1` is identical in effect to `--quiet`. They explicitly designed for agent consumers — direct affirmation that the "structured output for agents" axis is real and product-relevant.
- Their `CLAUDE.md` is short, points at (a) one mandatory rule (`changeset-required.md`), and (b) a self-validation slash command (`/agent-ci-dev`) that wraps a background-monitor-retry workflow around their own CI. The "validate against your own CI before reporting work done" pattern is something interlinked-cli could mirror — specifically, a slash command that wraps the `interlinked verify` loop.
- The `dtu-github-actions` package is where the Twirp / Azure Block Blob / cache REST emulation lives. Worth a quick read if interlinked-cli ever wants to expose internal APIs in a runner-compatible shape — but not load-bearing for the spike.

## Methodology notes

- License check changed the verdict materially. A naive "what can we do with X?" pass would have suggested substrate borrowing; FSL-1.1-MIT makes that a hard no for two years. **Always check `LICENSE` before scoping a substrate-borrow eval** — adding this as a habit even though the rubric doesn't have a dedicated cell for it.
- Homepage `agent-ci.dev` was unreachable; the clone was load-bearing for the eval. If a project's homepage is the only source and it's down, an eval that skipped reading source would have been hollow.
