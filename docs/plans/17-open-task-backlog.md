# Plan 17 — Open task backlog (resume point, 2026-08-01)

**Purpose.** This is a handoff document. The 2026-07-31/08-01 campaign closed its
headline goals and pushed 12 commits (tip `fc96837`, CI green). What remains is a
set of 12 independent, individually-shippable tasks that were opened *by* that
campaign and deliberately not finished inside it. A later session should be able
to pick any single row here and work it without re-deriving context.

Nothing below is blocked on anything else unless the row says so.

## State at handoff

| | |
|---|---|
| `origin/main` | `fc96837` — 12 commits landed, working tree clean |
| CI | run `30726118815` on `fc96837`, `conclusion: success` |
| Cyclomatic cap (22) | **0 functions over** — tree-wide clean |
| Cognitive cap (30) | **0 functions over** — tree-wide clean, now a blocking per-edit gate |
| Line cap (500) | 9 cappable files over cap, 21 grandfathered. **User has explicitly deprioritised LOC work** — do not start it |
| Suite | 1,068 files / 26,904 tests green; typecheck clean |
| Registry | 252 checks, 6 confirmed dead (row T4) |

**Caveat on references.** `scratch/` is gitignored. Any probe named below
(`scratch/cognitive-verify.mts`, `scratch/registry-properties/*`) exists only on
the machine that ran the campaign and does **not** travel with a clone. Where a
task depends on one, the row says how to rebuild it. Plan 15 and 16 are committed
and are the durable record.

---

## Tier A — source defects (fix these first; each is a real wrong answer)

### A1 · `throwStub`/`bareThrow` regexes lack a trailing anchor

- **File** `src/harness/deletion-hygiene.ts:61` and `:64`
- **Shape** Both regexes anchor with `^` only. The body they test is up to two
  source lines joined by a space (`lines.join(" ")`, guarded by
  `if (lines.length > 2) return false` at :58). So a function whose first line is
  a stub throw and whose second line is real code matches, and the function is
  misreported as an unimplemented stub.
- **Bound honestly** The 2-line guard limits blast radius — this is not
  "any stub followed by a body". Do not overstate it in the commit message.
- **Fix** Anchor the alternation's tail, or test per-line rather than on the
  joined body. Prefer per-line: it is the property actually intended.
- **Done when** A must-not-fire case for `throw new Error("todo");` + one real
  statement is in the test file and passes, and the existing must-fire cases
  still pass.
- **Size** ~10 min.

### A2 · Four registry entries resolve to a detector literally named `fn`

- **Files** the `circular_imports`, `dead_exports`, `untested_inverse_pair`,
  `untested_idempotent` entries in `src/harness/check-registry/entries-*.ts`
- **Shape** Each is registered as an inline arrow
  `fn: (content, filePath) => checkX(content, filePath, process.cwd())`. JS
  object-literal key name-inference names that arrow `"fn"`, which defeats
  `check-evidence/resolve.ts`'s name-based detector→test-file lookup. All four
  report **0 test files** despite being substantial, well-tested,
  project-graph-aware detectors.
- **Impact** Tooling misreport only — the checks themselves work. But it makes
  the Check Evidence Contract lie about four rows, which is exactly the kind of
  silent-incompleteness this campaign spent its time eliminating.
- **Fix** Give the arrow a real name (`const circularImportsFn = ...`) or teach
  `resolve.ts` to fall back to the registry id when the function name is `fn`.
  The second is more general and covers future entries.
- **Done when** `check-evidence` reports non-zero test files for all four.
- **Size** ~30 min.

### A3 · `spec_count_claim` fires on a number that is not an id count

- **Found by** this very document, twice, and the second instance appeared as a
  direct result of writing up the first:
  - `"39 functions" vs D census: 6 distinct ids (D1..D6)` — D4's CRAP figure
  - `"Four registry entries" vs A census: 3 distinct ids (A1..A3)` — A2's own
    title, which counts registry entries, not tasks
  Two independent noun-mismatches in one short document is the calibration
  evidence; no fixture needs inventing.
- **Shape** The detector correlates any numeric claim in a section against the
  count of enumerated ids in that section. But "39 functions over the CRAP cap"
  is a claim about *functions in the codebase*, not about the six D-rows that
  happen to surround it. The subject nouns are unrelated.
