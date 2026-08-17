# Round-2 routing — same-context vs fresh-eyes, per residual type

Status: design decision, 2026-08-15. Owner: the mutation-fix pipeline
(mini = census sweep → lean Sonnet agents fix one file each, tests only, no
inline verify → MBP measures the fixed files out of band).

Companions: `mutation-residue-ledger.md` (the residual taxonomy this routes on),
`equivalent-mutant-handling.md` (the cheap levers that run before any agent),
`scratch/fleet-r3/CONTRACT-W6.md` (lean-mode agent contract),
`scratch/fleet-r2/MORNING-DEFECTS.md` (the diagnosed mechanical causes),
`per-edit-cloud-mutation-testing.md` (the gate this ultimately feeds).

## The question, and why the answer is a routing not a verdict

After the MBP measure shows a fixed file *still* carries surviving mutants,
should round 2 (a) keep the original agent alive / re-engage it with its context
intact, or (b) spawn a fresh agent?

**Neither, uniformly. Route by residual TYPE.** The two residual classes have
opposite failure modes, so the same round-2 vehicle is right for one and wrong
for the other:

- A **mechanical residual** is a *plumbing* failure. The killing test already
  exists and is named in the round-1 receipt; it simply did not reach the mutant
  in the measured run (scope, placement, sandbox, occurrence mis-target). The fix
  needs no new insight about the mutant — it re-homes or re-selects an artifact
  that already encodes the kill. → **same-context continuation, or better, a
  deterministic fixer.**
- A **reasoning residual** is a *judgment* failure. Round 1 concluded "no
  distinguishing behavior found" (or never looked), and the mutant survived. The
  round-1 verdict is a negative result from one reasoning process; re-sampling
  that same process — which is what keeping the agent alive does — is correlated
  with it and mostly re-confirms. → **fresh eyes, fed the round-1 receipts so it
  adjudicates the specific claim rather than starting blind.**

The practical constraint forces the split anyway. An agent cannot BLOCK on the
out-of-band MBP measure (minutes to 30 min+). "Keep alive" really means
SendMessage-continue with context intact — which pins a live agent slot idle for
the whole measure wait AND keeps the same, now equivalence-anchored, model. That
cost is acceptable for a mechanical re-home (no judgment to anchor) and wasteful
for a reasoning re-attempt (the anchor is the problem).

## 1. The two residual types, grounded in the ledger

`mutation-residue-ledger.md` §5 routes all 698 current campaign-file survivors
into four Part-5 buckets. Collapsed onto the mechanical/reasoning axis:

| Ledger bucket | Count | Axis | Round-2 type |
|---|---:|---|---|
| 1a — overclaimed (receipt says `killed_by_test`, still `survived`) | **45** | mechanical | plumbing |
| 1b — untouched (no receipt anywhere) | 72 | reasoning (shallow) | judgment |
| 2 — redundant behavior (suspected-equivalent pool) | **538** | reasoning | judgment |
| 3 — inert / dead implementation (removal-candidate / DiD-keep) | 42 | reasoning (low value) | judgment |
| 4 — policy / uncertainty | 1 | reasoning | judgment |

