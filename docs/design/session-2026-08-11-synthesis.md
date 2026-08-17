# Session synthesis — mutation, dead code, harness engineering, economics (2026-08-11 → 08-12)

> **Document role:** historical session record plus a later evidence review. It is not the normative mutation design and it is not a live status dashboard. Historical claims are preserved as claims; changing counts must be regenerated from the mutation manifest or campaign artifacts.

- **Session ID:** `19a1170b-42de-4352-8ab1-2e840a5f8b5a`
- **Resume:** `claude --resume 19a1170b-42de-4352-8ab1-2e840a5f8b5a`
- **Background/tasks working dir (resume artifact):** `34884881-4ffa-41a2-a862-fd778c7a8890`
- **Historical span:** 2026-08-11 overnight → 2026-08-12 ~06:00
- **Evidence review:** 2026-08-13, using the later campaign record, the saved manifest, and the current CLI registration/code surfaces
- **Model record:** Fable 5 in the main loop; session subagents pinned Sonnet/Opus under the then-current user directive
- **Transcript:** `~/.claude/projects/-Users-quentincody-interlinked-cli/19a1170b-42de-4352-8ab1-2e840a5f8b5a.jsonl`

## How to read the evidence

This document uses four evidence grades:

| Grade | Meaning |
|---|---|
| **Measured** | Produced by the named runner/tool under recorded conditions. It is still valid only for the source, tests, engine, and environment it binds to. |
| **Observed** | Directly present in a transcript, log, manifest, source file, or command registration. |
| **Claimed** | Reported by an agent or campaign receipt but not independently remeasured at that point in time. |
| **Proposed** | A design direction, protocol, interpretation, or economic hypothesis. It must not be read as shipped behavior. |

The most important separation is temporal:

- **Session cutoff (~06:00 on Aug 12):** 32 wave files had agent claims but no formal Stryker remeasurement.
- **Follow-up (~07:38 on Aug 12):** the later R3 campaign reports 32/32 files remeasured and about 4,506 additional kills, which is close to the approximately 4,529 claimed kills.
- **Saved manifest snapshot (10:00:40 EDT on Aug 12):** later again, with a different aggregate census. It is the latest local snapshot inspected for this review, not a promise about current repository state.

## The through-line

The session started as an overnight two-box mutation-baseline run and became:

1. an operational incident and recovery exercise;
2. a four-wave survivor-kill campaign;
3. a set of live guard/harness fixes plus a CI/pre-push fix;
4. a research intake on harness engineering; and
5. an investigation of mutation survivors as signals of test gaps, weak observation models, inert code, defensive code, or unresolved uncertainty.

The durable idea is broader and more defensible than “equivalent mutant = dead code”: **a survivor is a request for adjudication, and the adjudication should carry machine-checkable evidence and invalidation inputs.** Inert-but-reachable code is one valuable outcome of that process, especially in AI-forward codebases, but it is not the only outcome.

---

## Part 1 — Operational: the overnight mutation baseline

**Setup (observed in session artifacts):** two-box runner — Mac mini (`127.0.0.1:8790`) plus MacBook Pro (`100.97.48.15:8790`, tailnet), each a LaunchAgent (`dev.quentincody.two-box-runner`) wrapping `scratch/two-box-runner/runner.mjs`; driver `scratch/fleet-r2/night-batch.sh` measured files via `interlinked mutation measure`.

### Crash and governors

- **HOME-sandbox fixture leak:** `interlinked-test-home-*` test fixtures relied on exit cleanup. SIGKILLed Stryker workers skipped it, leaving about 40 GB behind. The session added a 45-minute reaper; the intended product fix was startup-time, TTL-named fixture reaping. See `scratch/fleet-r2/MORNING-DEFECTS.md` item 1.
- **Resource governor:** the driver refused to start a file below 5 GB free disk or 3 GB free memory, purged only known sandbox directories, preserved the incremental cache, and performed steady-state hygiene below 20 GB.
- **Daemon flapping:** the harness daemon repeatedly crossed its 1,800 MB RSS ceiling or was jetsammed under combined agent/lane load, creating short fail-closed intervals. The session raised `DEFAULT_RSS_CEILING_BYTES` to 2,600 MB and added/updated its test. The deeper anti-stomp issue is that ownership needs a health probe, not merely a process/socket existence check.
- **Runner lifecycle gaps:** the client could resubmit without a bound after a vanished job, and the runner did not abandon a job when its client disconnected. Those behaviors matter to any future fleet controller because they turn client failure into expensive orphan work.

### Heavy-file tail

The historical straggler pass attempted a 30-minute ceiling over 152 heavy files in `checks/`, `check-registry/`, `spec/`, and `verify/`. It completed 2 of the first 15 and timed out 13. The correct interpretation is **intractable under the selected test scope and budget**, not “wedged” and not “unmeasurable in principle.” The proposed remedy is minimal affected-test selection with a conservative fallback when scope confidence is low.

At session cutoff, the campaign reported **767 unique files with mutation provenance** and about 150 heavy files intentionally left outside the completed set. Treat 767 as a historical campaign number: its exact inclusion rule is not encoded here, and it does not match the later saved-manifest file count. Recompute any present-day baseline directly from `.interlinked/mutation-manifest.json` and state the inclusion rule.

The session believed all lanes, watchdogs, and reapers were stopped. The R3 follow-up later found an overnight straggler still alive. That makes “all stopped” a historical belief disproved by later evidence and establishes a concrete requirement: session-end cleanup needs a PID/job census and positive runner-idle confirmation.

## Part 2 — Survivor-kill campaign and corrected status

Four Sonnet fleet waves, eight agents each, wrote tests intended to kill identified surviving mutants. The contract was tests-only: no source changes and no git mutation.

### What was known at the original cutoff

- **Claimed:** 32 files and approximately 4,529 kills.
- **Claimed classification:** approximately 489 mutants were described as equivalent based largely on shadow-runner differential/property/fuzz searches.
- **Observed execution evidence:** agents built original and mutated variants, imported both, and compared outputs across generated inputs with `scratch/probes/mutant-shadow-runner.ts`.
- **Not yet measured at cutoff:** a clean, independent Stryker rerun of the 32 files.

