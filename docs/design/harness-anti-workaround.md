# Harness anti-workaround program

**Status:** in progress, 2026-06-25. The unifying frame behind the coverage-debt
work — and the backlog it generalizes to.

## The root cause

> The harness gates each tool call **in isolation** against a "must be valid
> right now" invariant. But real changes are multi-step **transactions**.
> Whenever the valid end-state needs coordinated edits, the agent is forced into
> a workaround.

Every class below is a symptom of that one mismatch (valid-per-edit vs.
transactional work), or of a missing affordance, or of a gate whose pressure
manufactures the very artifact it exists to catch. The coverage-debt lifecycle is
the first instance of the general fix: **gate the trajectory, not the edit.**

## The six classes

1. **Coordinated-edit / atomicity (the big one).** Gates that demand each
   intermediate state be valid force gymnastics when the valid end-state spans
   files: tsc blocks a test naming a not-yet-existing symbol; red-bar blocks the
   instant a test fails (rewording a message broke its pinned test → blocked, and
   the block told me to use `--batch`); a type+test couldn't be added in either
   order; MultiEdit's absence forces a Bash batch that takes whole-file contents.
2. **Testing unreachable / defensive code.** The coverage gate forces agents to
   delete fail-open code (`process.cwd()` fallbacks, `catch {}`) or fabricate
   contrived tests to hit a branch (making a `.jsonl` path a directory for an
   EISDIR catch, mocking fs to throw).
3. **No first-class affordance → hand-rolled scripts.** The scratchpad
   socket-probe, the whole-file batch manifest, `INTERLINKED_DISABLE_*` resets —
   each a workaround for a missing `interlinked` command.
4. **Perverse incentives (the most dangerous).** The gate rewards the bad
   workaround: coverage → introverted tests; red-bar → `.skip`/delete; CRAP/cap →
   awkward helpers or obfuscation; line cap → premature splitting / `@codegen-data`;
   assertion-free → filler `expect(true).toBe(true)`.
5. **Mechanical busywork.** biome `organizeImports` placement, `// SAFETY:` on
   every cast, `empty_catch` → `void _err`, `write_without_mkdir`,
   `exactOptionalPropertyTypes` `| undefined` plumbing, the no-`!` ratchet.
6. **Heuristic checks → avoidance.** `agent_thumbprint_prose` on the literal word
   "placeholder"; `ubs_division_by_variable` on provably-guarded division.

## The fix, prioritized

| Class | Fix | Status |
| --- | --- | --- |
| 3 | **First-class affordances.** Every probe/bypass script ⇒ a missing command. First: `harness test --write/--edit <file>`. | ✅ **shipped** (see below) |
| 1 | **Generalize debt/trajectory.** Coverage-debt lifecycle; `tdd-new-file-gate` opens debt instead of hard-blocking; tsc "symbol coming" deferral. | ✅ **mostly shipped**; tsc-deferral left |
| 4 | **Verification-grade discharge.** Optimistic discharge is gameable (introverted tests); ground-truth coverage + the mutation `kind` is the real defense. | ⏳ engine-seeded; cloud producer left |
| 2 | **Stop gating defensive code.** Honor coverage-ignore pragmas / discharge fail-open branches at commit. | ⏳ not started |
| 5 | **Cut per-edit ceremony.** Auto-biome on the write path; demote `write_without_mkdir`/`empty_catch`/no-`!` where they warp code. | ⏳ not started |
| 6 | **Refine over-firing heuristics.** Confession-context for `agent_thumbprint_prose`; data-flow guard for `ubs_division`. | ⏳ not started |

## Done

- **Coverage-debt lifecycle (class 1).** `obligations.ts` (engine, mutation-ready),
  `coverage-debt.ts` (pair-scoped decision + configurable WIP), `obligation-ledger-io.ts`,
  `coverage-debt-gate.ts` (live wrapper). `debt_mode` **default-on**. The
  `--batch`/"same edit" guidance **removed from every coverage message**. Verified
  live on this repo and mcp-client-bio. See `docs/design/coverage-debt-tdd.md`.
- **`tdd-new-file-gate` → debt (class 1).** A new source file with no companion
  test now **opens a coverage debt + allows** (with a nudge naming the companion)
  instead of hard-blocking, when `debt_mode` is on; the existing wander/discharge
  machinery handles the rest. Hard-block preserved when `debt_mode` is off;
  `// interlinked-tdd: exempt` still honored. This is what makes "new module → its
  test" two ordinary edits.
- **`interlinked harness test --write/--edit <file>` (class 3).** Fires a synthetic
  Write/Edit event at the live daemon and prints the decision — the first-class
  replacement for hand-rolled socket-probe scripts. `--write` takes `--from-file`
  or `--stdin`; `--edit` takes `--old`/`--new`.
  - *Review caveat:* shipped with two feature-breaking bugs caught only by live
    end-to-end testing (its pure unit tests were 100% green): a 2s `queryHarness`
    timeout (a Write event runs the coverage overlay, seconds) and a missing
    `event.cwd` (gates that resolve the ledger/overlay fail closed without it).
    Both fixed. Lesson: socket/daemon features need a live integration test, not
    just a pure-constructor unit test.

## Left to do

- **Class 1 tail:** a "this symbol is coming" deferral for the tsc dangling-ref
  case (so genuine test-first doesn't trip the diff-overlay).
- **Class 4:** wire the mutation `kind`'s cloud producer; replace coverage's
  *optimistic* per-edit discharge with verification-grade (ground-truth) discharge
  so an introverted test can't clear a debt.
- **Class 2:** honor coverage-ignore pragmas / commit-time discharge for fail-open
  branches. (The new-file gate's own `!projectRoot` / dead `rule_id` defensive
  branches are an instance — left intentionally untested per this principle.)
- **Class 3 tail:** audit the remaining `INTERLINKED_DISABLE_*` resets and any
  future probe scripts into real `interlinked` commands.
- **Classes 5 & 6:** the ceremony + heuristic-refinement backlog.
- **Doc sync:** `CLAUDE.md` and the `reference_write_batch_gate_semantics` memory
  still describe `--batch` as the coverage path — now stale.

## Throughline

Classes 1, 2, and 3 share the coverage root: valid-per-edit enforcement on
transactional work. The debt/trajectory reframe is the general cure. Class 4 is
why mutation lives in the obligation engine from day one — the gate's own pressure
manufactures the dishonest artifact, so discharge must be honest, not optimistic.
And class 3 is the cheapest: build the command the moment you catch yourself
scripting a workaround.
