# Harness — System at a Glance (Diagrams + Modality Reference)

**Purpose:** visual reference for how the verification harness fires at each stage of the agentic loop, what substrates each stage reads from, and how the 16 verification modalities map to (purpose, stage, local/cloud). Read top-to-bottom.

**Companions:**
- `docs/design/test-quality-harness-local-first.md` — the local-first kernel (Phases 0–3.7) these diagrams describe.
- `docs/test-quality-harness-plan.md` — the full v3.2 plan; cloud Tier 2 substrate sits *additive* on top of what's here.
- `docs/hooks-ecosystem-comparison.md` — per-runner hook timeouts and decision contracts (Claude Code / Codex / Gemini / Copilot / Cursor).

**Cross-runner working-budget note:** the diagrams use **25s PreToolUse / 25s Stop** as the cross-runner least-common-denominator working budget. Claude Code and Codex CLI both default to **600s** (10 min) for command hooks; Gemini defaults to **60000ms = 60s** (note the millisecond unit, unique to Gemini); Copilot CLI caps at **30s** by default and **cannot block at Stop / agentStop / sessionEnd**; Cursor's default isn't pinned publicly. For consistent behavior across runners, the LCD is what the substrate plans against. See "Per-runner Stop / SessionEnd table" at the bottom of this doc for verified numbers + sources.

---

## 1. Inner loop — per tool use (the 30s PreToolUse window)

```
                       AGENT ┐
                             │ decides next action
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ PreToolUse hook fires    [hard ceiling 30s · working budget 25s] ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ ┌──────────────────────────────────────────────────────────┐ ║
   ║ │ Smart selection (§13 of kernel doc)                       │ ║
   ║ │ reads substrates → ranks candidates → admits ≤25s         │ ║
   ║ └──────────────────────────────────────────────────────────┘ ║
   ║                                                                ║
   ║  ┌─ INSTANT  <50ms ────────────────────────────────────────┐  ║
   ║  │ • Shape checks (placeholders, .only, assertion density) │  ║
   ║  │ • Secret detection (inline regex, high-conf patterns)   │  ║
   ║  │ • Import-cycle check                                    │  ║
   ║  │ • Module-size cap (large-files-baseline ratchet)        │  ║
   ║  │ • File-kind classify (unit / acceptance / config)       │  ║
   ║  │ • Dependency-check on lockfile delta                    │  ║
   ║  │ • CRAP lookup (precomputed)                             │  ║
   ║  │ • Codebase-graph blast-radius query                     │  ║
   ║  │ • Knowledge-graph layer / companion query               │  ║
   ║  └─────────────────────────────────────────────────────────┘  ║
   ║                                                                ║
   ║  ┌─ FAST  50ms–5s ─────────────────────────────────────────┐  ║
   ║  │ • tsc --noEmit incremental                              │  ║
   ║  │ • biome / oxlint / eslint on changed files              │  ║
   ║  │ • Cyclomatic complexity (TS parse)                      │  ║
   ║  │ • Semgrep curated ruleset                               │  ║
   ║  │ • Knowledge-graph drift on artifact / declared invariant│  ║
   ║  │ • Reachability-filtered SCA finding lookup              │  ║
   ║  └─────────────────────────────────────────────────────────┘  ║
   ║                                                                ║
   ║  ┌─ SELECTED  up to 25s — picked by §13 for THIS edit ─────┐  ║
   ║  │ • Mutation diff-scoped (leaf/mid files)                 │  ║
   ║  │ • Selected unit tests (bug-catch-ranked covering subset)│  ║
   ║  │ • Property tests, bounded N                             │  ║
   ║  │ • Acceptance smoke (short scenarios only)               │  ║
   ║  │ • Heavier Semgrep / pattern SAST                        │  ║
   ║  └─────────────────────────────────────────────────────────┘  ║
   ║                                                                ║
   ║ → writes receipt (per-tool-use eval), emits decision           ║
   ╚═══════════════════════════════════════════════════════════════╝
                             │
                  ┌──────────┴─────────┐
                  ▼                    ▼
              BLOCKED               ALLOWED
              (agent sees             │
               reason)                │  tool actually runs
                                      │  (write / edit / bash)
                                      ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ PostToolUse hook fires   [30s ceiling · 0.2–1.4s typical]      ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ Goal: spot-check what actually landed; finalize the receipt.   ║
   ║                                                                ║
   ║ • Diff-aware coverage on agent's test invocation (piggyback)  ║
   ║ • Test-runtime ratchet update                                 ║
   ║ • Secrets re-scan on the actually-written content             ║
   ║ • Persistent-warning escalation (same warning N×?)            ║
   ║ • Finding-history fingerprint write (first_seen / last_seen)  ║
   ║ • Receipt finalized + signed (per-tool-use eval committed)    ║
   ║ • Knowledge-graph companion presence re-check (was the test   ║
   ║   you promised, written?)                                     ║
   ╚═══════════════════════════════════════════════════════════════╝
                             │
                             ▼  agent sees PostToolUse warnings
                             │
                             └──→ LOOP BACK (next tool use)
```

