# Split-context adversarial review — amendment to Tier 3

**Status:** Plan / amendment, 2026-07-09. Amends `tier-3-async-deep-review.md`
(§3.1, §4.2, §4.3, §6, §7, §12, Implementation order) and `three-tier-architecture-v2.md`
(§5 Surface 2, line 638; reconciliation table row §10). Neither Tier 3 nor this
amendment is built — which is exactly why the correction is cheap now.

**Origin:** `docs/external-pulse/bun-in-rust.md` §2.3. Bun ran ~64 agents for 11 days
with 1 implementer : 2+ adversarial reviewers : 1 fixer, and the reviewers' context was
**only the diff**.

> The Claude that wrote the code wants the code to get accepted. The Claude that reviews
> wants to find issues in the code. […] its context: only the diff. told to assume the
> code is wrong.

---

## 1. The defect

Tier 3 as designed hands the reviewer the implementer's session trajectory and asks it to
grade the implementer's process. Four places encode this:

| Location | Current text | Problem |
|---|---|---|
| §3.1, line 67 | `invoke Tier 3 review with (repo, diff, prose, session log)` | session log is a declared reviewer input |
| §4.3, lines 109-115 | loads `.interlinked/session-trajectories/<session-id>.jsonl` — "the tool-call log" | the implementer's reasoning enters the reviewer's context |
| §6, SECTION 2, lines 149-162 | "Session trajectory summary": tool-call histogram + `[step 12] BLOCKED by Tier 1`, `[step 145] WARNED by Tier 2` | the reviewer learns which gates already fired, and anchors on them |
| §6 SECTION 4 lines 188-189; §7 lines 222-227; §12 item 3 line 321 | `did_session_follow_methodology`, `methodology_notes` | the *verdict schema itself* requires the trajectory |

And `three-tier-architecture-v2.md:638` restates it: *"Loads active prose policies +
**redacted** session trajectory + redacted/minimized commit diff."* The redaction there
is about secrets, not about contamination — it still hands over the trajectory.

**Why this is wrong, precisely.** The trajectory is a record of *how the implementer
came to believe the code is correct*. It contains the implementer's justifications, the
gates it already satisfied, and the order in which it convinced itself. A reviewer given
that record does not evaluate the code; it evaluates the *argument for* the code. It
inherits the implementer's frame — including the frame's blind spots, which are exactly
where the bugs are. Bun's three cited catches (async `uv_close` use-after-free, the
negative timestamp, the third) were all code that *compiled clean and looked plausible*.
A reviewer told "the implementer ran 89 edits and satisfied Tier 1 and Tier 2" is being
handed a prior that the code is fine.

There is a second, subtler leak: **§4.2 grants the reviewer read access to the entire
repo.** Under split context that is a contamination channel, because the implementer's
trajectory files, review artifacts, and scratch notes live *in the repo* under
`.interlinked/`. §4.2's stated purpose (cross-reference the architecture, detect module
shadowing) is legitimate and must be preserved — but it must read the tree at the
merge-base, with `.interlinked/` excluded.

## 2. The resolution: two roles, two contexts, one report

The methodology judgment is genuinely valuable — `/enforce`'s prose policies exist to be
evaluated against it, and §12's cite-trail depends on it. The fix is not to delete it.
The fix is that **it is a different job, done by a different agent, with a different
context**, and the two never share a window.

| Role | Sees | Never sees | Answers |
|---|---|---|---|
| **Code reviewer** (×N, independent) | the diff; the tree at merge-base minus `.interlinked/`; prose policies; `CLAUDE.md`/`AGENTS.md` | trajectory; other reviewers' findings; whether any gate fired | "Where is this code wrong?" |
| **Skeptic verifier** (×1 per finding) | the finding; the diff hunk; the tree | the reviewer's rationale; the trajectory | "Can I reproduce this? Default: no." |
| **Process auditor** (×1) | trajectory; prose policies; the *file list* of the diff | the diff contents; the reviewers' findings | "Did the session follow the declared methodology?" |
| **Fixer** (×1) | verified findings; the diff; the tree | — | applies remediations |

The orchestrator is the only component holding all four outputs. This is the
implementer≠reviewer≠fixer separation from the post, plus the one adaptation our stack
needs: Bun's reviewers were backstopped by a million-assertion suite, so a false positive
cost a fixer round-trip. Ours have no such backstop, so we add the skeptic stage to
carry the burden of proof.

