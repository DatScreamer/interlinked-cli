# Sondera coding-agent-hooks — CI/CD pipeline + fixture smoke

- **Source:** https://github.com/sondera-ai/sondera-coding-agent-hooks (entry via commit a57a9e2, PR #11 "feature(copilot): add Copilot CLI hook example")
- **Encountered:** 2026-06-11, user-shared commit URL ("what CI/CD checks do they have; should we adapt any?")
- **Verdict:** compound — through the per-edit-harness lens (the real question, after a first CI-lens pass): every check class in their CI already has a shipped per-edit counterpart **except license policy**; adopt `license_policy` + two admission-time screens at `allowlist add`. Skip their release model; one already-ship validation for `registry-parity`.

## 1. Core idea (one sentence)

A 5-job GitHub Actions pipeline (lint / test / security / cross-target binary build / rolling GitHub release) for their Rust hook binaries, plus — in this commit — a checked-in per-event JSON fixture corpus and a smoke script that pipes each hook event through the real `sondera copilot` binary and asserts on the JSON decision envelope; the smoke is manual-only, not wired into CI.

## 2. Anatomy

- `.github/workflows/ci.yml` — the only workflow. `lint`: `cargo fmt --check` + `clippy --all-features -- -D warnings`. `test`: `cargo test --workspace`. `security`: cargo-deny (license allowlist of 15 permissive SPDX ids, advisories) + `cargo audit --deny warnings` with 4 RUSTSEC `--ignore` flags. `build-apps`: needs all three; fires on main push or `apps-v*` tag; x86_64-linux + aarch64-darwin matrix; builds 5 binaries, tars, uploads. `release-apps`: rolling mutable `latest` **prerelease updated on every main push**, versioned release on tags, `generate_release_notes: true`.
- Hygiene: `concurrency` group with `cancel-in-progress`; `workflow_dispatch`; top-level `permissions: contents: read` escalated to `write` only in the release job; per-job `Swatinem/rust-cache`.
- `deny.toml` — the license allowlist plus the **same 4 advisory ignores, with rationale comments**. The ci.yml cargo-audit flags duplicate those ids **without** rationale: two unpinned copies of one exception list, no drift detector.
- `examples/github_copilot_cli_hooks/` (this commit) — 8 fixtures (sessionStart → sessionEnd, incl. preToolUse allow/deny/rewrite, permissionRequest, postToolUseFailure) + `run_fixture_smoke.sh`: jq-patches `sessionId`/`cwd` into each fixture, runs the real binary per event, asserts decisions only behind `EXPECT_POLICY_DECISIONS` / `EXPECT_REWRITE` env gates (default **0** — by default the smoke checks exit codes only). Referenced by no workflow.
- No provenance/signing, no environment gating, no tag↔version consistency check on releases.

## 3. Deterministic or agentic?

Fully deterministic (toolchain + config). Apache-2.0 — no license bar. (The LLM lives in their product, not their CI.)

## 3b. Role in native architecture — does it transfer?

Their `security` job is the supply-chain boundary for a repo whose product is itself a security boundary — the same dogfood posture this repo holds (`project_maximal_local_enforcement`). Transfers directly, except our analog is running **our own gate** in CI (`interlinked verify`, `interlinked allowlist verify`), not bolting on third-party scanners.

## 4. Substrate vs. surface

Surface = GH Actions YAML; substrate = cargo-deny/cargo-audit (Rust-only, not borrowable). The borrowable part is the shape: security as a first-class required CI job, and fixture-corpus contract testing of hook envelopes.

## 5. Lane

4 (pattern: CI-as-enforcement-surface; fixture-corpus envelope contract) with a lane-2 sliver (license-allowlist check for npm as a harness detection technique).

## 6. Dependency & displacement