## 2. Outer loop — per session / per push / nightly

```
   (many inner loops accumulate; eventually agent stops)
                             │
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ Stop                     [seconds tolerable · non-blocking]   ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Whole-suite coverage ratchet                                ║
   ║ • Mutation against changed lines (broader scope than per-edit)║
   ║ • Acceptance smoke for changed capability-tag                 ║
   ║ • Dead-code detection (Supermodel Deadcode Hunter)            ║
   ║ • Whole-project tsc                                           ║
   ║ • Knowledge-graph adoption / glossary-residue drift           ║
   ║ • Reflection: did agent verify? (verification-stop-checks)    ║
   ║ • Commit-cadence nudge (too many uncommitted edits?)          ║
   ║                                                                ║
   ║ Note: the "heavy work" listed here is the substrate-decision  ║
   ║ point — see the local-first kernel §13.x for the              ║
   ║ "Stop is reflection, not heavy work; spawn detached if heavy" ║
   ║ pattern. Sync vs async vs local vs remote is its own choice.  ║
   ╚═══════════════════════════════════════════════════════════════╝
                             │
                             │  user runs git push (manual)
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ Pre-push                 [minutes tolerable]                  ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Full whole-file Stryker mutation                            ║
   ║ • Gitleaks full-history scan                                  ║
   ║ • Whole-image Trivy / Checkov / tfsec                         ║
   ║ • Architecture-rule verification on full graph                ║
   ║ • Acceptance full suite                                       ║
   ║ • Capability-map drift detector (Tier 4 candidate too)        ║
   ╚═══════════════════════════════════════════════════════════════╝
                             │
                             │  pushed → CI fires
                             ▼
   ╔═══════════════════════════════════════════════════════════════╗
   ║ CI / pre-merge           [minutes–tens of minutes]            ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Full Semgrep org-policy                                     ║
   ║ • Whole-suite coverage + ratchet enforcement                  ║
   ║ • Playwright e2e full                                         ║
   ║ • Performance regression                                      ║
   ║ • Migration smoke against staging DB                          ║
   ║ • OpenSSF Scorecard                                           ║
   ╚═══════════════════════════════════════════════════════════════╝

  ═══════════════════ IN PARALLEL, CONTINUOUSLY ═══════════════════

   ╔═══════════════════════════════════════════════════════════════╗
   ║ Tier 4 Scheduled         [nightly / weekly discrete jobs]     ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Flakiness sampling N=5 on rotating subset                   ║
   ║ • Mutator rotation full set                                   ║
   ║ • Acceptance mutation (cost-catastrophe contained here only)  ║
   ║ • Whole-codebase audit (brownfield drift over time)           ║
   ║ • Schemathesis full fuzz                                      ║
   ║ • SLSA / provenance verify                                    ║
   ╚═══════════════════════════════════════════════════════════════╝

   ╔═══════════════════════════════════════════════════════════════╗
   ║ Tier 5 Continuous        [always-on, persistent state]        ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║ • Coverage-guided fuzzing (corpus persistent across runs)     ║
   ║ • SCA external-vuln-DB polling (invalidate lockfile findings) ║
   ║ • Continuous Semgrep policy refresh                           ║
   ╚═══════════════════════════════════════════════════════════════╝
```

## 3. Substrates — what every stage reads from / writes to