**Commit messages are evidence, not context.** The reviewer sees them (they are part of
`git log -p`), but the prompt frames them as *claims under test*, not as description. This
is the same stance `commit_message_diff_mismatch` (`behavioral-diff-checks.ts:293`) takes
deterministically: a `refactor:` commit whose test assertions changed is lying. The
reviewer inherits that stance for claims the deterministic check cannot parse.

## 3. Burden of proof — the two-stage asymmetry

Bun says *"told to assume the code is wrong."* Taken literally by a single agent, that
maximizes recall and destroys precision; every review returns findings because it was
told to. Our own `harness-red-team.js:81` already solved the dual problem, in the
opposite direction:

> Default `bypassed=false` unless you can cite the exact line/branch that lets it through.

Both instincts are right, at different stages. Adopt both:

- **Stage 1 — adversarial finder (N of them, parallel, independent).** Prompt inverts the
  goal, per `harness-red-team.js:75`: *"You are an adversarial reviewer. This diff contains
  at least one defect. Your job is to find it. Do not summarize the change; do not
  compliment it; do not report that it looks correct."* High recall by construction. Each
  finder gets an identical context and a different **lens** (correctness, resource
  lifetime, concurrency/re-entrancy, boundary values, security) — perspective diversity
  beats N identical skeptics, because the Bun bug list is dominated by failure modes a
  single lens cannot see.
- **Stage 2 — skeptic verifier (one per finding, parallel).** Prompt inverts back:
  *"Determine whether this defect is real. Construct the concrete input and state the
  observable wrong behavior. Default `real=false` unless you can name the failing input
  and the line it fails on."* Findings that survive are reported; the rest are dropped
  silently and logged for FP calibration.

The finder never sees the verifier's rulings; the verifier never sees the finder's
rationale, only its claim. A finder that cannot state a failing input produces a finding
the verifier kills — which is the correct outcome, and is cheap.

**N.** Reuse `multi-agent-pre-push-review.md` §3's risk-tier triage as the count knob
(`interlinked.review.cohort.<tier>`): trivial → 0 reviewers, lite → 1, full → 3 lenses.
Bun used 2 reviewers per implementer; 3 lenses at the `full` tier is the same order.

## 4. What stays, verbatim

- **Warn-only.** §13 is unchanged and binding (`feedback_reluctance_to_push`). The
  split-context contract governs *what the reviewer knows*, not *how hard the gate bites*.
  `bun-in-rust.md` §3b is explicit: adopt the review contract, reject the unanimous-block
  gate strength. Unanimous-block stays where `multi-agent-pre-push-review.md` §5 put it —
  the Agent CI managed-remote surface.
- **Aggregation.** `multi-agent-pre-push-review.md` §4 lines 105: dedup across reviewers,
  severity = max, both reviewers credited. Adopt as-is for the report; drop the block
  semantics for the local surface.
- **§12 items 1, 2, 4** (definitions glossary, principles, source cite-trail) are all
  diff-and-prose operations. They survive untouched. Only item 3 moves.
- **Surface 1** (`three-tier-architecture-v2.md:617-632`, the live-feedback supermodel
  alongside the working agent) is **out of scope**. It sees the trajectory by
  construction — that is its entire purpose. Split context governs Surface 2 (pre-push)
  only. The amendment must say so explicitly, or a future reader will "fix" Surface 1.

## 5. Edits, file by file

### `docs/design/tier-3-async-deep-review.md`

| § | Line(s) | Edit |
|---|---|---|
| Status | 3-5 | Note the split-context contract and link this doc. |
| §3.1 | 67 | `invoke Tier 3 review with (repo, diff, prose, session log)` → `dispatch: code reviewers (diff + tree@merge-base + prose) ∥ process auditor (trajectory + prose)` |
| §4.2 | 100-107 | Add: read access is to the tree **at merge-base**, with `.interlinked/` excluded. State why (trajectory artifacts live there). |
| §4.3 | 109-115 | Retitle "Prose policies" — drop the `.jsonl` input from the *reviewer's* scope; move it under a new §4.4 "Process auditor inputs". |
| §5 | 117-127 | Add the lens table + N-per-tier. Sonnet stays default. Note the cost model in §9 now multiplies by N (see §7 below). |
| §6 | 149-162 | **Delete SECTION 2 entirely.** Renumber SECTION 3 → 2, SECTION 4 → 3. |
| §6 | 188-189 | Remove `did_session_follow_methodology` / `methodology_notes` from the *reviewer's* schema; they move to the auditor's schema. Add `lens` and `claimed_failing_input` to each finding. |
| §6 | new | Add SECTION 4 = the adversarial framing paragraph (§3 above). |
| §7 | 222-227 | "Methodology assessment" stays in the **report** — it is now sourced from the auditor, not the reviewer. Annotate accordingly. |
| §12 | 321 | Item 3 → "evaluated by the process auditor, which sees the trajectory and the diff's *file list* but not its contents." |
| Impl order | 406-408, 412 | Steps 1-3 (trajectory persistence, commit↔session linkage) now serve the **auditor**, not the reviewer — so they no longer block the reviewer's GA. Step 7 ("Tier 3 sees Tier 2 verdicts in the trajectory") is **removed for reviewers** and retained for the auditor. This is a real unblocking: the code-review half of Tier 3 can ship before trajectory persistence exists. |
| §16 | 388-392 | Open decisions 9-10 (multi-session trajectory aggregation; secrets-in-trajectories) now scope to the auditor only. |

