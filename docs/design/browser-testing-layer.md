# Browser-based testing in the harness hook system

**Status:** Design — not yet built. The body below is the corrected design; a
2026-05-17 review caught four design issues and several smaller ones and
prompted the explicit local/remote execution tiering (§3.2) — all folded in
here and itemized in §15.

**Origin:** 2026-05-17 design conversation.

**Companion:** `placeholder-data-runtime-tier.md` specifies one *tenant* of this
layer (Mode C, §7). That memo is not yet in the repo; this layer is its
provider and does not block on it.

---

The harness verifies agent-written code three ways today — guard rules (is it
safe), quality checks (does it compile), structural checks (does it cohere) —
all over *source text, the file on disk, or the project graph*. None answers
the question a user actually cares about: **does the thing work when it runs.**
This memo plans a browser-based testing layer that closes that gap by driving
the running app, woven into the existing hook pipeline so verification is
automatic rather than something the agent must remember to do. It is a
**general** layer; the placeholder-data runtime check is one tenant of it, not
its purpose.

## 1. The missing tier — behavioral verification

The harness has four verification families. Three exist; the fourth is this:

| Family | Source of truth | Answers | Where |
|---|---|---|---|
| Guard rules | command / proposed content | *is it safe* | `rules-loader.ts`, PreToolUse |
| Quality checks | file on disk, via external tools | *does it compile / lint* | `quality-checks.ts`, PostToolUse |
| Structural checks | project import graph | *does it cohere* | `structural-checks.ts`, PostToolUse |
| **Behavioral (this memo)** | **the running app** | **does it work** | **async, PostToolUse → Stop** |

The harness already *observes* the behavioral gap and cannot *close* it.
`session-state.ts` records a `browser` verification signal whenever the agent
drives a browser — `mcp__playwright__browser_*` / `mcp__chrome-devtools__*`
tools, and (since the 2026-05 agentic-engineering-patterns work) the `rodney`,
`agent-browser`, and `playwright`-CLI commands too — and a `dev-server` signal
on `vite` / `next dev` / `wrangler dev` / `python -m http.server` / `uvicorn` /
`flask run`. `verification-stop-checks.ts::formatUiNotInteractedWarning` then
nags at Stop when UI files were edited but neither signal fired. That is the
harness saying *"you didn't check this"* — with no ability to check it itself.

Browser testing is the behavioral tier: instead of nagging, the harness drives
the running app and reads ground truth — the rendered DOM, the console, the
network, uncaught exceptions, navigation. The payoff is the hook loop: a
failure found this way surfaces as an `[interlinked:browser]` warning on the
agent's *next* tool call, so the agent self-corrects mid-session without a
human ever running the page.

## 2. Where it sits in the harness architecture

- **Check pipeline.** PreToolUse (`evaluator/pre-tool.ts`) runs guard rules and
  `pre_block` / `pre_warn` registry checks; PostToolUse (`evaluator/post-tool.ts`)
  runs quality + structural + `post`-phase registry checks; Stop (`server.ts`)
  runs the reflection nudges (`commit-cadence.ts`, `verification-stop-checks.ts`).
  The browser layer adds no synchronous work to any of these — it `submit`s at
  PostToolUse, `consume`s at PreToolUse, `drain`s at Stop (§4).