```
       ╔═══════════════════ PER-EDIT LOOP ═════════════════════╗
       ║                                                       ║
       ║   PreToolUse  ──→  Tool runs  ──→  PostToolUse  ──→ … ║
       ║      ▲ reads          (writes)         ▲ reads        ║
       ║      │                 to fs           │ writes       ║
       ║      └──────┬──────────────────────────┘              ║
       ╚═════════════│═════════════════════════════════════════╝
                     │
                     ▼
   ╔════════════════ LOCAL-CANONICAL SUBSTRATES ════════════════╗
   ║  (.interlinked/ — authoritative; sync is additive later)   ║
   ╠════════════════════════════════════════════════════════════╣
   ║                                                            ║
   ║  ┌─ Codebase graph ──────────┐  ┌─ Knowledge graph ──────┐ ║
   ║  │ Supermodel                │  │ structure/ artifact     │ ║
   ║  │ • File imports            │  │ system                  │ ║
   ║  │ • Symbol-level calls      │  │ • Declared layers       │ ║
   ║  │ • Blast radius            │  │ • Public-symbol         │ ║
   ║  │ • Test-coverage map       │  │   companions            │ ║
   ║  │                           │  │ • Env/config-key        │ ║
   ║  │ Answers:                  │  │   companions            │ ║
   ║  │  "what imports X?"        │  │ • Package boundaries    │ ║
   ║  │  "what tests cover X?"    │  │ • Glossary residue      │ ║
   ║  │  "blast radius of edit?"  │  │                         │ ║
   ║  │                           │  │ Answers:                │ ║
   ║  │ Lane A + B                │  │  "what layer is this?"  │ ║
   ║  └───────────────────────────┘  │  "does the declared     │ ║
   ║                                 │   invariant still hold?"│ ║
   ║                                 │  "is the companion      │ ║
   ║                                 │   artifact present?"    │ ║
   ║                                 │                         │ ║
   ║                                 │ Lane B + C              │ ║
   ║                                 └─────────────────────────┘ ║
   ║                                                            ║
   ║  ┌─ Receipt ledger ─────────┐  ┌─ Finding history ───────┐ ║
   ║  │ Phase 0.3                │  │ Phase 0.4                │ ║
   ║  │ One row per tool call    │  │ Per fingerprint:         │ ║
   ║  │ • tool_call_id           │  │ • first_seen_at          │ ║
   ║  │ • check_runs[]           │  │ • last_seen_at           │ ║
   ║  │ • diff_hash              │  │ • status (open/resolved/ │ ║
   ║  │ • final_decision         │  │   wontfix)               │ ║
   ║  │ • per-check duration_ms  │  │ • severity, confidence   │ ║
   ║  │ • per-check authority    │  │                          │ ║
   ║  │ • check_version          │  │ Powers:                  │ ║
   ║  │                          │  │ • recurrence detection   │ ║
   ║  │ = per-tool-use eval      │  │ • brownfield triage      │ ║
   ║  │   (the named concept)    │  │ • persistent-warn escal. │ ║
   ║  └──────────────────────────┘  └──────────────────────────┘ ║
   ║                                                            ║
   ║  ┌─ Test-runtime ratchet ───┐  ┌─ Baselines ─────────────┐ ║
   ║  │ Phase 2.1                │  │ Phase 0 + ongoing        │ ║
   ║  │ Per-test:                │  │ • large-files-baseline   │ ║
   ║  │ • p50 / p95 / sample N   │  │ • non-null-assert count  │ ║
   ║  │ • bug-catch count        │  │ • as-any count           │ ║
   ║  │ • selected count         │  │ • mutation score / file  │ ║
   ║  │ • false-positive count   │  │ • coverage % / file      │ ║
   ║  │                          │  │ • CRAP per function      │ ║
   ║  │ Feeds: §13 selection +   │  │                          │ ║
   ║  │ adaptive loop            │  │ Brownfield: pinned       │ ║
   ║  │                          │  │ Greenfield: starts at 0  │ ║
   ║  └──────────────────────────┘  └──────────────────────────┘ ║
   ║                                                            ║
   ╚════════════════════════════════════════════════════════════╝
```

## 4. Local vs Cloud split

```
   ╔═══════════════════ LOCAL-FIRST KERNEL ════════════════════╗
   ║                   (kernel doc — Phases 0–3.7)             ║
   ╠═══════════════════════════════════════════════════════════╣
   ║ All hook stages run in user's workspace daemon:           ║
   ║   PreToolUse · Tool runs · PostToolUse · Stop ·           ║
   ║   Pre-push · CI · Scheduled · Continuous                  ║
   ║                                                           ║
   ║ All substrates live local-canonical:                      ║
   ║   .interlinked/harness.sqlite + .interlinked/*.jsonl      ║
   ║                                                           ║
   ║ Storage is local-canonical, period. Always authoritative. ║
   ╚═══════════════════════════════════════════════════════════╝
                                │
                                │  (later, when local kernel has
                                │   empirical user data — v3.2)
                                ▼
   ╔════════════ CLOUD (FUTURE — v3.2 Phase 4+) ═══════════════╗
   ║ Additive fan-out substrate for the heaviest items:        ║
   ║   • Supervisor DO + Facets — parallel mutation, 100-way   ║
   ║   • Sandbox — Linux-class (acceptance e2e, fuzzing)       ║
   ║   • Outbound Worker — egress with credential injection    ║
   ║                                                           ║
   ║ Sync substrate (federated peer / remote / undecided):     ║
   ║   • Inherits the local SQLite schema as-is                ║
   ║   • Receipt format already signable + content-hash-keyed  ║
   ║   • Local kernel stays authoritative; sync is additive    ║
   ╚═══════════════════════════════════════════════════════════╝
```