- **Why it is worth fixing** The repo's own rule is that a noisy check gets its
  detector refined, not its finding suppressed
  (`feedback_dogfood_harness_from_errors`, `reference_advisory_does_not_mean_silent`).
  Left alone this fires on any plan doc that quotes a metric near a numbered list
  — which is most of them. It is already advisory-only, so this is noise
  reduction, not a gate fix.
- **Fix direction** Require the claim's governing noun to match the enumerated
  items' subject before firing (`"6 tasks"` vs `D1..D6` fires; `"39 functions"`
  does not). Reject the correlation when the noun is absent or mismatched.
- **Done when** A must-not-fire case built from this document's D-section passes,
  and the existing must-fire cases still fire.
- **Size** ~30 min.

---

## Tier B — dead code and untruthful inventory

### B1 · 6 of 252 registered checks are dead (task #24)

Full analysis with per-check causes is already written up in
**plan 16 §6.3** — read that first, it is the spec for this task. Summary:

| id | Class | Action |
|---|---|---|
| `self_import` | stripped-quoted-specifier | fix the detector |
| `extraneous_deps` | stripped-quoted-specifier | fix the detector |
| `test_importing_test` | stripped-quoted-specifier (self-documented as dead in its own test comment) | fix the detector |
| `migration_ordering` | `return []` compat stub in `checks/compat-stubs.ts` | implement or deregister |
| `sql_schema_consistency` | same stub file | implement or deregister |
| `visibility_filter_missing` | same stub file | implement or deregister |

Two genuinely different problems sharing one symptom:

1. **The stripped-specifier bug** (3 checks). `stripCommentsAndStrings(content)`
   blanks every quoted string before the specifier-matching regex runs. An import
   specifier is *always* quoted, so it can never survive stripping. These
   detectors return `[]` for every possible input. This is a **confirmed
   recurring class** — worth a `detector-scans-stripped-specifier` meta-check
   (backlog in plan 16 §11.2), which would catch instance five automatically.
2. **The compat stubs** (3 checks). Deliberate `return [];` placeholders, but
   registered with real severity, phase and `fix_instruction` as though live —
   so `interlinked harness checks` counts them among the working checks. That is
   an inventory that overstates itself. Either implement them or take them out of
   the count; do not leave them registered-but-empty.
- **Ordering note** Removing a registered check must go through the
  docs-freshness gate in the right order — generated counts FIRST, then the
  registry (see `reference_docfreshness_count_gate_ordering`).
- **Size** ~45 min for the 3 regex fixes; the stub decision is a judgement call
  worth raising with the user before implementing three checks from scratch.

---

## Tier C — the daemon (highest value, least bounded)

### C1 · Daemon argv builders diverge (task #9)

- **Files** `src/commands/harness-lifecycle-helpers.ts:57` (has
  `--max-old-space-size` + `--expose-gc`), `src/hook-entry-daemon-gate.ts:305`,
  `src/lib/statusline-revive.ts:92` (has the flags *and* `--session-id default`)
- **Shape** Three separate places build the daemon's spawn argv and they do not
  agree. At least one path omits the heap flags, so a daemon started via that
  path runs with V8 defaults and hits the memory ceiling sooner. The absent
  `--session-id` on one builder was never explained.
- **Why it matters** This is the most likely remaining contributor to the
  recurring "harness went down again" symptom that cost multiple sessions.
- **Fix** One builder, three callers. Pin it with a test that asserts every
  spawn path produces the same flag set.
- **Prerequisite reading** `project_daemon_lifecycle_ledger` — read
  `.interlinked/daemon-events.jsonl` BEFORE theorising about any outage. Five
  distinct mechanisms share the one symptom, and exits now self-explain.
- **Size** ~1h.

### C2 · Statusline reviver never fires for a running-but-not-serving daemon (task #21)

- **File** `src/lib/hook-installers-statusline.ts:124` — `ps -p "$PID"`
- **Shape** The liveness test asks whether a *process* exists, not whether it
  owns the socket. A daemon that is alive but wedged, or one whose socket was
  taken over, reads as healthy and is never revived.
- **Fix** Probe the socket (a real connect, short timeout) rather than the pid.
- **Interaction** Do C1 first — a unified spawn path changes what the reviver
  needs to re-launch.
- **Size** ~45 min.

### C3 · RSS spikes to ~2GB under concurrent load (task #14)

- **Shape** Transient, not resident: the idle daemon sits at ~94MB. Spikes appear
  under full-suite load and trigger `rss-ceiling` handovers (38 of them in a
  400-row ledger sample, versus 2 `build-refresh`).