- **Deps:** none — workflow config + our own binary.
- **Displacement:** overlaps `interlinked verify` (gitleaks/semgrep/dep-audit already subsume cargo-audit's role), the package-allowlist (stronger than anything they have — fail-closed at edit time), and `registry-parity.ts` (their duplicated ignore list is its textbook case).
- **Equivalence, per-edit lens (their CI check → our harness surface):**
  - `cargo test --workspace` → per-edit coverage/red-bar/CRAP gates + budget-routing of big suites to the commit gate — **shipped, stronger** (selected-per-edit beats all-at-CI).
  - `cargo clippy --all-features -- -D warnings` → `cargo_clippy` quality check, enabled, `-D warnings`, .rs-scoped, 30s timeout (`rules/default-config-quality-checks.ts:160`) — **shipped**; only delta is `--all-features` (opt-in config tweak; compiles optional deps, budget risk).
  - `cargo fmt --check` → **absent** for Rust per-edit (biome covers TS) — tiny adopt: `rustfmt --check` warning on .rs edits.
  - `cargo audit` / cargo-deny advisories → `quality-checks/dependency-audit.ts`: PostToolUse keyed on manifest/lockfile edits, osv-scanner primary (all ecosystems, `--offline` supported), npm-audit/pip-audit/cargo-audit/govulncheck fallbacks — **shipped, broader**.
  - cargo-deny licenses → **absent everywhere** (no license logic in `package-allowlist.ts` / `allowlist.ts`) — the one genuinely missing check class.
  - cargo-deny sources/bans → package-install-guard blocks `--registry`/`--index-url` overrides + git/tarball/file specs unconditionally; manifest-edit-guard diffs dep entries — **shipped, stronger** (fail-closed allowlist vs. their warn-at-CI).
  - build-apps cross-target release build → tsc per-edit is the single-target analog; cross-target is not per-edit-feasible locally → Agent CI lane.
  - fixture smoke (the commit) → harness self-test, not a user-code check; our adapter tests + e2e probes are the counterpart. Not per-edit material.
- Release hardening (CI lens, for the record) — shipped, stronger (npm provenance + environment gate + tag↔version check; they have none).

## 7. Smallest spike

≤ 1 day, all on the supply-chain admission path (no new hook surface — extend the existing choke points):
1. **`license_policy`** — grow `AllowlistEntry` with a `license` field; `allowlist add` fetches the SPDX id from the registry (network is fine there: human-invoked command, same posture as the typosquat screen) and refuses non-allowlisted licenses unless `--force`; committed SPDX allowlist in `.interlinked/` (their deny.toml's 15-license shape is a good seed). Per-edit (manifest-edit-guard / PostToolUse) consumes only the recorded field — zero network on the hook path. Deterministic string matching throughout.
2. **Advisory screen at `allowlist add`** — run the already-shipped `resolveDependencyAuditCommand` machinery (or a single OSV query) against the candidate package at grant time; refuse-unless-`--force` on open advisories. Closes the approve-a-vulnerable-package hole the same way the typosquat detector closes approve-a-squat.
3. (Tiny, separable) `rustfmt --check` as a per-edit warning for .rs files.

Parked, larger: SessionStart ambient advisory refresh for stale approvals — dependency-audit only fires when a manifest/lockfile is *edited*, so a CVE published against an untouched allowlisted dep goes unflagged until the next dep edit; a background re-audit at SessionStart surfacing as a next-warning fits the cross-session moat in `docs/design/agent-era-checks.md`.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | `license_policy` + advisory-at-admission screens on the allowlist path; rustfmt per-edit | §7 | now |
| Agent CI (P4–5) | cross-target build verification; SessionStart ambient advisory refresh as a cloud-anchored sweep | loose | parked |

## 9. Artifact

This file + the §7 spike, **shipped 2026-06-11** (same session): `license-policy.ts` + `registry-metadata.ts` + the three-screen `allowlist add` + the manifest-edit-guard license warning + `rustfmt_check` + the `allowlist verify` exit-code fix. Side discovery while shipping: seven leaked `.cov-overlay-*` trees (~24 GB) had filled the disk — `sweepStaleOverlays` now reaps stale siblings on every overlay creation. **Skip for the harness:** their CI's test/clippy/audit/sources checks — all already shipped per-edit here, mostly in stronger form (the table in §6 is the receipt); the fixture smoke (self-test, not a user-code check); the release model entirely. **Already-ship validation:** their deny.toml/ci.yml duplicated ignore lists with no parity pin are exactly what `.interlinked/registry-parity.json` + the ci-pipeline-parity test prevent here — field evidence for the feature.

## Notes

- Why none of this lands on Stop: dep admission and manifest edits are discrete, rare events — the right gates are the existing PreToolUse choke points + the keyed PostToolUse audit. Stop stays for accumulating bundles (commit gate / verification nudges already cover their `needs: [test, lint, security]` ordering semantics).
- Independent CI-lens find, recorded so it isn't lost: `verifyAllowlistCommand` prints unapproved deps but never sets `process.exitCode` (`src/commands/allowlist.ts:219`) — not gateable by CI or scripts until fixed.
- The shared commit is the Copilot example, not CI config — its CI relevance is the (unwired) smoke script.
- Their smoke's assertions are env-gated off by default; a default run "passes" without checking a single decision. Coverage theater to avoid when adapting.
- `.claude/skills/` at their repo root — they dogfood Claude Code skills too.
- Architecture/product intake for Sondera lives in memory (`reference_sondera_architecture`, `reference_sondera_products_two_repos`); this file deliberately covers only the CI/CD + fixtures angle.