- **Check kind.** Browser checks are **tool-based checks**, the family that
  wraps an external verifier (tsc, biome, cargo) — *not* inline `CHECK_REGISTRY`
  entries. The registry's contract is a synchronous `fn: (content, filePath) =>
  InlineMatch[]`; a browser run is asynchronous and yields `CheckResultEntry[]`.
  So a browser check registers in the tool-based family and its id goes in
  `PROVEN_TOOL_CHECKS` (`quality-checks/instructions.ts`), not in
  `check-registry/`.
- **Determinism tag.** Every finding carries `[proven]` or `[heuristic]`
  (`quality-checks.ts::classifyDeterminism`). A smoke run or a spec *executed
  the app*, so its findings are `fully_deterministic` → `[proven]` — the
  strongest evidence class the harness issues, a strict upgrade over the
  static, `[heuristic]` `placeholder_data_in_ui`.
- **Execution tiers.** The browser itself runs locally (default) or remote
  (opt-in) — a deliberate two-tier model, not a flat backend toggle. See §3.2.
- **`interlinked verify`.** The two-tier gate (default high-signal +
  `--all-checks`). Mode A smoke graduates to the default gate once its
  false-positive rate is known; spec / flaky tiers sit in
  `DEFAULT_ADVISORY_SKIPS` (`commands/verify/advisory.ts`) — the same
  advisory→default ratchet every other check family uses.
- **Config.** The two-tier config system: `.interlinked/guard-rules.json`
  (team, committed) + `.interlinked/guard-rules.local.json` (personal). The
  `browser_checks` block (§10) lives there, default-off.
- **Runtime dir.** Findings persist to `.interlinked/pending-async-findings.json`,
  alongside the trigram index, session trajectories, and reservation events.
- **Recurrence.** A browser failure that recurs flows into
  `interlinked recurrence` as a `harness_caught` row and is subject to the same
  advisory→default→block ratchet.
- **Two hook implementations.** Browser testing is **daemon-side only** — the
  zero-dependency inline `.mjs` cold-fallback cannot drive a browser. When the
  daemon is down there is no browser testing; that is acceptable (fail-open,
  non-safety) and consistent with the harness's posture.

## 3. The constraints that shape execution

Two constraints decide *how* and *where* browser work runs: hooks are fast and
a browser run is slow (§3.1), and the app under test lives on `localhost`
(§3.2). The first dictates that a browser never runs synchronously inside a
hook; the second dictates a two-tier local/remote execution model.

### 3.1 Slow work, fast hooks

A browser run is 1–30 s. Hooks are fast. The budgets (`docs/harness.md`,
`docs/design/stop-event-checks.md`):

| Hook | Latency budget | Browser work that fits |
|---|---|---|
| PreToolUse | <10 ms ideal, <500 ms hard | **None.** Classify / route / inject prior results only |
| PostToolUse | async — agent keeps working, sees stderr next turn | **Schedule only**, never await |
| Stop / SubagentStop | forgiving — hundreds of ms, shell-outs OK | Drain in-flight work, surface the verdict |

Conclusion: **the layer never runs a browser synchronously inside a hook.** A
browser run is started in one hook and its result is read in a later one.

### 3.2 The localhost barrier — and the two execution tiers

A cloud browser navigating to `http://localhost:5173` reaches *its own*
localhost, not the developer's machine. So remote browser testing of local
work is, unavoidably, one of: a tunnel exposing the dev server (latency, a
dependency, a security-surface decision); testing an already-deployed,
publicly-reachable preview URL; or a *local* browser. There is no fourth
option short of relocating the dev environment itself into the cloud.

That barrier — together with the fast-local / deliberate-cloud seam the harness
already runs along (`feedback_deliberate_prepost_latency`) — makes the
execution model **two explicit tiers**, not a flat backend choice:

**Tier 1 — local floor (default, free, the inner-loop engine).** A
`playwright_local` headless browser the daemon owns. This runs the §6
PostToolUse→PreToolUse self-correction loop. It *must* be local: the code under
test is on `localhost`, the loop's entire value is speed, and it has to keep
working offline. It is free — Playwright is open source — and high-frequency (a
render per UI-edit burst). Tier 1 is what makes the layer real; it is active
whenever `browser_checks.enabled`.

**Tier 2 — remote premium (opt-in, metered).** Cloudflare Browser Rendering
reached through the Interlinked MCP Worker — binding-native, no API key, billed
over the CLI↔Worker relationship that already exists (the same shape as the
planned Worker-proxied inference, `project_classifier_inference`). Tier 2's job
is the work Tier 1 structurally cannot or should not do: **deployed-preview
verification** (pre-push / `/review` / CI — the URL is already public, so no
tunnel; low-frequency, so metering is cheap and priceable; higher-stakes) and
**zero-local-setup offload** (no `playwright install`, no 300–500 MB resident
Chromium — §9.6).