The original wording “489 proven-equivalents” and “equivalence proven by fuzz” was wrong. A differential search can find a counterexample and therefore prove a mutant **killable** for that observation. Failure to find a counterexample is only `fuzz_no_divergence`/counterexample-search evidence; it leaves the mutant **unresolved**. It does not establish universal equivalence.

Wave 3’s `sql-migrations` agent hit a 64k output-token cap mid-write. The resumed run used incremental writes and reused seven cached results. This is operational evidence for output budgeting and artifact-first coordination, not evidence about mutation adequacy.

### Follow-up measurement after the cutoff

The later [`scratch/CAMPAIGN-survivor-r3.md`](../../scratch/CAMPAIGN-survivor-r3.md) records:

- 32/32 wave files remeasured by Stryker and recorded by about 07:38 on Aug 12;
- wave-file survivors reduced from 4,972 to about 1,081;
- manifest killed count increased by about 4,506, close to the approximately 4,529 agent claim; and
- an overnight straggler lane found still running and then stopped.

This is strong aggregate confirmation of the claimed kill count, but aggregate agreement is not a substitute for mutant-identity reconciliation. A production verifier should compare stable mutant identity, location, replacement, enclosing-symbol hash, and selected-test scope—not merely before/after totals.

### Saved manifest addendum

The local manifest inspected on Aug 13 has filesystem modification time **2026-08-12 10:00:40 EDT** and `authoritativeAt` **2026-08-12T14:00:40.691Z**. Its census is:

| Field | Saved value |
|---|---:|
| Files represented | 705 |
| Total mutants | 102,686 |
| Killed | 81,778 |
| Survived | 17,818 |
| Uncovered | 2,252 |
| Timeout | 835 |
| Indeterminate | 3 |
| Mutants with a typed disposition | 0 |

The snapshot records engine `stryker`, engine version `unknown`, dependency graph version `1`, and environment hash `cli-measure`. Those weak fingerprints are themselves a design finding: a proof-grade or comparable measurement needs exact engine, mutator, runtime, dependency, test-selection, and environment identities. Do not copy this table into a dashboard or treat it as live; generate the view from the manifest and include its timestamp and filters.

### Aug 13 dogfood census status

The newer in-progress manifest is larger but is still **not a full current baseline**. After the first formal post-Luna remeasurements it represented 738 files and 111,661 mutants (generation 985, `authoritativeAt` 2026-08-13T22:45:52.247Z). A fixed-cutoff dry run of `mutation sweep --all-eligible --measured-before 2026-08-13T13:45:12Z` selected **911 of 1,110 eligible source files** as absent or older than the census cutoff. The actual continued sweep, started after more concurrent working-tree changes, selected **919 of 1,118**; that delta is itself why the eligible-domain identity must be recorded. Therefore “738 files represented” must not be reported as “everything is current.”

Only the local runner is currently present in the CLI's configured endpoint set. The historical MBP lane is not configured for this session, so per-file verification and continued census work serialize through one runner unless the operator explicitly restores a second trusted endpoint. This is a concrete product requirement: baseline status should report eligible, fresh, stale/absent, active lanes, and the fixed census cutoff together rather than exposing only manifest totals.

At 23:23 EDT the active sweep had written generation 1005: 218 represented files carried provenance at or after the fixed cutoff, while the manifest still represented 738 paths overall. This is progress evidence, not completion: failed dry runs and files absent from the manifest remain outside that numerator, and tests authored after a file's measurement require a later verification round. Several apparent runner `ENOENT mutation.json` errors were actually hidden initial-suite failures in the runner log; the runner API should preserve the dry-run cause rather than collapse it to a missing-report symptom.

## Part 3 — Guard/harness fixes and the CI-push fix

Five precision guard changes or validations came from reviewing blocked calls:

1. **`curl | interpreter` exemption:** shells remain blocked; interpreters with inline-code flags such as `-c`, `-e`, `-r`, or `-ne` may consume piped data without treating the pipe as downloaded program text. The hot and cold-fallback rules must remain behaviorally identical.
2. **Kill-loop block and actionable suggestion:** looped multi-process kills block like piped forms and steer to enumerate, confirm, then kill explicit targets.
3. **`du`/`ls`/`stat` dropper exemption:** source was already correct; the observed false positive came from a stale daemon.
4. **Markdown-first private/loopback exemption:** `network-hosts.ts` introduced `isNonRoutableHost`/`hasPublicHttpUrl`, including loopback, RFC1918, link-local, and the `100.64.0.0/10` tailnet range.
5. **Dead `wait_for_work` suggestion:** replaced with the actually available background-run/monitor workflow.

The push sequence exposed two separate verification issues:

- generated documentation markers drifted (`gen:builtin_rule_count` 123 versus 120), fixed by regenerating docs in commit `15413ef`; and
- Linux encoded SIGTERM as POSIX exit `128+n`/npm exit 143, which the typecheck gate misclassified. A shared `diedBySignal()` helper and cross-platform tests fixed it in `61e04b9`.

The pre-push hook was changed to verify a disposable worktree export of `HEAD`, including a fresh `dist` build, so unrelated dirty working-tree state does not contaminate a push gate. This is an example of the larger principle: **verification needs a declared state boundary.** “What is being verified?” must have one answer—overlay, working tree, index, commit, or clean export.

## Part 4 — Harness-engineering research and source coverage

### What was actually read

The original session used an eight-agent research fan-out over Böckeler/Fowler harness-engineering material plus selected talks and transcripts. A later Aug 13 review also covered these requested pages:

- [TDD in the agent loop](https://martinfowler.com/articles/exploring-gen-ai/tdd-in-the-agent-loop.html)
- [Maintainability sensors for coding agents](https://martinfowler.com/articles/sensors-for-coding-agents.html)
- [Local models for coding: the factors that matter](https://martinfowler.com/articles/exploring-gen-ai/local-models-for-coding-factors.html)
- [Three tools for specification-driven development](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
- [Martin Fowler podcast index](https://martinfowler.com/tags/podcast.html)

The podcast pass was **not transcript-complete**, and this document must not imply otherwise:

- Full transcript/captions were reviewed for the Gergely Orosz conversation, James Lewis/GOTO conversation, Growing Development Forest, Book Overflow, and the Software Engineering Radio DSL episode.
- Show notes and related primary material, rather than complete transcripts, were used for the Agile Manifesto episode, Agility and Architecture, both Ruby Rogues appearances, and the Agile Database Techniques episode.
- The Brass Birmingham item was reviewed only at the episode-description level and was not relevant to the metaharness design.
- The outbound-link graph was sampled for relevant primary material; it was not exhaustively traversed. “Read all related hyperlinks” would therefore be an overclaim.

The original byline/name corrections remain useful: “The Economic Benefit of Refactoring” is by Giles Edwards-Alexander; ccmenu is associated with Christof Doernenburg; “Humans and Agents” is by Kief Morris; and “13” was a series number, not a count of failure modes.

### Research synthesis for Interlinked

Interlinked already implements a substantial harness-engineering layer, but its strengths are asymmetric: it is more developed in computational feedback than in feedforward guidance, inferential review, and evidence that the harness itself improves outcomes.

The combined research suggests seven design principles:

1. **Close the recurrence loop.** Repeated observed mistakes should draft both a sensor and a concise guide, with human review before activation. `/enforce` distills stated rules; recurrence synthesis would learn from actual failures.
2. **Measure sensor coverage, not only sensor fire rate.** A silent sensor may mean excellent code, an irrelevant sensor, a broken detector, or missing observation. Report applicability, executions, skips, suppressions, and true/false-positive adjudications.
3. **Use tests/specs as steering artifacts.** TDD helps most when a behavior contract exists before implementation and an independent verifier evaluates the result. Agent-authored implementation and agent-authored tests are correlated evidence, not independence.
4. **Triangulate specifications.** Prose invariants, executable examples/tests, and implementation structure should cross-check each other. Disagreement becomes a review agenda rather than being silently resolved in favor of whichever artifact ran last.
5. **Route work by risk and locality.** Cheap deterministic checks belong on the edit path; local/smaller models can handle bounded low-risk tasks when context closure is high; expensive models and inferential checks belong at stop/CI cadence or on high-risk changes.
6. **Make context closure measurable.** Track whether an agent could identify the owning symbol, contract, affected tests, relevant rules, and verification command without broad repository search. Context cost is part of harness performance.
7. **Prefer proof-carrying changes over check accumulation.** Every meaningful result should identify the code state, observation model, verifier, evidence, and invalidation conditions it rests on.

### Ranked product backlog

1. **Stable verification state machine and evidence ledger** — the common substrate for mutation rounds, specs, scenarios, and ratchets.
2. **`recurrence synthesize`** — draft a sensor plus feedforward guide from a hot recurrence signature.
3. **Harness-coverage report** — applicability, executions, skips, suppressions, yield, adjudicated false positives, and blind spots.
4. **Approved behavior fixtures/scenarios** — a human-owned behavior anchor distinct from the tests the implementation agent writes.
5. **Inferential stop/pipeline lane** — coupling, modularity, spec quality, and architectural consistency, kept off the millisecond path.
6. **Measured context-closure metric** — files/symbols searched, context tokens, time-to-owning-contract, and verification command discovery.
7. **Risk-tier/model router** — deterministic local work first; escalate based on change risk, ambiguity, and failed evidence, with a circuit breaker for repeated non-progress.
8. **Guidance self-consistency and cross-gate ping-pong detectors** — find cases where one rule’s recommendation predictably trips another.

Adversarial conclusions should remain visible rather than averaged away: tighten-only ratchets are appropriate for objective water-lines but need explicit re-arming/rebaselining rules for taste metrics; pre-disk blocking is only appropriate for deterministic zero-false-positive checks; “harness lifts weak models” is a testable, narrower claim; and quiet checks do not self-justify without applicability and outcome data.

## Part 5 — Equivalent mutants: corrected conceptual model

The companion design is [`equivalent-mutant-handling.md`](./equivalent-mutant-handling.md). Its central opportunity survives, but the terminology needs stricter boundaries.

### A survivor is not a conclusion

A surviving mutant is evidence of at least one of these states:

| State | Meaning | Resolution |
|---|---|---|
| `killed` | An observation distinguishes mutant from original. | Keep the regression test/evidence. |
| Test gap | Behavior differs, but selected tests do not observe it. | Strengthen the test/fixture or observation. |
| Observation-model gap | Difference exists outside the outputs/effects currently observed. | Expand the declared observation model. |
| `dead_code` | Code should be deleted or an unfinished intent implemented. | Change source; do not bless it as equivalent. |
| `proved_unreachable` | A stated invariant plus certificate excludes execution. | Revalidate when the invariant or boundary changes. |
| `proved_equivalent` | Original and mutant are observationally identical under an explicit model, established by an accepted proof mechanism. | Exclude only while the certificate remains valid. |
| `outside_contract` | Difference is real but deliberately outside the approved contract. | Require human-owned contract/approval evidence. |
| `accepted_risk` | Difference is real and temporarily tolerated. | Owner, issue, expiry, and approval required. |
| `duplicate` | Another stable mutant/evidence item represents the same semantic obligation. | Bind to the representative and invalidate together. |
| `unresolved` | Search did not produce a counterexample or proof. | Keep visible and continue/stop honestly. |

“Equivalent mutant = dead code” collapses several of these states. A proved equivalent is observationally inert under a declared model; that does not necessarily mean the code should be deleted. A redundant security/trust-boundary guard can be deliberate defense-in-depth even when an invariant currently makes it inert. Conversely, genuinely dead code is a source defect or cleanup obligation, not an accepted equivalence.

For day-to-day triage, the longer disposition table can be compressed into four routing buckets without collapsing the final evidence state:

1. **Test/observation gap:** the mutant changes behavior that the present suite or observation channels miss.
2. **Redundant behavior:** the mutated expression is reachable but does not change the declared observation model under the current invariants.
3. **Inert/dead implementation:** the expression or enclosing path has no supported effect and should normally be removed or completed.
4. **Policy/uncertainty residue:** the difference is outside contract, accepted temporarily, duplicated, timed out, or not yet adjudicated.

Buckets 2 and 3 deliberately share a default maintenance question—“why does this code exist if changing it has no supported effect?”—and will often converge on source deletion. They must remain distinct in the ledger because a reachable redundant check can be intentional defense-in-depth: its value is preserving a second boundary if the first invariant later fails. That case needs a named security invariant and invalidation trigger, not a generic “equivalent” waiver. Dead/inert code has no such retained duty.

### Evidence ladder: cheapest sound mechanism first

1. **Exact normalized/compiler-output equivalence under a pinned transform.** Useful only when the transform preserves the relevant runtime semantics and every target/config/plugin version is bound into the certificate. Byte equality from an unsound or mismatched transform is not a proof.
2. **Checked algebraic rewrite lemma.** Normalize original and mutant through an explicitly named, validated rewrite system; identical hashes under the lemma form the evidence.
3. **Type/control-flow proof.** Sound only when the runtime value origin is established. TypeScript types alone do not constrain JSON, environment variables, network input, plugin input, deserialization, `any`, or unchecked casts. Validate at the boundary or downgrade the result to candidate evidence.
4. **Complete bounded exhaustiveness.** Proof-grade only for a genuinely finite domain whose completeness is recorded, not a large sample labeled “exhaustive.”
5. **Relational SMT/symbolic proof.** Only a validated `unsat` result under the encoded contract is proof; `sat` is a counterexample and `unknown` is unresolved.
6. **Targeted property/differential testing and fuzzing.** A divergence kills the mutant and should be minimized into a fixture. No divergence adds search evidence to `unresolved`; it never upgrades itself to `proved_equivalent`.

The observation model must include relevant return values, thrown errors, state mutations, filesystem/network effects, logs/events if contractual, timing only if contractual, and other externally visible behavior. “Full output” is meaningful only after those channels are enumerated.

### Current implementation truth versus proposed surface

As inspected on Aug 13:

- **Implemented internally:** `src/harness/mutation/disposition.ts` defines typed states including `dead_code`, `proved_equivalent`, `proved_unreachable`, `duplicate`, `outside_contract`, `accepted_risk`, and `unresolved`, plus proof/certificate validity fields.
- **Registered publicly:** `interlinked mutation accept` exists but deliberately refuses prose-only equivalence. It cannot mint a verifier certificate.
- **Implemented but not registered:** `src/commands/mutation-disposition.ts` can build and record `dead_code` or `unresolved`, but no `.command("disposition")` registration was found in the current CLI registrars.
- **Not implemented as a public end-to-end path:** a verifier/certificate issuer and a registered command that records a valid `proved_equivalent` judgment.
- **Saved data:** the inspected manifest contains zero typed dispositions.

Therefore, references in the companion design to an existing reviewed `mutation accept` or fuzz-plus-accept path are aspirational/inaccurate. The next design step is not to relax `accept`; it is to register honest non-accepting dispositions and build a separate, narrowly trusted verifier/certificate path.

## Part 6 — Proposed mutation/verification rounds

The system should treat mutation hardening as a state machine whose transitions require evidence. More agents do not create independence; a clean verifier operating on a content-addressed state does.

### Cross-cutting lane — test legitimacy and anti-reward-hacking evidence

Mutation score answers a narrow and valuable question: did this suite distinguish the mutations the selected engine generated? It does not establish that the asserted distinction belongs to the product contract, that the test uses a supported surface, that it covers meaningful boundary partitions, or that it will survive a semantics-preserving refactor. The factory therefore needs a **test-legitimacy lane** alongside mutation measurement, not a replacement score folded into mutation percentage.

The first static slice is now present in the Interlinked CLI harness (observed Aug 13):

- The test-file hook ladder is risk-tiered. PreToolUse blocks only introduced, deterministic sabotage/theatre: assertion-free cases, tautologies (including identical literals and constant truthiness), SUT self-mocking, focused tests, and unconditional skips. A separate delta warning detects removed test blocks/assertions.
- Low-noise but context-sensitive checks now coach the writer before the edit lands: duplicate names, real I/O, live clock/RNG, fixed waits, missing SUT imports, SUT self-mocking, mock-only assertions, private-member access, silent dependency skips, and `test_legitimacy`. They remain warnings because a supported compatibility or timing contract can make an individual shape legitimate.
- `test_legitimacy` is therefore a heuristic PreToolUse/`verify --all-checks` advisory, not a `pre_block` rail. PostToolUse retains the broader whole-file review layer, including happy-path-only, introverted assertion flow, conditional-test logic, assertion roulette, subprocess-timeout, and other checks that need more context or carry higher false-positive risk.
- Each case in a mutation-directed JS/TS test file (`*.mutation-kill.*`, `*.mutation-hardening.*`, or `*.survivor(s).*`) must carry an adjacent receipt such as `// test-contract: boundary — parseWindow rejects the documented zero-width interval`.
- Allowed grounding kinds are `public-api`, `invariant`, `bug`, `security`, and `boundary`. A generic statement such as “tests the mutant” is not a contract.
- The same check flags broad `toBeTruthy`/`toBeFalsy` assertions, incidental call-order assertions, and single- or multi-line imports whose names or paths explicitly declare themselves private/internal. Cast-based private-member access is covered by the companion pre-warning. These are review signals because any of them can occasionally be a real public promise.
- Existing checks continue to cover complementary failure modes: no-assertion tests, tautologies, SUT self-mocking, mock-only or introverted assertions, swallowed exceptions, real I/O, live clock/RNG use, missing SUT imports, giant snapshots, and related test smells.
- `mutation survivors --file ...` now tells the test writer to ground each new case before formal remeasurement.

This is deliberately smaller than the complete protocol. It does not yet prove that every newly added ordinary test is grounded, detect copied implementation logic, measure branch partitions, perturb internals, run stability trials, or issue an independent review result. Those require diff-, graph-, runtime-, and agent-aware jobs. The intended machine-readable receipt is one row per test case, bound to the candidate state, with at least:

| Receipt field | Required meaning |
|---|---|
| `testId` and `testHash` | Stable case identity plus exact test content. Renaming or rewriting the case invalidates the receipt. |
| `sourceHash` / overlay hash | Exact product state against which the evidence was gathered. |
| `contract.kind`, `contract.ref`, `contract.summary` | Public behavior, documented invariant, bug report, security property, or boundary condition the case protects. |
| `surface.entrypoints` | Exported CLI/API/UI/protocol surfaces exercised. Any private surface must be justified as a compatibility contract. |
| `observations` | Return value, error, state, filesystem/network effect, event/log, or timing channel asserted. Exact strings name whether they are contractual CLI/help/policy text. |
| `partitions` | Equivalence classes and boundaries exercised, including adjacent `<`, `=`, `>`, malformed, empty, maximum, and failure cases when applicable. |
| `mutationEvidence` | Formal mutant identities killed on a clean run. Hidden from the blinded reviewer, but retained for audit and invalidation. |
| `coverageEvidence` | Branch/condition deltas and the exact coverage artifact/tool fingerprint; line coverage alone is insufficient. |
| `propertyEvidence` / `modelEvidence` | Property, generator/domain, seed/cases, oracle/model identity, observation channels, and result. |
| `stabilityEvidence` | Process boots, orderings, seeds, clock/environment policy, leakage findings, repetitions, and failures. |
| `refactorEvidence` | Semantics-preserving perturbations tried and whether the test remained green. |
| `reviewEvidence` | Blinded verifier identity/version, classification, confidence, findings, and input hashes. |

The receipt is evidence, not author prose that can grant itself a pass. Its executable fields must be produced by the named runner, and every field records invalidation inputs.

#### Verification stack for an authored or strengthened test

| Layer | What the factory checks | Failure meaning / next action |
|---|---|---|
| Contract grounding | The new case maps to an approved behavior/invariant/bug/security/boundary artifact. Exact CLI/help/policy strings are valid contract observations; unpromised internal formatting is not. | Ungrounded cases may remain characterization, but cannot discharge a mutation or release obligation. Ask for a real contract or remove the reward-targeted case. |
| Black-box preference | Import/call graph reaches exported or user-visible surfaces. Flag private-helper imports, copied implementation expressions, oversized snapshots, and assertions on incidental call order. | Rewrite through the public surface. If the internal surface really is supported, declare and own that compatibility promise. |
| Assertion quality | Existing static checks plus runtime dependency tracing reject no-assertion, mock-only, tautological, broad truthiness, swallowed-exception, fixture-restatement, and input-echo assertions. | Assert a precise externally observable value, error, or post-state caused by the SUT. |
| Behavioral coverage | Collect branch and condition coverage, compare the test-diff delta, and reconcile declared input partitions. Boundary-sensitive logic should distinguish adjacent `<`, `=`, and `>` cases plus malformed/failure paths. | Add the missing partition or state why it is outside contract. Executing a line is not enough. |
| Property/metamorphic | Run generated checks for declared invariants such as normalization idempotence, stable ordering, parse/render round trips, monotonicity, permutation invariance, and encode/decode preservation. | Minimize any counterexample into a deterministic regression fixture; no counterexample is search evidence, not proof. |
| Differential/model-based | Compare public observations with a deliberately small independent reference function, state machine, protocol model, prior compatible release, or approved oracle. Do not copy the production algorithm into the oracle. | A divergence is either a product defect, a model defect, or a contract dispute; route it for adjudication instead of silently updating expected output. |
| Hermeticity/stability | Repeat in randomized order and across recorded seeds/process boots; use fake clocks and constrained environment; deny undeclared network, restrict filesystem/process access, and check leaked handles/files/children. | Quarantine as unstable evidence. A flaky case cannot certify a kill even if one run passed. |
| Refactor resistance | Run against controlled semantics-preserving variants: rename private identifiers, reorder independent declarations/calls, and extract/inline private helpers where the transform is qualified. | Failure only under an internal-shape perturbation classifies the assertion as brittle characterization unless that shape is contractual. |
| Independent blinded review | A separate verifier sees the governing contract, public surface/signatures, test diff, and execution receipts, but **not** mutant IDs/replacements, author reasoning, claimed kill count, or desired verdict. | Classify every assertion as `contract`, `useful_characterization`, `brittle_characterization`, or `reward_hack`, with a cited reason. The verifier cannot edit the test it judges. |

The layers are not a point system. A high mutation delta cannot buy off a missing contract, a red original suite, a non-hermetic test, or a reward-hack review. Risk selects how much positive evidence is required: a simple documented formatter may need contract grounding, precise black-box assertions, green formal mutation, and stability; a parser, auth boundary, money calculation, or state machine should additionally require boundary partitions and relevant property/model evidence.

Blinding is an information-flow boundary, not merely a different prompt. The coordinator constructs the reviewer payload from content-addressed artifacts and omits the mutation worklist, replacements, author scratchpad, and claimed outcome. Review output is append-only evidence; a failed review returns work to the writer or escalates a contract dispute. The writer and reviewer may use the same model family, but that is still correlated evidence and must not be described as independent in the statistical sense.

**Holdout evaluation is deferred.** No hidden fault corpus or secret property suite is being added to the repository or customer gate in this tranche. A future holdout should evaluate the Interlinked factory itself in a controlled product lab, separated from customer acceptance and governed so it cannot become an undisclosed source of arbitrary failures. Until that governance and corpus-maintenance model exists, use the visible protocol above plus blinded review and report its limitations honestly.

### Round 0 — Establish trustworthy ground

- Export the exact candidate state to a clean, content-addressed workspace.
- Prove the selected test suite is green before mutation; otherwise failing tests can falsely “kill” everything they touch.
- Pin and record source revision/overlay hash, dependency graph and lockfile, runtime/OS/architecture, mutation engine and version, mutator set, test runner, test-selection algorithm, config, and observation model.
- Record runner health, free disk/memory, concurrency, cache state, timeout policy, and baseline selected-suite duration.
- Generate the survivor worklist from this measurement. Never reuse an unqualified or stale survivor list.

### Round 1 — Agent hardening

- Give the agent exact current mutant IDs, locations, replacements, enclosing-symbol hashes, selected tests, and the governing behavior contract.
- Permit only explicit outcomes: add/strengthen a test; produce a minimized divergence fixture; classify as `dead_code`; attach counterexample-search evidence to `unresolved`; or flag a source bug/contract dispute.
- Treat shadow-runner results and agent receipts as **claims**, even when execution verified. They are useful work products, not manifest authority.
- Require companion tests to import the actual system under test and be discoverable by the same selection mechanism the formal runner will use.
- Require a per-case contract mapping. The writer may see mutant mechanics to find a distinguishing input, but the resulting assertion must be justified by behavior that matters without reference to that mutant.
- Run the static legitimacy checks before paying for formal remeasurement. Static approval does not certify the test; it only rejects inexpensive, obvious anti-patterns early.

### Round 2 — Independent formal remeasurement

- Stop agent writers and confirm no mutant remains applied.
- Remeasure in an isolated clean export with the pinned mutation engine.
- Reconcile stable mutant identity/location/replacement and symbol hash, not just aggregate count.
- Accept a claimed kill only when the formal engine reports it killed against a green suite.
- Persist only conclusive measurements whose source/test hashes still match. Timeout, crash, infrastructure failure, and stale identity remain explicit non-passing states.
- Attach the killed-mutant identities to the test receipt for audit, but do not include them in the blinded-review payload.

### Round 3 — Adversarial residue analysis

For each formal survivor, try the cheapest appropriate mechanism in order: pinned compiler/normalization equivalence, checked rewrite lemma, type/control-flow reasoning with validated runtime origins, complete finite-domain enumeration, relational solver, targeted property/differential search, then fuzzing.

- Any divergence becomes a minimized regression fixture and returns to Round 2.
- No divergence from property/fuzz search is recorded as `unresolved` evidence with seed, cases, budget, strategy, observation model, and hashes.
- A timeout is not equivalence and must not disappear from the denominator/report.

### Round 4 — Disposition and certification

Use typed, non-overlapping outcomes: `killed`, `dead_code`, `proved_equivalent`, `proved_unreachable`, `duplicate`, `outside_contract`, `accepted_risk`, or `unresolved`.

A proof certificate should bind at minimum:

- stable mutant identity and replacement;
- enclosing `sourceSymbolHash`;
- source/overlay and selected-test hashes;
- contract and observation-model hashes;
- verifier identity/version and proof-method artifact;
- runtime/toolchain/environment hash;
- dependency-graph version; and
- creation time plus any expiry/owner required by policy.

Any bound input changing invalidates the certificate. Human approvals for `outside_contract` or `accepted_risk` must refer to an artifact the coding agent cannot manufacture on its own. Security and trust-boundary defenses should normally be kept or resolved through contract/risk policy, not auto-deleted as dead code.

### Round 5 — Integration verification

- Run companion tests, typecheck, lint/format, high-signal security/structure checks, and approved behavior scenarios.
- Collect branch/condition and declared boundary-partition evidence; run the policy-selected property/model jobs, hermetic repeat matrix, and refactor-resistance probes.
- Require a blinded assertion classification for agent-authored mutation tests at the configured risk tier. `brittle_characterization` may be retained as documentation, but `reward_hack` cannot discharge mutation debt.
- Run the full suite at an appropriate idle/CI cadence.
- Enforce mutation completeness and score/debt ratchets only over qualified measurements; show uncovered, timeout, indeterminate, unmeasured, and unresolved residue separately.
- Promote baselines only after the exact candidate state passes.
- Plain `interlinked verify` is primarily a report and does not make every finding a failing process exit; CI must use the intended gating surface (for example, `verify-changeset` where appropriate) or parse the machine-readable result according to policy.

### Round 6 — Scheduled census and invalidation

- Remeasure changed/stale files and maintain a visible unmeasured list.
- Retry timeouts under a controlled larger budget; do not silently relabel them.
- Revalidate certificates whose source, contract, observation model, environment, or dependency inputs changed.
- Publish a residue ledger by disposition, age, owner, risk, and next action.
- Run broader inferential architecture/spec audits at nightly or weekly cadence rather than on every edit.

### Round 7 — Economic validation

- Select representative changes/repositories and measure a before condition.
- Adjudicate and remove only confirmed inert/dead code; retain deliberate defenses.
- Repeat comparable tasks in fresh sessions to limit memory/training effects.
- Compare context/files read, input/output tokens, latency, tool calls, defect escapes, review effort, and verification cost.
- Publish confidence intervals and negative results. The commercial claim becomes credible only if total saved work exceeds adjudication and verification cost.

## Part 6A — Tool-independent local enforcement and transactional limits

The same principle used for mutation evidence applies to editing tools: **tool names are claims; repository effects are evidence.** An agent can write through Edit, `apply_patch`, Bash redirection, a formatter, a generator, or an unfamiliar MCP tool. PreToolUse can inspect a proposed Edit payload, but it cannot generally predict an arbitrary command's eventual writes, subprocesses, network effects, or external side effects.

### Local implementation status (working tree, Aug 13)

The current tranche implements the local portions of the effect path and deliberately does not build the remote product:

1. **Observed filesystem ChangeSet.** Before a potentially mutating tool call, the daemon captures a bounded snapshot of Git-visible tracked and untracked files plus standalone ignored local files such as `.env`, while collapsing known bulk/generated ignored trees. The noisy `.interlinked/` runtime tree stays collapsed, with an exact allowlist for its local configuration/policy controls; those control effects cannot be suppressed through `skip_paths`. PostToolUse compares repository bytes/modes and attaches created, modified, and deleted paths as a canonical `filesystem-observation` ChangeSet. Known read-only tools are exempt; unknown tools are observed by default.
2. **Shared post-write routing.** Edited-path resolution, per-file checks, and the trigram dirty layer prefer the observed ChangeSet over tool-declared paths or shell-command regexes. The generated hook no longer fast-paths successful Bash/unknown writers or short-circuits a declared `skip_paths` match before filesystem reconciliation.
3. **Stop residue backstop.** Stop consumes any unreconciled pre-call snapshot, adds the observed paths to `session.files_written`, runs the ordinary touched-file rescan over them, and emits an `effect-residue` warning. Reconciliation stays rooted at the daemon workspace even when the runner reports a subdirectory `cwd`. This catches dropped PostToolUse delivery; it cannot retroactively undo the command.
4. **Sandbox evidence advisory.** Bash PreToolUse classifies visible evidence as `attested`, `configured`, `disabled`, or `unknown`. Configuration is not mislabeled as per-call attestation. Explicit Codex escalation/`danger-full-access` and Claude unsandboxed settings are visible risks. The warning states that a workspace-write sandbox limits reach but still permits real repository writes.
5. **Supported transaction path.** `interlinked write` and `multi-edit` continue to gate proposed final contents before disk. `write --batch` now preserves existing target modes and restores already-renamed targets if a later rename fails, on a best-effort basis, reporting incomplete rollback. Per-file rename is atomic; a sequence of filesystem renames is not a true multi-file transaction.

This is ordinary-process evidence, not a hostile-process trust boundary. Snapshot windows can overlap other local agents or background formatters, causing conservative extra attribution; very large files use bounded metadata fingerprints and mark the ChangeSet incomplete. The ledger must preserve completeness and attribution confidence rather than silently presenting either as proof.

### Why native agent sandboxing helps but does not solve rollback

Terminal coding agents increasingly expose a sandbox mode, but the relevant default is usually a **writable project boundary**: it constrains filesystem/network reach while allowing writes inside the workspace. That is useful defense-in-depth against host damage and credential/network escape. It is not transaction execution and cannot guarantee undo. Interlinked should therefore:

- require or strongly advise the strictest usable native sandbox for Bash;
- prefer per-call runner attestation over reading static configuration;
- keep deterministic pre-execution blocks for statically recognizable destructive or gate-bypassing commands;
- judge on-disk effects after every potentially mutating call regardless of tool name; and
- route changes requiring pre-disk guarantees through `interlinked write`/`multi-edit` until a true transactional executor exists.

True PreToolUse equivalence for arbitrary Bash requires executing the command in an overlay/copy-on-write workspace, evaluating the resulting ChangeSet, then committing only approved effects. Even that covers filesystem state only: network requests, remote Git operations, databases, processes, devices, credentials, and other external systems need explicit capability denial, mediation, or service-specific transactions. Replaying an approved cloud command locally is not equivalent when OS, dependencies, credentials, paths, or external state differ.

### Deferred Cloudflare product path

Do not build this in the local tranche. For the future remote mutation/verification product, the Cloudflare components fit distinct roles:

| Component | Future role | Important limit |
|---|---|---|
| [Sandbox SDK](https://developers.cloudflare.com/sandbox/) | Run each mutation shard, verifier, or speculative Bash command in an isolated Linux environment; collect command results and a candidate filesystem diff before promotion. | Remote execution is authoritative only for the remote environment; it cannot predict an eventual local command's external effects. Sandbox state is ephemeral across container shutdown unless exported. |
| [Artifacts](https://developers.cloudflare.com/artifacts/) | Content-addressed/versioned repository per baseline, task, agent, or mutation shard; compare and merge accepted outcomes without agents sharing a mutable checkout. | Closed beta as of the evidence review; availability and operational contract must be rechecked before product commitment. |
| [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) | Lazily mount large repos into sandboxes so shards hydrate only the manifests/source/tests they read, reducing clone startup and duplication. | FUSE/blob hydration adds its own performance/failure surface; normal clone remains simpler for small repos. |

A future commit protocol should be: immutable baseline artifact → isolated sandbox/overlay → captured effect and verification receipts → policy decision → content-addressed accepted tree/diff → explicit local apply with drift detection. The remote result must never silently authorize rerunning an arbitrary command on the developer machine.

### Mutation-engine sequencing decision

For the current product, use mature language-specific mutation engines and normalize their reports into Interlinked's engine-neutral ledger. Do not spend the local tranche rebuilding Stryker. A later Interlinked-owned mutation layer may first reproduce a pinned Stryker operator corpus without the runtime dependency, then extend that taxonomy to other languages. “Same regex replacements” is not enough: parity must cover site discovery, exact replacement semantics, invalid/stillborn mutants, source maps/locations, selected-test behavior, and differential verdicts on a frozen corpus.

The eventual per-tool-call form should enumerate only sites in the observed edit's changed symbols/ranges and execute possible mutants in isolated parallel shards during the 30–90 second hook window. Partial completion is explicit residue, never a clean pass. This belongs after native-engine sharding, test selection, receipts, and invalidation are trustworthy; see [`universal-mutation-set.md`](./universal-mutation-set.md).

## Part 7 — Cadence and mutation-latency accounting

The metaharness should match cost and epistemic strength to cadence:

| Cadence | Appropriate work |
|---|---|
| Per edit | Deterministic pre-block rules, types/lint/security, caps, directly affected tests, optional changed-symbol mutation when the budget is tiny and scope is qualified. |
| Deferred 30–60 seconds | Start/harvest affected mutation, property, fuzz, or scenario jobs without blocking the editor on raw wall time. |
| Agent stop | Exact changed-file measurement, companion-test validation, debt reconciliation, approved scenarios, stale-evidence check. |
| Pre-push/CI | Clean checkout/export, affected mutation, behavior scenarios, baseline integrity, machine-readable gate policy. |
| Nightly/weekly | Full/stale census, timeout retries, residue ledger, certificate invalidation, inferential architecture/spec review. |
| Periodic experiment | Harness effectiveness, model-routing comparison, false-positive audit, and economic ROI. |

Raw mutation seconds should not immediately become a shrink-only ratchet. Wall time is confounded by machine class, concurrency/contention, warm versus cold cache, selected-test count, suite duration, mutator set, engine/test-runner versions, and timeout policy.

First report these components:

- mutant count and qualified/unqualified count;
- selected test count and selection strategy;
- baseline duration of the selected suite;
- median and tail duration per mutant or mutant batch;
- timeout/crash/indeterminate fraction;
- cache state and concurrency; and
- an environment/config/toolchain fingerprint.

Only compare latency within the same fingerprint, or normalize into declared budget classes. Robust measures such as medians/percentiles and timeout fraction are safer than one raw elapsed-time number. The value metric should also include time-to-feedback and developer/agent idle time, not merely runner CPU time.

## Part 8 — Economic/commercial hypothesis

The question is whether detecting and removing inert-but-reachable code saves money, especially when agents pay repeatedly to read and reason over it.

- **Best adjacent removal evidence:** the cited Meta study reported incident rate 76%→24% (odds ratio 5.2) and diff time −59%, but for structural dead code, not the target inert category. It is supporting analogy, not direct ROI evidence.
- **Weak/negative adjacent evidence:** the cited Sjøberg controlled study found no human-maintenance effect, and Rahman/Bird found buggy code had lower duplication. These results prevent a simplistic “all redundancy causes bugs” argument.
- **Plausible strong mechanism:** unnecessary code consumes context and creates additional branches/hypotheses for agents and reviewers. But token reduction can also remove useful names/contracts; targeted, adjudicated removal is the hypothesis, not blind minification.
- **Market signal:** the easy static end is commoditized; commercial analysis products sell broader security/compliance/maintainability value; mutation systems generally treat equivalents as scoring noise. Sourcery’s repositioning is a warning against a standalone dead-code product.

**Verdict:** this is an unvalidated opportunity, not a demonstrated business case. Interlinked’s differentiated position would be mutation-revealed hard cases plus proof/disposition evidence, prevention of new accretion, and measurement of AI-operability. The de-risking move is a controlled before/after study using the Round 7 protocol—not a stronger marketing claim.

## Part 9 — SQLite idea

Building an open mutation-checked suite for a bounded SQLite subsystem, then using SQLite as a differential oracle for a rewrite, is on thesis. SQLancer and Turso/limbo demonstrate the value of differential/metamorphic and deterministic-simulation approaches.

The limits remain important: SQLite’s suite is partially open through TCL; proprietary TH3 sells certification/process pedigree that mutation score alone does not reproduce; C needs a non-Stryker mutation stack; and the full engine is far too broad for an initial experiment. The credible framing is a bounded showcase of the verification methodology and Interlinked as the harness around a rewrite, not a TH3 competitor.

## Part 10 — Artifacts and repository-status caveat

| Artifact | Role |
|---|---|
| [`agent-terraforming-checks.md`](./agent-terraforming-checks.md) | Agent-legibility checks: context closure, addressability, regenerability, purity, single-writer ownership, and change locality. |
| [`local-gate-catalog.md`](./local-gate-catalog.md) | Candidate local gates grouped by latency tier. |
| [`equivalent-mutant-handling.md`](./equivalent-mutant-handling.md) | Proof ladder and equivalent-survivor design; some command-surface statements need the corrections recorded here. |
| [`universal-mutation-set.md`](./universal-mutation-set.md) | Deferred Stryker-parity/cross-language mutation taxonomy. Native language engines remain authoritative for the current product tranche. |
| [`harness-engineering.md`](../external-pulse/harness-engineering.md) | Research intake, ranked builds, adversarial verdicts, and appendices. |
| [`INTAKE.md`](../external-pulse/INTAKE.md) | External-pulse intake method and source-depth guidance. |
| [`per-edit-cloud-mutation-testing.md`](./per-edit-cloud-mutation-testing.md) | Per-edit mutation architecture; mutation-latency ratchet should adopt the normalization caveats in Part 7. |
| `scratch/fleet-r2/MORNING-DEFECTS.md` | Sixteen session defects with evidence and proposed fixes; scratch is gitignored and non-portable. |
| [`session-2026-08-11-synthesis.md`](./session-2026-08-11-synthesis.md) | This historical synthesis and later evidence correction. |

The original statement “all staged/uncommitted” is stale. At the Aug 13 review, the three design docs and harness-engineering intake above plus this file were untracked, while `per-edit-cloud-mutation-testing.md` and `INTAKE.md` were modified. Repository status is mutable and belongs in a handoff/`git status`, not as enduring design truth. The pushed guard/CI commits recorded by the session were `15413ef` and `61e04b9`.

## Part 11 — Overall assessment and recommended next decisions

This is a strong research and operational retrospective. Its best contribution is not the raw mutation count or the claim that equivalent mutants are dead code; it is the emerging architecture of **proof-carrying, content-addressed verification with honest residue**.

It is not yet a normative product design because:

- historical, current, and proposed state were previously mixed;
- aggregate mutation claims were stronger than their evidence;
- the disposition types, registered CLI, and verifier/certificate issuer do not yet form an end-to-end workflow;
- runtime/observation boundaries make several proposed “proofs” conditional;
- latency and economic claims need controlled measurement; and
- the podcast/outbound-link research was substantial but not exhaustive.

Recommended decisions, in order:

1. Adopt the Round 0–6 state machine and residue ledger as the canonical mutation workflow.
2. Decide and document stable mutant identity plus the observation-model contract.
3. Register the honest `dead_code`/`unresolved` disposition surface, then separately design the trusted verifier/certificate issuer; do not make prose `accept` the escape hatch.
4. Generate current status tables from the manifest with timestamps, provenance filters, and environment fingerprints.
5. Fix affected-test selection and runner orphan/session-end cleanup before scaling another fleet.
6. Build approved behavior scenarios and recurrence/harness-coverage reporting before adding many more detectors.
7. Run the economic experiment before treating inert-code removal as a product claim.

## Part 12 — Operational notes retained from the session

- The historical subagent model restriction was session-specific and should not be generalized into product architecture.
- A research subagent refused a spoofed “discard your results” coordination message. Treat cross-agent content as untrusted input and keep authority/provenance explicit.
- Piped output truncation hid a real push exit code, and zsh `PIPESTATUS` assumptions failed. Preserve producer exit status and full logs in automation.
- Dogfooding produced useful guard feedback, but anecdotes are not a false-positive rate. Harness coverage and adjudication telemetry should turn these incidents into measured evidence.
- `.interlinked/` and `scratch/fleet-r2/` contain changing campaign state. `scratch/` is gitignored; durable findings need promotion into tracked docs or machine-readable ledgers.
- Never quote a mutation score without freshness, file/symbol inclusion, test scope, engine/mutator versions, environment, and explicit treatment of uncovered, timeout, indeterminate, unresolved, and unmeasured work.