- **Status** Never profiled. This is the honest state — do not report a cause
  without a heap snapshot.
- **Caution recorded** An earlier session claimed "the resident set grew to
  ~1400MB" from a `ps` filter that did not distinguish repos. That was wrong.
  Any successor must scope the measurement to one daemon pid.
- **Size** unknown until profiled; budget a session.

---

## Tier D — mutation and coverage (the long campaign)

Plan 15 (`15-survivor-elimination-campaign.md`) is the campaign doc; plan 10 is
the mutation design. Read those before starting any D row.

### D1 · Tree-wide mutation totals are FLOORS, not counts (task #19)

**714 of 717 manifest files predate the module-scope identity fix.** Every
tree-wide survivor number currently quoted is a lower bound on a stale identity
scheme. Re-measure before any decision keys off those totals. This is the row
that most easily produces a confidently wrong answer.

### D2 · Runner is a single-job resource (task #18)

Concurrent agent waves starve the sweep, and a starved sweep reports `no_tests` —
a *verdict about the code* produced by a *broken measurement*. That confusion is
the campaign's single most repeated failure mode (busy → `no_tests`, wrong suite
→ `NoCoverage`, missing file → `ConfigError`). Fix the starvation, but more
importantly make the starved state report as "not measured", never as a finding.

### D3 · Make runners commit-independent (task #22)

User requirement, stated directly: mutation testing must not depend on how many
commits a runner is behind, and must never require a push. Direction: complete
overlay closure + peer-to-peer fetch of the closure. Overlay closure work already
landed in `58bda7a`.

**Hard constraint, restated verbatim from the user:** *"nothing to do with the
MacBook Pro should actually be part of the interlinked-cli product. It should not
be visible to any other users and should be gitignored."* The two-box runner is a
private prototype of the eventual cloud offering. Keep every trace of it out of
the published package.

### D4 · 39 functions over the ratcheted CRAP cap of 25 (task #11)

Mostly zero-coverage command entry points — CRAP = cyclo²·(1−cov)³+cyclo, so the
coverage term dominates. Covering these is the lever, not decomposing them.
**Note the measurement trap:** an earlier session measured CRAP 2960 by reading
`f[id]` (function entry) as coverage. The correct field is `statement_pct`; the
real figure was 21.

### D5 · 88 files below their coverage high-water mark (task #12)

117 file-metric regressions. Depends on nothing; grindable in parallel waves.

### D6 · Let agents self-verify coverage (task #16)

`--coverage` is currently banned outright in agent shell allowlists (it is
expensive and was a repeated cause of runaway runs). A scoped
`--coverage.reportsDirectory` would let a subagent verify its own coverage claim
without a full-tree run. This directly attacks the campaign's other recurring
problem: agents self-reporting numbers they never measured.

---

## Working notes for whoever resumes

These are earned, not stylistic. Each cost a session.

1. **A blocked edit is a stale-daemon suspect first.** The running daemon serves
   the build it started with. Check `find src -name '*.ts' -newer dist/harness/server.js -print -quit`
   before theorising about a misconfigured gate.
2. **`gh run watch --exit-status` returns 0 on a *cancelled* run.** Read
   `.conclusion` from `gh run view`. Two runs in the current history are
   `cancelled` and would read as success.
3. **The pre-push gate runs build + packaging smokes *before* typecheck and
   tests** — roughly 7 minutes. It is not "just re-running the suite", and
   `--no-verify` skips real verification of a release-shaped artifact.
4. **Verify `args` reached a workflow before trusting the run.** `args` arrives
   as either an array or a JSON string. Three workflows once silently ran a
   finished wave's targets, and one ran nothing at all. Parse both shapes and
   throw loudly rather than defaulting to something plausible.
5. **Task verifiability predicts agent reliability more than model tier.** Sonnet
   went 22/22 on decomposition units, where the criterion was a mechanical AST
   re-measurement, and was refuted on nearly every mutation-hardening unit, where
   the criterion was judgement. Give subagents a deterministic verifier or expect
   to audit everything by hand.
6. **Self-reports are not evidence.** Every decomposition wave in this campaign
   was checked by an independent re-measurement (`computeCognitiveAst`), and the
   audit schema carried an `evidenceAccurate` field specifically because agents
   conflated "no pre-existing assertion modified" with "the test file has no
   diff". One claimed "no test file touched" on a +2218/−3 diff.