| Job | Cadence | Tier | Why |
|---|---|---|---|
| Inner loop — §6 self-correction | per UI-edit burst | **1 — local** | localhost; latency-critical; must work offline; metering a per-burst render would be costly |
| Deployed-preview / pre-push / CI | occasional | **2 — remote** | URL already public (no tunnel); low frequency (cheap to meter); the higher-stakes gate |

**The product line follows from this, and is worth stating plainly.** A remote
browser is a *commodity* — Cloudflare Browser Rendering and Browserbase both
sell it. The product is the **harness orchestration**: the right checks at the
right moment, woven into the agent loop, the agent self-correcting on its next
tool call. Tier 2 is the *delivery and monetization* of the premium slice
(zero-setup, preview/CI coverage, metered browser-minutes through the Worker) —
it is not the product by itself. Because the CLI is offline-first, Tier 2 is
naturally an opt-in upgrade over the free Tier 1 floor, with no architectural
friction: the plumbing (CLI→Worker auth, the Worker, metered capabilities) all
exists.

**Deliberately not done:** routing the high-frequency inner loop through a
remote browser. The localhost barrier, per-burst metering cost, and tunnel
latency all fight it; forcing it means a tunnel — friction, a security
decision, and slower than local. The inner loop stays Tier 1 (§13).

**The horizon where the split dissolves:** if the agent's dev environment is
itself cloud-hosted — its dev loop running in a Cloudflare Sandbox — there is
no localhost barrier, the browser is native to that environment, and Tier 1 vs
Tier 2 collapses. A real direction, but it relocates *where developers work*,
not just where the browser runs; treat it as a separate bet, not part of this
layer.

## 4. Execution substrate — reuse `async-analysis.ts`

The harness already solved "expensive PostToolUse work that can't block": the
async-analysis manager (`src/harness/async-analysis.ts`,
`createAsyncAnalysisManager`) runs structural / impact checks in the
background. Its API is the shape a browser test needs:

- `submit(jobKey, analysisFn)` — schedule slow work returning
  `Promise<CheckResultEntry[]>`.
- `consume(jobKey)` — read + clear findings. Called on a later PreToolUse
  (`asyncAnalysis.consume(...)` in the PreToolUse path of `server.ts`), which
  injects them as `[interlinked:async] …` warnings. The browser layer adds an
  `[interlinked:browser]` channel the same way.
- `drain(timeoutMs)` — await in-flight work; already called in the `server.ts`
  Stop branch with `ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS` (currently `5_000`).
- Findings persist to `.interlinked/pending-async-findings.json`, keyed by job,
  so a result survives across hook processes — and across sessions if drain
  times out.

This is the **"between tool calls"** execution window: a browser run started at
PostToolUse on tool call *N* completes in the gap and reports on a later
PreToolUse — *N+1* if the run is short, later if not (§9.3 staleness).

### 4.1 Coalescing — submit a route *set*, not a file

`async-analysis.ts` has exactly **one stash slot**: while a job runs, a new
`submit` overwrites `pendingRequest`, *discarding any previously stashed one*.
For repeated edits to one file that is correct — free debounce. For a burst
across *different* files (the normal case: component + its CSS + parent + a
hook) a naïve per-file submit would run the first and the last and **silently
drop the middle** — those routes would never be tested.

The fix needs no change to `async-analysis.ts`. The browser orchestrator owns a
`Set` of **dirty routes** and submits under a single stable job key
(e.g. `"browser:<cohort>"`); the `analysisFn` closes over the *current*
accumulated set:

```
PostToolUse(edit A) → dirtyRoutes ∪= routesFor(A) → submit("browser", render(dirtyRoutes))
PostToolUse(edit B) → dirtyRoutes ∪= routesFor(B) → submit("browser", render(dirtyRoutes))   // coalesced
PostToolUse(edit C) → dirtyRoutes ∪= routesFor(C) → submit("browser", render(dirtyRoutes))   // coalesced
                                                     ⇒ one run, over {A,B,C}'s routes
```