### `docs/design/three-tier-architecture-v2.md`

| § | Line | Edit |
|---|---|---|
| §5 Surface 2 | 638 | `+ **redacted** session trajectory +` → remove from the reviewer input list; add a sibling bullet for the process auditor. |
| §15 table | 1348 | "§10 session log persistence — Required for both T3 surfaces" → "Required for Surface 1 and for the Surface 2 *process auditor*; **not** an input to Surface 2 code reviewers." |
| §5 Surface 1 | 617-632 | Add one sentence: split-context is a Surface-2 constraint; Surface 1 is trajectory-native by design. |

### `docs/external-pulse/bun-in-rust.md`

Update the equivalence-table row (line 60) from "designed — and specifies the opposite"
to "designed; corrected by `adversarial-review-split-context.md`".

## 6. Why this is worth doing before Tier 3 is built

Three of Tier 3's four unbuilt prerequisites (§ Implementation order 415-419) exist *only*
to feed the trajectory to the reviewer: session-trajectory persistence, commit↔session
linkage, and the trajectory half of the `interlinked review` data pipeline. Under split
context they stop blocking the code-review path. **The amendment makes Tier 3's most
valuable half shippable strictly sooner** — a reviewer needs `git diff`, the prose
policies, and an API key, all of which exist today.

The inverse is also true, and is the reason to do this now rather than after: if Tier 3
ships trajectory-fed, every downstream artifact (the report schema, the cache prefix
layout in §8, the cost model in §9) hardens around a contaminated context, and the
correction stops being a doc edit.

## 7. Cost

§9's cost model prices one review per push, single reviewer. Under this amendment a
`full`-tier push runs 3 finders + K verifiers + 1 auditor. The finders share an identical
prompt prefix (prose policies + diff) → prompt caching amortizes ~all of the input cost
across the three; the verifiers take a small context (one finding + one hunk); the auditor
takes the trajectory, which no other role loads. Rough shape: ~1.2× the input tokens of a
single-reviewer design, ~3× the output. Bun's own ratio (5.9B uncached in / 690M out /
72B cached reads) shows where the money goes — cached reads are 12× the uncached input.
Design the prefix accordingly: **policies first, diff second, lens instruction last**, so
the lens is the only cache-busting suffix.

## 8. Test plan

The reviewers are agentic and live outside the hook path (`feedback_harness_deterministic_only`),
so they get eval coverage, not vitest coverage:

1. **Contamination unit test (deterministic, vitest).** The prompt-assembly function is
   pure. Assert: given a session with a persisted trajectory, `buildReviewerPrompt()`
   output contains no substring from the trajectory file, and `buildAuditorPrompt()`
   contains no diff hunk body. This is the one part of the contract that *is* mechanically
   checkable, and it is the part that will rot.
2. **Independence test.** Assert the N finder prompts differ only in the lens suffix, and
   that no finder prompt contains another finder's output.
3. **The Bun corpus as an eval fixture.** The four porting regressions in
   `bun-in-rust.md` (§Notes) are real, minimal, and public. Encode them as four diffs;
   measure finder recall and verifier precision with and without trajectory in context.
   This is the experiment that would actually falsify the amendment — if trajectory-fed
   reviewers catch *more* of the four, the post's claim doesn't transfer and we should
   know that.

Item 3 is the honest one: the split-context claim is an empirical bet sourced from one
team's experience at a scale we haven't reproduced. It is cheap to adopt because Tier 3 is
unbuilt, and it is falsifiable against a four-case corpus we already have. Adopt it, and
measure it.
