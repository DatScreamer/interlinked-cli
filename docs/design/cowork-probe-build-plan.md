# Cowork Compatibility Probe — Build Plan & Session Handoff

**Purpose.** This doc lets a fresh session (or a teammate) pick up the Claude Cowork
work with full context. Read this first, then `docs/design/cowork-compatibility-probe.md`
(the design spec). It carries everything relevant: what's done, what's next, the
codebase lay-of-the-land, and the environment gotchas this session hit.

**Date:** 2026-05-18. **Branch:** `main`.

---

## 1. TL;DR — what to build next

Build the Cowork-independent core of `interlinked cowork-probe` — a tool that
empirically measures whether the interlinked harness works on Claude Cowork.
Three of its four parts need **no Cowork install** and are fully unit-testable now:

1. `src/lib/cowork-probe/spy-hook.ts` — the instrumented hook template + JSONL schema.
2. `src/lib/cowork-probe/analyzer.ts` — `analyzeProbeLog()`, a pure function: probe
   log → L0–L4 verdict.
3. `src/commands/cowork-probe.ts` — modes `install` / `report` / `clean` (pure file
   ops) + `drive` (needs a Cowork Mac, has a `--manual` fallback).
4. `src/lib/cowork-probe/driver-macos.ts` — the macOS Accessibility driver (the only
   part that needs a real Cowork install to validate).

Full file layout + the spy-hook sketch + the analyzer's L0–L4 logic are in
`docs/design/cowork-compatibility-probe.md` §6 and §9.

---

## 2. Session progress — what's done

This session continued the `79c3d11a` thread (itself a continuation). Two bodies of
work landed, all on `main`, all committed:

### 2a. B — installer hook-dedup (the harness over-registration fix) — DONE

The harness's hooks were registered ~3–4× per machine (2 hook implementations ×
2 config scopes), so every tool call was evaluated 3–4× — inflating the
`tdd_cycle_violation` / escalation counters. "A" (daemon-side event-dedup, shadow
mode) shipped earlier (`20de0cb`); the shared predicate shipped in `203f279`. This
session completed **"B"** — the installer refactor:

| Commit | What |
|---|---|
| `5ec7538` | `fix(harness)`: `ubs_hardcoded_localhost` exempts configurable localhost defaults. Was a `pre_block` rule false-positiving on the CLI's *documented* localhost defaults — hard-blocked the `enable`/`init` edits. Refined (not demoted): exempts `\|\|`/`??` fallbacks, `.includes()`/`===` tests, and `DEFAULT_`-named declarations. +5 tests. |
| `6e08108` | `feat(harness)`: idempotent installer. `installHooks` purges any prior Interlinked entry (legacy `.mjs` or adapter) before insert → a re-run converges to one hook per event per runner. Scope-aware (user-scope keeps other repos' hooks). `enable`/`init` re-pointed to the adapter installer. Legacy clean paths cross-recognize both hook shapes + iterate every event. +15 tests. |

**Verified:** 7137/7137 unit tests, `npm run typecheck` clean, all 5 e2e probes
(`.interlinked/e2e-*.mjs`) pass, harness rebuilt + restarted.

### 2b. Cowork thread — design docs committed

| Commit | What |
|---|---|
| `747cf01` | `docs`: `browser-testing-layer.md` — a behavioral-verification harness tier (was an untracked artifact from the 2026-05-17 Cowork discussion; committed so it isn't lost). The placeholder-data-for-Cowork enhancement is one tenant of it. |
| `cc48e13` | `docs`: `cowork-compatibility-probe.md` — the probe design (see §5 below). |

Memory `project_harness_hook_dedup.md` updated to "B shipped".

---

## 3. The Cowork question — full context

### Why this thread exists

The original ask (2026-05-17): *the interlinked harness works well with Claude
Code, but enterprises increasingly run Claude **Cowork** — does the harness work
there too, and could we add Cowork-specific logic* (the user's example: enhancing
the placeholder-data-in-UI indicator for Cowork's knowledge-work artifacts)?

That thread was investigated, then the 2026-05-17 session drifted into harness
false-positive cleanup and never returned. This session resumed it and the user
asked specifically: **figure out a way to automate testing/evaluation of Cowork**.

### The load-bearing unknown

The harness works on Claude Code because Claude Code provides: a local agent, local
file access, and **a hook surface it can block on**. Cowork provides the first two
(it is a local desktop agent). The unverified third — and *everything* forks on it:

> Does Claude Cowork (a) **execute** the `hooks` block in `.claude/settings.json` /
> `~/.claude/settings.json`, (b) **honor** a hook's `block` decision as a veto, and
> (c) fire hooks for **connector calls** (Gmail/Drive), not only file edits?

This cannot be answered from docs — Cowork is absent from the Claude Code hooks
reference. It must be **measured**.

### What is known about Cowork (2026-05, web-sourced)

| Fact | Implication |
|---|---|
| Cowork is a **local desktop agent** in the Claude Desktop app | No server-side harness rebuild needed; the Unix-socket daemon + local checks still apply |
| **No** Cowork CLI / headless / automation API exists | The probe's "drive" step can't be a subprocess — needs macOS UI automation |
| Cowork shares the `.claude/`-lineage config; hooks there are a **real surface** — CVE-2025-59536 was RCE via planted `.claude/settings.json` hooks | The harness's install target exists; hooks were *trust-gated* (Claude Code v1.0.111, Aug 2025), not removed |
| Enterprise controls are GUI toggles + `managed-settings.json` via MDM (non-overridable) | MDM `managed-settings.json` is a possible enterprise-policy rail if hooks fail |
| Observability is **OpenTelemetry only**; prompts/tool-names excluded by default; Cowork is **excluded from the Compliance API, Audit Logs, Data Exports** | The async-audit fallback rail is weak |

### The CVE framing (important)

CVE-2025-59536: RCE via hooks planted in `.claude/settings.json`, executed before
the trust dialog. Patched by **trust-gating** hook execution — not removing it. The
interlinked harness's PreToolUse hook is *structurally that exact exploit shape*. So:
(1) a freshly installed probe hook will not fire until the Cowork user accepts a
trust dialog; (2) Cowork hardening on any future update could sandbox or kill the
hook surface — **the probe's verdict is perishable and the probe must be repeatable
and build-stamped**.

---

## 4. The probe — the figured-out approach (summary)

You cannot CI-test what you cannot run headlessly. The solution: split the eval
into three layers that fail independently — two are pure code (build + test here,
no Cowork), one touches the real app.

- **Capture** — an instrumented *spy hook* registered for every event; logs every
  fire (event, payload shape, process tree, decision) to an append-only JSONL.
- **Drive** — macOS **Accessibility automation** (`osascript`) of the Claude Desktop
  app: open a Cowork task, paste a deterministic prompt, accept the trust dialog.
  Fallback: a 2-minute manual checklist (`drive --manual`).
- **Verdict** — a deterministic analyzer: JSONL → L0–L4 → `harness_compat` verdict.

**The decisive test — a filesystem-grounded canary.** A hook self-reporting "I
blocked" proves nothing. The spy hook returns `block` on the `PreToolUse` for
creating a sentinel file `COWORK-CANARY-SHOULD-NOT-EXIST.txt`; the verdict is
`existsSync(sentinel)` after the run — a fact, not a claim.

**L0–L4:** L0 process-tree (does Cowork shell to a Claude runtime), L1 do hooks
fire at all, L2 which events + payload shapes, L3 is `block` a veto (the canary),
L4 do hooks fire for connector calls.

**The verdict forks "how the harness works with Cowork":**

- hooks fire **+ block honored** → build the 6th `RunnerAdapter` (`cowork`); the
  probe's L2-captured payloads become the adapter's test fixtures.
- hooks fire **but no veto** → harness runs **observe-only** (PostToolUse feedback +
  logging work; can't gate).
- hooks **don't fire** → fallback rails: Skill-injected policy context, MCP-connector
  gating, OTel async audit.

---

## 5. Build plan — file by file

Build order (Cowork-independent core first; each lands test-covered):

1. **`src/lib/cowork-probe/analyzer.ts`** — `analyzeProbeLog(records, sentinelExists)
   → ProbeVerdict`. Pure function; the "evaluation brain". Define `ProbeRecord` and
   `ProbeVerdict` types here (or a sibling `types.ts`). L0–L4 logic is in
   `cowork-compatibility-probe.md` §4.3.
2. **`src/lib/cowork-probe/__tests__/analyzer.test.ts`** — synthetic logs for every
   L0–L4 outcome and all three `harness_compat` verdicts. ≥3 cases per branch.
3. **`src/lib/cowork-probe/spy-hook.ts`** — the instrumented-hook script template
   (self-contained, zero CLI imports — like the real generated `.mjs`) + the JSONL
   record schema (shared type with the analyzer). Sketch in design doc §4.1.
4. **`src/commands/cowork-probe.ts`** — modes:
   - `install` — write the spy hook, register it for every event in
     `.claude/settings.json` + `~/.claude/settings.json`. **Reuse `installHooks`
     from `src/harness/installer.ts`** — B just made it idempotent, so a re-run
     never stacks duplicate spy hooks.
   - `report [--json]` — run the analyzer over the log + sentinel check.
   - `clean` — remove the spy hook everywhere; delete the log.
   - `drive [--manual]` — see step 6.
5. Register `cowork-probe` in **`src/index.ts`** (commander command registration).
6. **`src/lib/cowork-probe/driver-macos.ts`** — the AppleScript / Accessibility
   driver + the `--manual` checklist text. Needs a Cowork Mac to validate; the
   `--manual` path is the always-available fallback.

After a real verdict exists: build the `cowork` `RunnerAdapter` (design doc §7) if
the verdict is `adapter` or `observe-only`.

**Verifiable with no Cowork machine:** steps 1–5 (and the `--manual` text of 6).
**Needs a Cowork Mac:** validating the macOS driver, and of course running the
actual probe to get a verdict.

---

## 6. Codebase orientation (for a fresh session)

- **Runner adapters** — `src/harness/adapters/`: the `RunnerAdapter` contract is in
  `types.ts`; five adapters exist (claude-code, copilot-cli, cursor, gemini-cli,
  codex). A `cowork` adapter would be the sixth, same shape.
- **Installer** — `src/harness/installer.ts`: `installHooks()` writes hook fragments
  to runner settings files, manifest-tracked, **idempotent** (B's work). The probe's
  `install` mode should reuse this rather than hand-rolling file writes.
- **Hook ownership** — `src/lib/hook-ownership.ts`: `isInterlinkedHookCommand` /
  `isInterlinkedHookEntry` / `isProjectOwnedHookEntry` — the shared predicates for
  recognizing Interlinked hooks in a settings file.
- **Adding a CLI command** — new file in `src/commands/`, registered via `commander`
  in `src/index.ts`.
- **Tests** — vitest; test files `*.test.ts` next to the source or in `__tests__/`.
  Heavy `vi.mock()` of fs/network. New source files: the harness enforces TDD —
  write the test alongside.
- `CLAUDE.md` is the source of truth for repo structure and commands.

---

## 7. Environment & harness gotchas (this session hit all of these)

- **`interlinked` is a `~/.local/bin` symlink** → `dist/index.js` (deliberately not
  `npm link` — see memory `project_interlinked_install_symlink`). Safest to invoke
  as `node dist/index.js <cmd>`.
- **Build + restart after harness-affecting edits:** `npm run build && node
  dist/index.js harness restart`. The daemon caches compiled check code — a change
  to a `src/harness/checks/*.ts` file does NOT take effect until rebuild + restart.
- **The tsc diff-overlay blocks interdependent edits.** Adding an import in one
  `Edit` and using it in another trips the overlay (unused import) or the unresolved
  name. There is no `MultiEdit` here. For a file needing a new import + uses: either
  `Write` the whole file, or apply the change atomically via a throwaway in-repo
  `node` script doing precise string replacements (this session used that twice).
  Writes outside the repo root are blocked — keep scratch scripts in-repo.
- **The harness dogfoods every edit** — PostToolUse runs tsc/biome/secrets + ~100
  checks. Advisory `[heuristic]` findings are noisy; `[proven]` ones block. Much of
  the noise this session was the 3–4× escalation artifact of the very bug B fixed.
- **e2e probes** — `node .interlinked/e2e-{protocol-probe,protocol-suite,stability,
  hook-script,cold-fallback}.mjs` — the regression check after any harness change.
- **Live cleanup still pending:** this machine's `.claude/settings.json` +
  `~/.claude/settings.json` still hold the *old* double-registration. A re-run of
  `interlinked enable` now converges the project file (purge-then-insert); user
  scope needs `interlinked install-hooks --scope user` or `uninstall-hooks`. Not
  done automatically — it rewrites the committed `.claude/settings.json`.

### Deferred dogfood false positives (advisory, noticed during B, not fixed)

Worth a cleanup pass — all advisory, none blocking:

- `ubs_string_concat_in_loop` fires on numeric `+=` (e.g. `purged += n`) — it
  cannot tell a number from a string.
- `broad_object_types` fires on the safe `Record<string, unknown>` (the
  unknown-valued form), not just `Record<K, any>`.
- `software_version_regression` misread two clients' event counts ("13 events" /
  "8 events" on adjacent lines) as a version downgrade.
- `test_missing_sut_import` over-fires on behavior-named test files (a test named
  for a feature, e.g. `installer-idempotency.test.ts`, not a single module).

---

## 8. Open questions for the user

1. **Cowork access** — is there a Mac with Claude Cowork available to run the
   probe's `drive` step and validate the macOS driver? If not, the probe still
   ships (the `--manual` checklist + the Cowork-independent core), but the macOS
   driver can't be verified and no real verdict can be produced yet.
2. **`cowork` adapter timing** — build it speculatively now (betting Cowork honors
   hooks like Claude Code Desktop), or wait for the probe verdict? The design doc
   recommends waiting — the probe's captured payloads are the adapter's fixtures.
3. **Scope of the Cowork-specific harness logic** — the original ask included
   *enhancing* the placeholder-data indicator for Cowork. That is the
   `browser-testing-layer.md` thread (its Mode C tenant). Separate build; flag if
   it should be sequenced with the probe.

---

## 9. Pointers

- **Design spec:** `docs/design/cowork-compatibility-probe.md` (the full probe design).
- **Companion:** `docs/design/browser-testing-layer.md` (behavioral-verification tier).
- **Memories** (auto-loaded): `project_harness_hook_dedup.md` (B, shipped),
  `project_interlinked_install_symlink.md` (the `interlinked` symlink).
- **Key source:** `src/harness/adapters/` (the adapter contract),
  `src/harness/installer.ts` (idempotent install, reuse for the probe's `install`),
  `src/lib/hook-ownership.ts` (hook predicates).
- **Web sources used** (Cowork facts):
  [Cowork enterprise help](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans),
  [Repello Cowork security guide](https://repello.ai/blog/claude-cowork-security),
  [CVE-2025-59536 (Check Point)](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/).

### How to start the new session

> Read `docs/design/cowork-probe-build-plan.md` and `docs/design/cowork-compatibility-probe.md`,
> then build the Cowork-independent core of `interlinked cowork-probe` per §5 of the
> build plan — analyzer first (test-covered), then the spy hook, then the
> `install`/`report`/`clean` command modes. Stop before the macOS driver if no
> Cowork Mac is available.