Coalescing then collapses correctly: the final stashed `analysisFn` closes over
the fullest set, so the run after the burst covers every route touched. The
debounce benefit is kept; no route is lost. Routes a completed run covered are
cleared from the set.

### 4.2 A browser-dedicated manager instance

`createAsyncAnalysisManager` is a factory. The browser layer takes its **own
instance** — its own slot and stash, separate from the structural/impact
manager. This is the "second slot" §9.7 calls for: a slow browser job can no
longer starve fast structural analysis, and vice versa, and §4.1's single-key
discipline keeps browser-vs-browser correct *within* that instance.

## 5. Architecture

```
 PostToolUse (UI edit) ──submit()──▶ browser AsyncAnalysisManager  (own slot, §4.2)
                                          │
                                          ▼
                              Browser Test Orchestrator  (src/harness/browser-checks/)
                                          │  dirty-route set → verify spec (§7)
                                          ▼
                              Browser Runtime  ── Tier 1: warm headless browser the daemon owns
                                          │       Tier 2: Cloudflare Browser Rendering via the Worker
                                          │       (Tier 1 mirrors content-scanner/sidecar-manager.ts:
                                          ▼        idle → spawning → ready → dormant → disabled,
                                          │        bounded restartCount, fail-open, per-call AbortSignal)
                              CheckResultEntry[]  ──▶ pending-async-findings.json
                                          │
 PreToolUse (next call) ──consume()──────▶├──▶ [interlinked:browser] warnings  (agent self-corrects)
 Stop ───────────────────drain()─────────┘──▶ end-of-turn verdict
```

Four new pieces, each modeled on something that already exists:

| Component | Modeled on | Role |
|---|---|---|
| **Browser runtime** (`browser-runtime.ts`) | `content-scanner/sidecar-manager.ts` | Tier 1: one warm headless browser the daemon owns — lazy-spawn on first job; the same five-state lifecycle (`idle` / `spawning` / `ready` / `dormant` / `disabled`); `idle_shutdown_ms`; bounded `restartCount`; per-call `AbortSignal`; fail-open. Tier 2: the same interface, satisfied by a Worker call (§3.2) |
| **Orchestrator** (`browser-checks/`) | `quality-checks.ts` tool-runners | Accumulate dirty routes (§4.1); turn a verify spec into navigation + assertions; return `CheckResultEntry[]` |
| **Scheduler glue** | `async-analysis.ts` (own instance, §4.2) | submit at PostToolUse, consume at PreToolUse, drain at Stop |
| **Config** | `content_scanner` block | `browser_checks` in `guard-rules.json`, default-off |

The Tier 1 browser runtime mirrors the sidecar manager's *lifecycle*, but the
managed process is a headless Chromium (driven by Playwright), not the Python
OPF sidecar. The `SidecarLifecycleState` machine and the fail-open posture
transfer directly. Tier 2 presents the *same orchestrator-facing interface* —
"render these routes, run these assertions, return `CheckResultEntry[]`" — so
the tier is a backend choice the orchestrator is agnostic to.

## 6. The hook-point matrix

| Event | Browser-layer action | Blocks? |
|---|---|---|
| `SessionStart` | Load `browser_checks` config; detect a running dev server (port sniff + `dev-server` signal). Do **not** spawn a browser yet | no |
| `PreToolUse` | (a) `consume()` pending findings → `[interlinked:browser]` warnings; (b) optional commit gate (§6.3) | no (warn) |
| `PostToolUse` (`Edit\|Write\|MultiEdit`) | If a UI-relevant file changed, add its route(s) to the dirty set and `submit()` (§4.1). Returns instantly | no |
| `PostToolUseFailure` | Abort the in-flight run's `AbortSignal` if its target file's edit just failed (nothing to verify). No new manager API needed — the runtime takes an `AbortSignal` like the sidecar (§5) | no |
| `Stop` / `SubagentStop` | `drain()` in-flight work; surface results as the end-of-turn verdict | no (warn) |
| `TaskCompleted` | Run a task-scoped full pass (all declared specs, not just diff-affected) | no |
| `SubagentStart` / `TeammateIdle` | Tag jobs by agent/session; one warm browser per developer cohort | n/a |
| `PreCompact` / `Notification` | none | n/a |