## 5. The 16 modalities — reference table

Reading guide: "where it fires" = which stage(s) in diagrams 1–2.

| # | Modality | What it does | Where it fires | Local? |
|---|---|---|---|---|
| 1 | Test coverage | Records which lines/branches tests executed; gates "are your new lines hit?" | PostToolUse (piggyback) + Stop + CI (ratchet) | Local |
| 2 | Dependency structure | File-and-symbol-level import / call graph; powers blast-radius and covering-set | PreToolUse (read), Phase 0 build | Local (Supermodel) |
| 3 | Cyclomatic complexity | Function-level branching count; feeds CRAP | PreToolUse (FAST band) | Local |
| 4 | Module sizes | Per-file LOC cap with grandfathered baseline | PreToolUse (INSTANT band) + Stop (ratchet) | Local |
| 5 | Mutation testing | Perturb SUT; check that tests fail when code is wrong | PreToolUse (diff-scoped leaf/mid) + Stop (broader) + Pre-push (full file) + Tier 4 (rotation, whole repo) | Local; cloud accelerates fan-out (v3.2) |
| 6 | Property testing | Random-input generative tests; verifies discrimination against blindspots | PreToolUse (bounded N) + Stop + Tier 4 (deep shrink) | Local |
| 7 | Unit testing | Per-function discrimination tests; selected per-edit by §13 | PreToolUse (ranked subset) + Stop (broader covering set) | Local |
| 8 | CRAP analysis | complexity × (1−coverage)² per function; risk indicator | PreToolUse (lookup) — rides on coverage cadence | Local |
| 9 | Automated testing (general) | The whole §13 substrate + Lane A; all of the above orchestrated | All stages | Local |
| 10 | Codebase graph | Supermodel — file imports, symbol calls, test-coverage map, blast radius | Read by every stage; Phase 0 build, refresh on edit | Local |
| 11 | Knowledge graph | `structure/` artifact system — declared layers, companions, package boundaries, glossary residue, project-scoped invariants | PreToolUse (FAST: companion / layer / invariant) + Stop (drift / adoption) | Local |
| 12 | Acceptance tests | End-to-end via real HTTP/CLI/db; capability-tag binding | PreToolUse smoke only (short) + Stop (capability-routed) + Pre-push (full) + Tier 4 | Local; cloud Sandbox for long e2e (v3.2) |
| 13 | Acceptance mutation | Mutate SUT, verify acceptance tests detect; cost catastrophe per mutant | Tier 4 only (scheduled / nightly) — too expensive for per-edit | Local; cloud fan-out helps (v3.2) |
| 14 | Dependency checking | CVE lookup, license, maintainership, postinstall safety, allowlist | PreToolUse (lockfile-delta, INSTANT) + Stop (full closure) + Tier 5 (vuln-DB polling) | Local; allowlist already shipped |
| 15 | Per-tool-use eval | The receipt produced for each PreToolUse + PostToolUse pair, joined with subsequent findings to attribute outcomes; feeds §13.7 adaptive loop | PostToolUse (write) — read by §13 every PreToolUse | Local |
| 16 | Brownfield / greenfield | Not a check — a *posture*. Same loop, different baseline starting points (see below) | Affects every stage's threshold | Local |

## 6. Brownfield vs greenfield — same loop, different priors

```
   BROWNFIELD                              GREENFIELD
   ──────────                              ──────────
   Baselines pinned at install.            Baselines start at 0.
   "No regress past current state."        "Every finding is new."

   Finding provenance matters:             Provenance trivial:
    • introduced-by-current-edit            • everything = introduced
    • pre-existing-in-file
    • pre-existing-codebase

   Policy matrix applies (kernel §21.3):   Policy matrix mostly N/A
    in-file pre-existing → require-fix     (no pre-existing).
    codebase pre-existing → backlog

   Smart-selection priors                  Adaptive priors empty for
   populated by blast radius +             first N edits → uniform.
   accumulated bug-catch data              Per-test bug-catch data
   from receipts.                          builds from scratch.

   Day-1 friction: high until              Day-1 friction: low.
   triaged. (Phase 11 wizard in v3.2       Trust accumulates as
   handles this; this kernel only          receipts accumulate.
   has the policy matrix.)

   Test-runtime ratchet                    Test-runtime ratchet
   inherits current values.                builds from scratch.
```

