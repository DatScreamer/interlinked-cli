# Codex review rounds — raw findings archive

Each file in this folder is the **verbatim, unedited output** of one adversarial
Codex review (GPT-5.6 Sol on the user's ChatGPT subscription, never an API key) of
the spec-audit harness subsystem (`docs/design/spec-audit-runtime-checks.md`). They
are preserved as-emitted for provenance — no reformatting, no summarizing.

The review loop that produces these lives at `.interlinked/codex-review-loop.mjs`;
it auto-ingests each report into the findings corpus (`interlinked findings`), where
the reconciliation machinery drives every finding to a touch or an ack. This folder
is the human-readable trail alongside that machine state.

| Round | File | Model · effort | Scope | TOTAL |
|------|------|----------------|-------|-------|
| 01 | `round-01-substrate-mini.md` | gpt-5.4-mini · low | extract-ids/types (first slice) | 3 |
| 02 | `round-02-substrate-sol.md` | gpt-5.6-sol · none | extract-ids/types (deeper) | 21 |
| 03 | `round-03-substrate-rerev-mini.md` | gpt-5.4-mini · low | extract-ids re-review after fixes | 2 |
| 04 | `round-04-tasks1-3-sol.md` | gpt-5.6-sol · none | spec substrate + single-file checks + ledger | 10 |
| 05 | `round-05-pregates-sol.md` | gpt-5.6-sol · none | pre-gates + ledger preview + reconciliation | 7 |
| 06 | `round-06-taskslice-loop-mini.md` | gpt-5.4-mini · low | first `codex-review-loop.mjs` dogfood run | (loop) |
| 07 | `round-07-deep-max-reasoning.md` | gpt-5.6-sol · **max (ultra)** | whole subsystem, deep pass | 14 |
| 08 | `round-08-deep-max-reasoning-r2.md` | gpt-5.6-sol · **max (ultra)** | whole subsystem, deep pass (r2) | 38 |
| 09–20 | (stamped in `.interlinked/codex-review-*.md`) | gpt-5.6-sol · none | `assembly-score` + `recurrence*` convergence | ~33 |
| 21 | (stamped) | gpt-5.6-sol · none | broadened: spec drift/gate files | 5 |
| 22 | (in progress) | gpt-5.6-sol · **max (ultra)** | spec drift/gate files, deep pass | — |

Every finding through round 21 was either fixed with a pinning regression test or
acked with a reason in the findings corpus. Rounds 09–21 ran at `effort=none`
(fast, in-session-executable) and hardened `assembly-score`/`recurrence` (bounded
memory, collision-safe hashing, NaN-safe time handling) then the spec drift/gate
files (round 21 caught 5 real bugs in the round-08 fixes). At `none` the reviewer
hit a noise floor on the recurrence files (~40% false positives verified + design
churn), which is why round 22 escalates those spec files to **max/ultra** reasoning
— the profile the standing goal requires. Raw per-round output for 09+ lives in
`.interlinked/codex-review-*.md` and the findings corpus (`interlinked findings`).

Note: the model/effort labels reflect what was used per round for wall-clock reasons
(the user's standing preference: mini/low or sol/none for fast slice reviews, sol at
**max/ultra** reasoning for the deep whole-subsystem passes; never Codex "fast" mode).
Rounds 01–03 predate the folder and are copied from the session's working results.