Note: `playwright test` / `cypress run` *Bash* commands are already (or, for
cypress, trivially) classified as a `browser` verification signal by
`classifyVerificationCommand` — so an agent that runs its own E2E suite is
visible to the layer, which can then skip a redundant harness run.

Three events carry the design:

**6.1 PostToolUse — the trigger.** The PostToolUse hook is matcher-scoped to
`Edit|Write|MultiEdit`. On each, if the written path is UI-relevant (§9.2),
add its route(s) to the dirty set and `submit()`. The agent never waits.

**6.2 PreToolUse — the report.** Never runs a browser. It `consume()`s findings
from prior jobs and injects them as warnings — identical to the existing
async-findings injection. This is where the agent learns *"the page you edited
two calls ago throws `TypeError: cannot read 'map' of undefined`"* and fixes it
inside the same session.

**6.3 PreToolUse gate (opt-in).** When a job is **red** and the agent runs
`git commit`, the layer can mirror the existing TDD commit gate in
`behavioral-checks.ts` — surface the failing browser result before the commit.
Default warn, never block (browser failures are warn-class — §9.3); a project
may opt into `ask`.

**6.4 Stop — the verdict.** `drain()` lets in-flight work finish, then the
result is the authoritative end-of-turn statement. `formatUiNotInteractedWarning`
stops *nagging* and starts *reporting* — but only when the layer is enabled
(see §12).

## 7. What gets tested — three modes

- **Mode A — smoke (zero-config, default).** No author input. Load the route(s)
  for changed UI files; assert: page reaches `load`, HTTP 2xx, no uncaught
  exception, no error-boundary text, a root selector present, and *no new*
  `console.error` (see §8.3 — diff-relative, not an absolute budget). This is
  what makes the layer automatic — it works on a project with no tests.
- **Mode B — declared specs.** The project ships Playwright / Cypress specs;
  the layer runs the subset affected by the changed files (mapped via
  `project-graph.ts`). The harness becomes the *scheduler* for the project's
  own E2E suite — the right specs at the right moment, without the agent
  remembering to invoke them.
- **Mode C — tenant checks.** Other harness subsystems register browser-backed
  assertions through a small API. `placeholder_data_in_rendered_ui` (companion
  memo) is the first tenant: it asks the orchestrator to load a page and
  reports back `window.__INTERLINKED_DEMO__` / `[data-interlinked-demo-banner]`
  state. The layer is the *provider* of browser-runtime access; tenants own
  their assertions.

## 8. Verdict model — determinism, gating, diff-awareness

A browser finding is a `CheckResultEntry` and rides the same path as every
other check. Because a smoke run or a spec *executed the app*, its findings are
`fully_deterministic` → `[proven]` (§2). Register the browser checks as
tool-based checks and add their ids to `PROVEN_TOOL_CHECKS`.

Gating mirrors the rest of the system: Mode A smoke → default gate once its
false-positive rate is known; Mode B specs follow the project's own pass/fail;
flaky or new specs sit in `DEFAULT_ADVISORY_SKIPS` until proven.

### 8.3 Diff-awareness for *runtime* behavior

"Only surface a failure attributable to *this session's* edits" is cheap for
source-text checks (compare to git) and **not** cheap for a runtime check — the
page is broken *now*; was it broken before? There is no baseline render in this
architecture, and adding one (render the pre-edit app) is expensive and
awkward. Two honest mechanisms instead of a baseline:

- **Uncaught exceptions — attribute by stack origin.** An uncaught exception
  carries a stack. If the throwing frame resolves to a file in
  `session.files_written`, it is the agent's; if it resolves elsewhere, it is
  pre-existing and is suppressed. No baseline render needed. This is the
  primary, high-signal Mode A assertion.