---

## How to read this together

The loop in diagrams 1–2 is the same in both brownfield and greenfield, both local and cloud. What changes is *which substrate fans out* (local-only vs. local+cloud) and *where the baselines start* (pinned vs. zero). The smart-selection substrate (kernel §13) is the load-bearing component because it's how the inner loop actually uses the 25s window — without it, "use the 30s budget" is a slogan, not a system.

**Cross-runner note:** these diagrams use 25s as the PreToolUse working budget because that's the cross-runner least-common-denominator. For Claude-Code-only or Codex-only deployments, the working budget is much more generous. See the per-runner table just below and `docs/hooks-ecosystem-comparison.md` for the full per-runner contract.

---

## 7. Per-runner Stop / SessionEnd table (verified 2026-05-26)

> **Local kernel policy: SessionEnd is narrow + Claude-Code-only.** Two items run at SessionEnd and only there: (1) a reason-aware audit-chain row using Claude Code's `reason` field (`clear` / `resume` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other`); (2) one-time `reconcileCommits` finalization (already gated on session_end in `hooks-template.ts:1023-1025`). Everything else stays on Stop because SessionEnd is fire-and-forget on Gemini, missing on Codex, skipped on hard-kill, and unable to block — so load-bearing work there is unreliable. The kernel's incremental durability discipline (PostToolUse receipts + Stop reflection) ensures state-at-exit is recoverable on any runner. SessionEnd's broader future role is the cloud/remote tier (final session-bundle upload, batched sync). The table below is comparative reference; the LCD framing still applies to cross-runner work.

| Runner | Stop / equivalent default | SessionEnd default | Blocks at Stop? | Source |
|---|---|---|---|---|
| **Claude Code** | **600s** (`Stop`, per turn) | **600s** (distinct `SessionEnd`, per session) | Yes (`Stop` blocks turn end via `decision: "block"`; max 8 consecutive blocks before override). SessionEnd cannot block — stderr-to-user only. | Anthropic Claude Code docs (`docs.claude.com/en/docs/claude-code/hooks`) |
| **Codex CLI (OpenAI)** | **600s** (`Stop`, per turn) | **No SessionEnd event** | Yes (`Stop` blocks via `decision: "block"`). Resolution: `codex-rs/hooks/src/engine/discovery.rs:457` → `let timeout_sec = timeout_sec.unwrap_or(600).max(1);`. Enforcement: `tokio::time::timeout(Duration::from_secs(handler.timeout_sec), …)` in `command_runner.rs:71-72`. | Codex source — verified directly. Event list: `codex-rs/hooks/src/lib.rs:19-30` (`HOOK_EVENT_NAMES`). |
| **Gemini CLI** | **60000ms = 60s** (`AfterAgent`) | **60s** (`SessionEnd`, but CLI doesn't wait — fire-and-forget) | `AfterAgent` can return `decision: "deny"` to force a retry turn. SessionEnd cannot block. | `docs/hooks/reference.md` upstream |
| **GitHub Copilot CLI** | **30s** (`agentStop` / `subagentStop`) | **30s** (`sessionEnd`) | **No** at Stop-class events — only `preToolUse` can block (and even then deny-only in practice) | GitHub docs (`docs.github.com/en/copilot/reference/hooks-configuration`) |
| **Cursor IDE** | **Platform default** (unpinned publicly); example uses 30s | Same as Stop | `stop` uses `followup_message` to auto-resubmit (loop, bounded by `loop_limit`, default 5), not block in the traditional sense | `cursor.com/docs/hooks` |

**Practical implications for the harness:**

- **Hard ceiling = LCD = Copilot's 30s** when running cross-runner. Past 30s, Copilot kills the hook and any longer-running runners get a free ride.
- **Stop "blockability" varies.** Only Claude Code and Codex let Stop block. Gemini's `AfterAgent` can force a retry, Cursor's `stop` is a loop primitive, Copilot can't block at all. Stop-equivalent work in the kernel stays advisory regardless.
- **Gemini's SessionEnd is unreliable** — CLI doesn't wait for it. Heavy work there gets killed when the process exits. Use Stop-equivalent (`AfterAgent`) or pre-push / scheduled instead.
- **Codex has no SessionEnd at all** — only per-turn `Stop`. If the harness wants a session-final hook on Codex, it has to piggyback on the last `Stop` (no clean signal for "last") or trap process-exit at the OS level.
- **Units diverge.** Gemini's `timeout` is milliseconds; everyone else uses seconds. Cross-runner installers must translate.