**Why 1a is mechanical, not a real miss.** The overclaim root causes are
diagnosed and rule-shaped, not mysterious (ledger §4, `repair-followups.txt`,
MORNING-DEFECTS #7/#14/#16):

- `parseImports` ignores `export … from` barrel edges → the killing test is
  invisible to the graph BFS that selects the runner's test scope.
- the 150-mutant scope cap falls back to a naive 4-stem filename glob that misses
  a sibling `*.test.ts`.
- a test stranded in `__tests__/` with no static-import edge to the SUT never
  ships to the sandbox (the runner resets to HEAD and receives only the target
  file + companion stem + graph-scoped tests + dep closure).
- a multiline dynamic `await import(...)` is invisible to the graph parser.
- occurrence mis-target: `originalLexeme` repeats and the receipt did not pin
  `ordinalWithinSymbol`, so the test asserts against the wrong occurrence.
- sandbox fragility: shared-RNG fake divergence, HOME-sandbox fixture leak.

In every one of these the *insight* (the test) is correct; the *delivery* failed.
That is why re-reasoning is the wrong tool and a transform is the right one.

**Why bucket 2 is reasoning, and why it is not trustworthy as "equivalent."** The
ledger's headline: sound provers confirmed **1 of 581** equivalence candidates
(0.17%, one TCE hit). 508/581 (87.4%) rest only on `fuzz_no_divergence` — an
unbounded search that found no counterexample — and the 72 `exhaustive`-tagged
rows were **0/72** actually exhaustive on inspection; all were prose arguments.
Decisively: **48 mutants a prover could not confirm equivalent were later killed
by ordinary test-writing** (§3.5). "Suspected equivalent" is empirically often
killable, which is exactly why it earns an independent second look — but a
*cheaper* one than round 1, because the frontier (the structural argument) is
already written.

## 2. The routing table

| Residual type | Round-2 vehicle | Why this vehicle | Anchor risk |
|---|---|---|---|
| **1a mechanical** — overclaim / scope / placement / occurrence / sandbox | **deterministic fixer** first; **same-context continuation** as fall-through | correction is a rule-shaped transform on an existing artifact; no verdict to anchor on | none (no judgment) |
| **parser-gap subclass** of 1a (barrel edge, scope cap, dynamic-import blindness) | **harness fix** (task #10), batched — not a per-file agent job | the same bug recurs across files; fix the class once | n/a |
| **1b untouched** | **fresh agent**, ordinary kill lane | no round-1 context exists to preserve; reviving buys nothing | none |
| **2 redundant / suspected-equivalent** | **fresh agent, fed the round-1 `why` + `decided_by` + `fuzzInputs`**, framed adversarially | independence breaks the correlated-evidence tie on the stubborn tail; the fed argument makes it adjudicate, not re-explore | mitigated by adversarial framing (see §6.3) |
| **3 inert / dead** | **fresh agent, adjudicate remove-vs-keep** (never auto-remove) | judgment about defense-in-depth; ledger records only, per doctrine | as bucket 2 |
| **4 policy / left_open** | **fresh agent**, fed the one-clause why | same as bucket 2, smallest set | as bucket 2 |

## 3. The concrete pipeline change

Today the pipeline is a line: sweep → fix → measure. Round-2 routing inserts a
**join-and-dispatch step after the MBP measure returns**, keyed on the round-1
receipt corpus. Nothing new needs to block; the router runs when the measure
result lands.

### 3.1 Cheap levers run BEFORE any agent lane (cost gate)

Fresh-eyes is the most expensive lever measured (~25k tok per candidate, ledger
§7 — ~3.7× a registered kill). It must run LAST, on the smallest set. Before any
residual reaches an agent lane, drain what a machine or a generator settles:

1. **Generators** (near-zero load, deterministic): StringLiteral object-literal
   tables → `golden-gen/generate.mts`; Commander `.description()/.option()` →
   `generate-commander.mts`. Emit the kill test directly.
2. **Local TCE** (tier-1 esbuild byte-compare, ~1–5 ms): any candidate it proves
   identical is filtered and NEVER handed to an agent. Low hit rate (1/330) but
   free.
3. **Redundant-guard source check** (`no-unnecessary-condition` class): where the
   equivalent is a statically-dead guard in pure-computation code, the fix is to
   remove the guard at source — the equivalent is then never regenerated. This is
   the cheapest reduction of bucket 2 and it shrinks the fresh-eyes set at the
   root (`equivalent-mutant-handling.md` Lever 2).

### 3.2 The join

For each residual mutant still `status:"survived"`, look up its round-1 receipt
in `scratch/fleet-r3/receipts/<slug>.jsonl` by `(file, mutantId)` and dispatch:

```
residual survivor  ──join receipt──▶
  receipt.classification == "killed_by_test"   → MECHANICAL lane (§3.3)
  receipt.classification == "equivalent_candidate" → REASONING lane (§3.4)
  receipt.classification == "left_open"        → REASONING lane (fed the why)
  no receipt (untouched)                       → FRESH KILL lane (ordinary)
```

### 3.3 Mechanical lane (overclaims)

Sub-route by a deterministic cause probe, cheapest correction first:

| Detected cause | Fixer (no agent) |
|---|---|
| test not in graph-scoped set: `__tests__/` placement, or dynamic-import SUT edge | **re-home**: move/rewrite to `<base>.test.ts` or a sibling `*.mutation-kill.test.ts` with a top-level STATIC import |
| occurrence mis-target (`originalLexeme` repeats, ordinal unpinned) | **occurrence-pin**: read `ordinalWithinSymbol` from the manifest, retarget the assertion |
| scope cap / barrel-edge parser gap | **harness fix**, batched (task #10) — not per file |

**Guard against the tag lie (§6.1):** the mechanical lane must NOT trust the
`killed_by_test` receipt as ground truth. Every fixer output is shadow-verified
against the pinned occurrence (or re-measured). A re-homed test that STILL does
not kill was never a plumbing problem — it **falls through to the reasoning
lane** and its receipt is corrected. So "overclaim" is a hypothesis the
mechanical lane tests, never a certainty it acts on.

**Fall-through, not orphan:** if no cause probe matches (the MORNING-DEFECTS list
is still growing), default to a **fresh mechanical agent** handed the specific
diagnosis + the existing test — NOT to the original agent, which may have died
during the 30-min measure wait. Log the unmatched cause as a candidate new fixer
rule / harness bug (dogfood-from-errors).

### 3.4 Reasoning lane (suspected-equivalent)

Spawn a **fresh** agent, and feed it the round-1 receipt's `why` (the structural
equivalence argument), `decided_by`, and any `fuzzInputs` count. Task framing is
**adversarial, not evaluative**:

> "Round 1 argued this mutant is equivalent for the reason below. Your job is to
> BREAK that argument: construct one distinguishing input or observable behavior
> that a test can assert and that differs between original and mutant. If you find
> one, it is a kill (round-1 mislabel caught). If a bounded attempt finds none,
> record a SECOND, independent structural argument — do not restate round 1's."

Outputs, per doctrine (`feedback_prove_equivalence_empirically`): a kill test, OR
`suspected_equivalent` upgraded to **two independent arguments** (higher
confidence, still not a proof, still never auto-`accept`). The fresh agent stays
lean-mode: tests only, no fuzz build, no runner.

### 3.5 Terminal states — when round 2 stops on a mutant

A mutant leaves the loop when the next MBP measure shows it killed, OR its
receipt reaches one of:

- **TCE-proven equivalent** (machine proof) — filtered, never re-run.
- **two-independent-argument suspected_equivalent** — recorded, not accepted.
- **`left_open` with a structural argument** — recorded.

**No third Sonnet round on the same mutant without a NEW lever** — a prover
upgrade, a generator, a source simplification that deletes the guard, or a
**model-class escalation** (§6.2). Re-rolling the same model on the same mutant
is the correlated-evidence trap at a higher round number.

## 4. Why the split is correct (the correlated-evidence principle, with numbers)

Independence of evidence is worth the most exactly where the round-1 verdict is
least reliable — the stubborn tail. Keeping the original agent alive and asking
"are you sure?" samples the same reasoning distribution twice; the second sample
is correlated with the first and mostly re-confirms. The ledger quantifies how
unreliable round-1 equivalence verdicts are: 1/581 machine-proven, 87.4% resting
on a no-counterexample search, 0/72 "exhaustive" rows actually exhaustive, and 48
"could-not-confirm" mutants killed later by plain test-writing. A verdict that
wrong that often is precisely the case for an independent second opinion.

The mechanical residual is the mirror image: there is no verdict to correlate —
the test already kills; the correction is a transform. Independence buys nothing
there, so the cheap same-context (or no-agent) path is right, and the anchoring
that hurts the reasoning lane is irrelevant.

Feeding the round-1 receipt to the fresh reasoning agent is what keeps the second
opinion *cheap*: it adjudicates a stated claim from the frontier instead of
re-deriving the frontier from zero. Independence (a different model instance, a
different reasoning path) and inherited work (the argument) are not in tension as
long as the framing is falsification, not deference.

## 5. Batching refinement (per-file, not per-mutant)

Apply the routing per FILE with a size threshold, not rigidly per mutant. When a
file's residual is a small MIXED set (a few overclaims + one or two
suspected-equivalents), a single same-context continuation that fixes the
mechanical ones AND takes one more swing at the tiny reasoning tail can beat
spawning two lanes — the context is already paid for and the correlation cost is
small on one or two mutants. Split into mechanical + fresh-eyes lanes when the
reasoning residual is large enough that its correlation cost exceeds the
re-spawn/context cost. This is an optimization on top of the type routing, not a
replacement for it.

## 6. Adversarially — where this recommendation could be wrong

1. **Routing trusts the round-1 receipt tag, and the tags are demonstrably
   unreliable.** The ledger caught `exhaustive` 0/72. If a `killed_by_test`
   receipt names a test that never actually killed (a genuine non-kill, not a
   scope problem), the mechanical lane wastes effort re-homing a test that will
   not kill even when selected. **Mitigation is built in** (§3.3): the mechanical
   lane shadow-verifies its own output and falls through to reasoning on failure.
   The residual risk is wasted mechanical cycles, not a wrong final verdict.

2. **Fresh-eyes independence is weak when both agents are the same base model.**
   Two Sonnet instances share training priors; "independent" holds at sampling
   temperature, not at model level. A systematic Sonnet blind spot (e.g.
   regex-equivalence) recurs in the fresh agent. The real independence lever for
   the tail that survives two Sonnet passes is a **different model** — the Opus
   arm, or Codex-as-falsifier (`user_subscription_playbook`: "spend the
   disagreement budget") — or a sound prover, not a third Sonnet. §3.5 escalates
   model-class; if that escalation is skipped, the recommendation degrades to
   expensive re-rolling.

3. **Feeding the round-1 argument can ANCHOR the fresh agent** — the exact failure
   we route away from. Persuasive prose invites ratification-by-deference. The
   hedge is the adversarial framing (§3.4: "BREAK this argument"), which shifts
   the task from evaluation to falsification. This hedge may not fully hold — an
   agent handed a confident argument may still defer. If measured ratification
   rates run high, the fallback is to feed the mutant WITHOUT the round-1 argument
   (pure re-derivation) and only reconcile the two verdicts afterward — more
   expensive, more independent.

4. **The mechanical lane assumes the diagnosed cause set is exhaustive.**
   MORNING-DEFECTS is at 17+ causes and still growing; a novel scope/sandbox
   failure matches no fixer and falls through. The fall-through must default to a
   fresh mechanical agent (§3.3), never to "the original agent, if alive" — that
   agent is often gone after a 30-min measure. Every unmatched cause is logged as
   a new-rule candidate.

5. **Cost inversion.** Fresh-eyes on all 538 bucket-2 mutants at ~25k tok each is
   ~13M tokens — comparable to the whole round-1 campaign (14.5M). If most of
   bucket 2 really IS equivalent (the redundant-defensive-code hypothesis), fresh
   eyes mostly re-confirms at high cost. This is why §3.1 gates the reasoning lane
   behind generators + TCE + the source-side redundant-guard removal FIRST, and
   why fresh-eyes is last on the smallest set. **If that cost gate is skipped, the
   recommendation routes the most expensive lever at the largest bucket — the
   single biggest way this design fails economically.**

6. **The whole per-type split assumes the sweep→fix→measure loop is worth a round
   2 at all on these files.** The 29 campaign files are already at the global
   median survivor count (ledger §8); the 709-file backlog (95.98% of survivors)
   is untouched. A round-2 loop that grinds the campaign tail may be a worse use
   of tokens than a round-1 pass over the backlog with the now-known generators.
   This doc answers "how to route round 2" — it does not argue round 2 outranks
   breadth. That prioritization is a separate call the pipeline owner still makes.

## Cross-references

- `mutation-residue-ledger.md` — §5 buckets (the taxonomy), §3 the 1/581 proof
  rate, §3.5 the 48-later-killed finding, §4 the per-file overclaim counts.
- `equivalent-mutant-handling.md` — the cheap levers (§3.1 here): TCE, the
  redundant-guard source check, generators; and the doctrine that a mislabeled
  equivalent is a test gap in disguise.
- `scratch/fleet-r3/CONTRACT-W6.md` — lean-mode agent contract and the placement
  rule that the mechanical re-home fixer enforces.
- `scratch/fleet-r2/MORNING-DEFECTS.md` — the diagnosed mechanical causes (#7,
  #14, #16) the mechanical lane sub-routes on.
- `feedback_prove_equivalence_empirically` (memory) — never argue equivalence;
  `mutation accept` is a refusal; two independent arguments raise confidence
  without claiming proof.
- `user_subscription_playbook` (memory) — Codex as falsifier is the model-class
  escalation for the tail that survives Sonnet fresh-eyes.
- Task #10 (affected-test-selection parser gaps) — the batched harness fix the
  parser-gap subclass of the mechanical lane routes to.