- **`console.error` — count *new* lines, not all of them.** Real apps and
  third-party libraries emit handled `console.error`s constantly; an absolute
  budget of 0 would fire on nearly every page and make Mode A — the layer's
  whole differentiator — noisy on day one. Without a baseline render the only
  honest options are: (a) attribute by stack origin, same as exceptions, where
  the error carries a usable stack; (b) where it does not, treat the
  `console.error` assertion as **advisory-tier**, not default-gate, until a
  baseline-render mechanism exists. Do **not** ship an absolute `console.error`
  budget on the default gate.

## 9. Hard problems

**9.1 Dev-server lifecycle.** A browser test needs a running app. Order of
preference: (a) reuse the agent's own dev server — the harness already knows
one is up from the `dev-server` verification signal, plus a port sniff;
(b) if none, the daemon lazy-starts one it owns (`npm run dev`), idle-shut with
the browser; (c) build + `vite preview` for SSG/Workers targets. Never fight
the agent for its port. A run must also confirm the dev server has *picked up*
the change (HMR settled) before asserting — otherwise it tests stale or
mid-compile state. (Tier 2 reaches a public preview URL instead — §3.2 — and
sidesteps the localhost dev-server question entirely.)

**9.2 Route discovery.** Which URL renders the changed file? Layered: framework
route conventions (Next `app/`/`pages/`, Vite/React-Router, Astro `pages/`) →
a `project-graph.ts` import-graph walk from the changed component up to the
nearest route module → a `// @route: /path` override directive. This is the
fuzziest part; start convention-only and widen. **When discovery fails, emit a
`route-not-located` finding — do not silently fall back to loading `/`.** A
green run that tested the wrong page (the change was never exercised) is worse
than an honest "couldn't locate the route for this file."

**9.3 Staleness.** A 1–30 s run started at call *N* reports whenever it
finishes — possibly *N+3*, by which point the rendered code is gone.
`pending-async-findings.json` records `produced_at` but `consume()` returns
findings unconditionally. Two guards, both in the browser layer (no
`async-analysis.ts` change):
- *Intra-session:* each browser `CheckResultEntry` records the content hash of
  the file(s) it rendered. On `consume`, the orchestrator drops a finding whose
  target file has changed since. A run that completes *after* being superseded
  by a newer submit discards its result rather than persisting it.
- *Cross-session:* a freshness TTL — a browser result older than the TTL is
  dropped rather than shown out of context on a later session.

**9.4 Flakiness.** Browser tests flake; a flaky result must never *block*.
Retry-once on failure; quarantine a spec after N pass/fail flips; report
warn-class until a spec is stable — the same advisory→default ratchet the check
system already uses.

**9.5 Agent-agnostic.** Works for Claude Code and Gemini directly. Codex has
only post-execution hooks — but the model still holds: findings persist to
`pending-async-findings.json`, so a job submitted late surfaces on the next
session's first PreToolUse. No PreToolUse blocking is lost because the layer
never blocks there anyway.

**9.6 Cost & resources.** A Tier 1 warm Chromium ≈ 300–500 MB resident — freed
by `idle_shutdown_ms` between bursts; this is a real footprint jump over
today's lightweight `node:net` daemon, so the fail-open path must be airtight.
(Tier 2 — §3.2 — eliminates this local footprint; that zero-setup property is
one of its selling points.) Coalescing + route-scoping + smoke-grade
assertions keep a warm run sub-5 s. Backend / tier selection is §3.2; the
config selector is §10.

Driving the app runs agent-written code — but the app is already running
anyway; the browser adds no new trust boundary. *Egress, though, is in tension
with Mode A:* a strict default-deny on external `fetch`/XHR would make an app
that legitimately pulls a real or staging API render its error state, so the
smoke test would false-fail. Resolution: allow-list the project's own API
origin(s) by default; offer a stricter deny-all only as an opt-in mode. The
harness side stays fail-open regardless: a crashed browser runtime returns zero
findings and never wedges the agent.

**9.7 The `async-analysis.ts` single slot.** One global slot is shared by all
submitters. §4.2's browser-dedicated manager instance resolves browser-vs-
structural contention; §4.1's single-key route-accumulation resolves browser-
vs-browser. The remaining limit is the Stop `drain()` budget — currently the
literal `ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000` in `server.ts`. A cold
browser run exceeds it. Mitigations: keep the browser warm (warm runs fit);
pass a larger budget for browser jobs specifically; and rely on disk-persisted
findings — a result that misses the drain window still surfaces on the next
session's first PreToolUse, subject to the §9.3 TTL.

## 10. Configuration

A `browser_checks` block in `guard-rules.json` (team) + `.local.json`
(personal), **default-off**, mirroring `content_scanner`'s ergonomics:

```jsonc
"browser_checks": {
  "enabled": false,
  "mode": "smoke",                 // "smoke" | "specs" | "both" | "off"
  "backend": "playwright_local",   // Tier 1 (§3.2); "cloudflare_browser_rendering" = Tier 2
  "dev_server": "auto",            // "auto" | "<command>" | "<url>"   (Tier 1 only)
  "api_egress": "project_origins", // "project_origins" | "deny_all" | "allow_all"
  "hooks": { "post_tool_submit": true, "stop_drain": true, "commit_gate": false },
  "runtime": { "idle_shutdown_ms": 600000, "run_timeout_ms": 30000, "max_restarts": 3 },
  "freshness_ttl_ms": 1800000,
  "routes": { "src/components/Catalog.tsx": "/toys" }
}
```

`enabled` gates the whole layer; `backend` selects the tier (§3.2). A project
may run Tier 1 for the inner loop and additionally point a pre-push / CI
invocation at Tier 2 against a deployed preview — the two are not mutually
exclusive.

## 11. Rollout — phased

| Phase | Scope | Proves |
|---|---|---|
| 1 | Tier 1 browser runtime + Mode A smoke. PostToolUse `submit` is wired, but results surface **only at Stop `drain()`** — no PreToolUse `consume` yet | the warm-browser runner + the verdict path |
| 2 | PreToolUse `consume` → mid-session `[interlinked:browser]` warnings | the "between tool calls" async loop |
| 3 | Mode B — declared-spec scheduling via `project-graph.ts` | the harness as E2E scheduler |
| 4 | Mode C tenant API; land `placeholder_data_in_rendered_ui` | the provider/tenant split |
| 5 | TDD integration — browser specs as red/green citizens + commit gate | behavioral TDD |

Phase 1 still needs the §4 substrate — the PostToolUse `submit` and the
browser-dedicated manager instance are in scope from Phase 1; only the
PreToolUse `consume` wiring is deferred to Phase 2. Each phase is independently
shippable and warn-only until its FP rate is known.

**Tiers are an orthogonal axis.** Phases 1–5 are built on the local Tier 1
(§3.2) — that is the path that proves the orchestration. Remote Tier 2 lands
most naturally alongside Phase 3: Mode B's deployed-preview verification is
Tier 2's core job, and a public preview URL is exactly the input Tier 2 wants.
Tier 2 is a backend the orchestrator is already agnostic to (§5), so it is an
additive option, not its own phase.

## 12. Relationship to adjacent work

- **`placeholder-data-runtime-tier.md`** — its check is the first Mode-C
  tenant. This layer is the provider; that memo specifies one consumer. Build
  order is independent.
- **TDD cycle** (`server-tdd-cycle.ts`, `detectTestRunFile`) — Phase 5: teach
  `detectTestRunFile` to recognize `playwright test`, and let a passing browser
  spec drive a UI component's red/green cycle. Behavioral TDD — the thing a
  `.tsx` component actually wants.
- **`verification-stop-checks.ts`** — `warn_ui_not_interacted` is **superseded
  when this layer is enabled** (the harness loads the page itself), not
  retired: the layer is default-off, so the nag stays for every project that
  has not opted in. And the layer's smoke test is *behavioral*, not *visual* —
  it catches "throws," not "the button is white-on-white" or "the layout
  broke." Keep a slim nudge for the agent to eyeball appearance; that is the
  one thing harness-driven testing structurally cannot do.

## 13. Non-goals

- Not a replacement for the project's CI E2E suite — the layer *schedules a
  subset* at hook time; the full suite still runs in CI.
- Not visual-regression / screenshot-diffing (possible later, separate memo).
- No PreToolUse *blocking* on browser results — latency forbids it, and
  behavioral failures are warn-class.
- Not load / performance testing.
- **Not a remote inner loop.** The high-frequency PostToolUse→PreToolUse
  self-correction loop stays on Tier 1 (local); routing it through a remote
  browser is deliberately rejected — see §3.2.

## 14. Open questions

- Route discovery for non-obvious files — how far to push the import-graph walk
  before falling back to `route-not-located` (§9.2).
- Runtime diff-awareness — is a baseline render ever worth its cost, or is
  stack-attribution (§8.3) sufficient indefinitely?
- Stop `drain()` budget — raise the global `ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS`,
  or pass a per-job-type budget?
- Dev-server ownership — reuse the agent's, or always run a harness-owned one
  (§9.1)?
- Tier 2 metering surface — how browser-minutes are counted, attributed to a
  workspace, and surfaced to the user (a product question, deferred).
- Headless browser provisioning in CI / on a fresh clone (`playwright install`).

## 15. Review log (2026-05-17)

The design review folded the following into the body above:

1. **Coalescing (§4.1).** `async-analysis.ts` has a single stash slot; a naïve
   per-file submit drops the middle of a multi-file edit burst. Fixed by
   submitting under one stable job key with the `analysisFn` closing over an
   accumulated dirty-route set — coalescing then renders the union, losing no
   route, with no change to `async-analysis.ts`.
2. **Second manager instance (§4.2, §9.7).** The "second slot" is a second
   `createAsyncAnalysisManager` instance for browser jobs — browser work no
   longer contends with structural analysis over the one shared slot.
3. **Runtime diff-awareness (§8.3).** "Diff-aware" has no mechanism for runtime
   behavior without a baseline render. Resolved with stack-origin attribution
   for exceptions; the absolute `console.error` budget is removed from the
   default gate (it would be noisy) and made advisory pending a baseline.
4. **Staleness (§9.3).** Added an intra-session staleness guard (content-hash
   on each finding; drop on `consume` if the file changed since; discard a
   superseded run's result) on top of the cross-session TTL.
5. **Route-discovery failure (§9.2).** Emit an explicit `route-not-located`
   finding instead of silently loading `/` — a green run against the wrong
   page is a false-confidence trap.
6. **Egress vs. Mode A (§9.6).** A strict egress deny-all fights the smoke
   test; default to allow-listing the project's own API origins.
7. **`warn_ui_not_interacted` (§12).** Superseded *when the layer is enabled*,
   not retired (the layer is default-off); and the behavioral smoke test does
   not cover *visual* appearance — keep an agent-eyeball nudge.
8. **`PostToolUseFailure` cancellation (§6).** Reuses the sidecar manager's
   per-call `AbortSignal` — no new `async-analysis.ts` API.
9. **Factual corrections.** The Stop drain budget is the literal
   `ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000` (`drain()` itself defaults to 10 s
   but `server.ts` passes the 5 s constant). The TDD machinery is
   `server-tdd-cycle.ts` (there is no `tdd-new-file-gate.ts`). Line-number
   citations were replaced with symbol references.
10. **Local/remote split made explicit (§3.2).** The execution model is now a
    deliberate two-tier design — a free local inner-loop floor (Tier 1) and an
    opt-in metered remote premium tier (Tier 2) — rather than an incidental
    `backend` config value. The cadence rationale (which jobs belong in which
    tier), the localhost barrier that forces the split, and the product
    framing (the orchestration is the product; remote is the monetized
    delivery of the premium slice) are written down. §2, §5, §9.6, §10, §11,
    and §13 were updated to reference the tiering consistently.
