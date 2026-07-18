1. [severity: high] [src/harness/spec/extract-refs.ts:135] The Markdown-link regex has quadratic behavior on malformed link-heavy lines, allowing a small document edit to stall hook processing.
   Evidence: `extractAnchorLinks(["[".repeat(80_000)], new Set())` took approximately 9.6 seconds.
   Why: Every unmatched `[` starts another scan across the remaining line. This violates the subsystem’s sub-800 ms hot-path budget.

2. [severity: high] [src/harness/spec/extract-misc.ts:128] The declared-fact regex exhibits quadratic behavior when many opening markers lack closing markers.
   Evidence: `extractDeclaredFacts(["<!-- fact:x -->".repeat(8_000)])` took approximately 570 ms, with runtime quadrupling as input doubled.
   Why: Each potential opener retries `(.*?)` across the remaining suffix. A valid-sized Markdown file can therefore stall PreToolUse and PostToolUse for seconds.

3. [severity: high] [src/harness/spec/ledger.ts:357] Declared-fact drift construction allocates quadratic output by repeating an all-sites summary in one finding per site.
   Evidence: For N alternating `<!-- fact:x -->0|1<!-- /fact:x -->` markers, `summary` is O(N) and lines 358–365 create N messages each containing that summary.
   Why: A sub-2 MB document can force gigabytes of transient strings before downstream warning caps apply.

4. [severity: high] [src/commands/findings.ts:53] Distinct unanchored findings with the same first six statement words receive the same ID and silently overwrite one another.
   Evidence: `The API must define retry behavior for writes.` and `The API must define retry behavior for reads.` ingested under one reviewer both materialize as the same `review_the_api_must_define_retry_behavior-…` ID.
   Why: No file anchor or raw-content hash distinguishes their provenance, and the unique `url` is not part of identity.

5. [severity: high] [src/harness/server/spec-ledger-phase.ts:118] The daemon ledger has no invalidation or removal path for out-of-band edits and single-file deletions, leaving stale facts indefinitely.
   Evidence: Build with A=B=`fact:x=1`, externally change B to `2`, then edit prose in A; the phase refreshes only A and reports no drift. Calling the phase for deleted `GONE.md` likewise leaves `factsOf("GONE.md")` defined.
   Why: There is no mtime/hash freshness check, and a read failure reaches the outer catch without calling `removeFile`.

6. [severity: medium] [src/commands/findings.ts:66] Review ingestion appends with `recordFinding` instead of merging with `upsertFinding`, discarding earlier reviewer provenance at an existing ID.
   Evidence: Ingesting the same anchored finding as reviewers A then B materializes `source_runners: ["B"]` and `times_observed: 1`.
   Why: Corpus loading is last-write-wins, so the second one-provenance row replaces rather than merges the first.

7. [severity: medium] [src/harness/spec/review-ingest.ts:66] `cleanStatement` unwraps the `[file:line]` tag instead of removing it, making strict-format bug classes path-specific.
   Evidence: `1. [high] [src/a.ts:21] Four-digit IDs fail.` parses with statement `src/a.ts:21 Four-digit IDs fail.`
   Why: `statementSlug` then incorporates the path into `bug_class`, preventing recurrence grouping of the same defect across different sites.

8. [severity: medium] [src/harness/spec/review-ingest.ts:26] Any indented numbered line inside a finding body is misparsed as a new top-level finding.
   Evidence: `1. [high] [a.ts:1] Defect.\n Evidence:\n 1. first case\n 2. second case\nTOTAL: 1` produces three findings.
   Why: The start regex accepts arbitrary leading whitespace and requires no severity or anchor, truncating the real finding and inventing unknown-severity rows.

9. [severity: medium] [src/harness/spec/reconciliation.ts:57] Semantically malformed reconciliation transactions are accepted and unknown actions are treated as touches.
   Evidence: `{"finding_id":"F1","action":"garbage","by":42}` loads as state `"touched"`.
   Why: The parser checks only truthiness of `finding_id` and `action`; `applyTxn` treats every action other than `reopened` or `acked` as `touched`, falsely closing findings.

10. [severity: medium] [src/harness/spec/reconciliation.ts:33] Appending after a torn JSONL tail loses the newly appended reconciliation transaction.
   Evidence: A file ending with `{"trunc` becomes `{"trunc{"finding_id":"F1","action":"acked",...}\n` after the next append.
   Why: The new transaction is concatenated onto the malformed line and skipped during replay, so an acknowledged finding remains open despite the CLI reporting success.

11. [severity: medium] [src/harness/server/review-reconcile-phase.ts:219] Read-side reconciliation ignores `event.cwd` and always queries state under the daemon process’s current directory.
   Evidence: With `process.cwd()=/repo-a` and a Read event carrying `cwd=/repo-b`, the scanner loads `/repo-a/.interlinked/findings` and misses `/repo-b` findings.
   Why: Harness events explicitly carry their workspace root; the test masks this by calling `process.chdir(cwd)` first.

12. [severity: medium] [src/harness/server/review-reconcile-phase.ts:73] Reconciliation path keys are lexical rather than realpath-canonical, so symlink aliases never match ingested finding paths.
   Evidence: A finding stored as `docs/plan.md` is not touched or warned when the same file is edited through `/repo/alias/plan.md` where `alias -> docs`.
   Why: `toRel` returns `alias/plan.md`, while finding comparison requires exact equality with `docs/plan.md`.

13. [severity: medium] [src/harness/server/spec-ledger-phase.ts:57] Ledger keys are also lexical, causing edits through in-root symlink aliases to create duplicate stale entries.
   Evidence: If `alias -> docs`, an edit to `/repo/alias/a.md` refreshes `alias/a.md` while the walked ledger retains `docs/a.md`.
   Why: Realpath-safe containment admits the edit, but `toLedgerPath` does not canonicalize it; stale and fresh facts can then conflict with themselves.

14. [severity: medium] [src/harness/server/spec-ledger-phase.ts:151] Drift findings beyond the display caps neither enter recurrence nor reliably resurface at Stop despite the overflow message promising they will.
   Evidence: Results are limited to `findings.slice(0, 5)` and the Stop source is `all.slice(0, 10)`, while the warning says all remaining findings “resurface at Stop.”
   Why: With more than ten findings, later entries are absent from both `allCheckResults` and `spec_drift_outstanding`.

15. [severity: medium] [src/harness/server/spec-ledger-phase.ts:119] Multi-file prerefresh is followed by redundant per-file refreshes that invalidate ledger memos and recompute all repository drift once per edited Markdown file.
   Evidence: `prerefreshSpecLedger` refreshes every path, then each `runSpecLedgerPhase` calls `refreshFile` again and immediately runs `computeDrift()`.
   Why: `refreshFile` always increments the ledger version, so the supposedly idempotent second refresh invalidates census and binding caches; an M-file patch incurs M full-ledger passes.

16. [severity: medium] [src/harness/evaluator/spec-pre-gates.ts:142] Introduced-drift comparison uses full human-readable messages, so merely shifting an existing finding’s line number is reported as newly introduced drift.
   Evidence: Prepending a blank line changes `"Four bets" (readme.md:1) ...` to `"Four bets" (readme.md:2) ...`, making the set comparison treat the unchanged defect as new.
   Why: Finding identity needs stable structural fields rather than provenance-bearing display text.

17. [severity: medium] [src/harness/evaluator/spec-pre-gates.ts:73] Conflicting duplicate declared markers introduced within one file bypass the sole pre-block-grade spec gate.
   Evidence: Adding `<!-- fact:solo -->one<!-- /fact:solo --> <!-- fact:solo -->two<!-- /fact:solo -->` to a file with no external `solo` marker returns no `ask`, only duplicate heuristic warnings.
   Why: `declaredFactValuesElsewhere` excludes the whole edited file, although the ledger’s agreement contract applies everywhere the same name appears.

18. [severity: medium] [src/harness/spec/ledger.ts:411] Existing Markdown targets omitted by the bounded walk are deterministically reported as nonexistent.
   Evidence: A ledger containing `[guide](./vendor/guide.md)` reports `xref_missing_file` even when the injected `fileExists` returns true for the existing target.
   Why: Markdown targets absent from the map bypass filesystem checking; excluded directories, depth-skipped files, and symlinked Markdown therefore become false positives.

19. [severity: medium] [src/harness/spec/ledger-drift.ts:62] Global noun bindings compare every claim against every namespace ever bound to that noun, creating cross-file false positives for ordinary shared nouns.
   Evidence: A correct “Three phases” W1–W3 document plus a correct “Four phases” P1–P4 document produces two count-drift findings, each against the other registry.
   Why: The merged `phase` binding is ambiguous, but the loop treats both namespace keys as applicable to both claims.

20. [severity: medium] [src/harness/checks/spec-structure.ts:189] Range validation discards notation style and checks only the upper endpoint, producing both false positives and false negatives.
   Evidence: With W1–W3 and W-1–W-2, `W1 through W3` is falsely compared to W-2; `FG-INV-05 through FG-INV-20` passes against a census spanning 1–20.
   Why: Prefix-only lookup cannot distinguish compact from dashed namespaces, and `claim.from` is never validated.

21. [severity: medium] [src/harness/spec/extract-facts.ts:34] Count and range claims inside fenced examples are extracted despite the orchestrator’s stated fenced-prose exclusion.
   Evidence: ```` ```text\nSix bets: B1 B2 B3 B4 B5 B6 B7. FG-INV-01 through FG-INV-02.\n``` ```` yields both a `CountClaim` and a `RangeClaim`.
   Why: These claims feed registered count and ledger checks, so illustrative code or quoted specimens can create real drift warnings.

22. [severity: medium] [src/harness/spec/extract-misc.ts:14] Common fenced blocks with spaced info strings are parsed backwards, exposing code as prose and suppressing real prose after the closer.
   Evidence: For ```` ```ts title="demo"\ncode\n```\n# Real heading ````, the opener is ignored and the closing ``` starts an unterminated fence.
   Why: CommonMark permits an info string beyond one non-whitespace token, but `FENCE_RE` captures only `\S*`.

23. [severity: medium] [src/harness/spec/extract-refs.ts:24] Heading extraction slugs Markdown source rather than rendered heading text and omits Setext headings, falsely declaring valid anchors dangling.
   Evidence: `# [Install](https://example.com)\n[go](#install)` and `Title\n=====\n[go](#title)` both produce missing-anchor warnings.
   Why: GitHub anchors these rendered headings as `install` and `title`; the registered anchor check is labeled fully deterministic.

24. [severity: medium] [src/harness/checks/spec-structure.ts:73] Qualified references to sections in external documents are still treated as same-file dangling references.
   Evidence: A file with headings 1–3 and `See Section 7 of RFC 1234.` emits `Section 7 — no §7 heading in this file`.
   Why: Once the local numbered-heading threshold is reached, no target-document qualifier is considered, contradicting the checker’s own suggested qualification remedy.

25. [severity: medium] [src/harness/checks/spec-structure.ts:261] The advertised present-tense path-existence check has no production caller or registration.
   Evidence: Normal PostToolUse and verify processing of `The full \`invariants.toml\` exists in-repo.` emits no `spec_path_ref`; only direct unit-test calls invoke `checkSpecPathRef`.
   Why: Spike 3 is marked shipped, but the detector cannot fire outside tests.

26. [severity: medium] [src/harness/checks/spec-pitfalls.ts:107] Pitfall matching ignores negation and fenced/quoted context, warning on text that explicitly rejects the pitfall.
   Evidence: `Exactly-once delivery to an external sink is impossible; we only promise retry.` triggers `exactly_once_external`, as does the same sentence inside a fence.
   Why: Same-line co-occurrence is checked before any general negation or prose-boundary handling, making the curated warning repeat claims the author already made correctly.

27. [severity: medium] [src/harness/checks/spec-pitfalls.ts:151] The registered claim-tag nudge reimplements and drifts from `extractClaimSentences`, missing supported verbs while scanning fenced examples.
   Evidence: An opted-in file containing `This path is zero-copy and lock-free.` produces no warning, while a fenced `This guarantees ...` line does.
   Why: `zero-copy`, `lock-free`, and `wait-free` exist in the substrate regex but not this duplicate regex, and no fenced-line set is applied.

28. [severity: medium] [src/harness/checks/spec-quantities.ts:33] Capacity checking considers only the first bit field and applies mitigation words across the entire line, hiding later unaddressed fields.
   Evidence: `We widen the 16-bit request counter to 64 bits; the 8-bit generation counter is reused without a wrap policy.` returns no finding.
   Why: `BIT_FIELD_RE.exec` selects 16-bit, then the unrelated `widen` suppresses the whole line before the 8-bit field is examined.

29. [severity: medium] [src/harness/checks/spec-quantities.ts:53] Naively splitting table rows on every pipe makes the fully deterministic sum check false-positive on valid escaped pipes.
   Evidence: In `| a | x \| 999 | 10 |`, `| b | plain | 20 |`, `| Total | | 30 |`, the checker reports a sum of 1019 instead of the correct 30.
   Why: Escaped pipes and pipes inside code spans must remain within their cells; the current parser shifts columns.

30. [severity: medium] [src/harness/spec/review-agenda.ts:35] The shipped contract-template agenda omits the design’s required identifier template entirely.
   Evidence: A greater-than-400-character `## Object identifier` section with no uniqueness, collision, truncation, or reuse contract yields no coverage-gap item.
   Why: Spike 10 explicitly requires identifier coverage, but `KIND_TEMPLATES` substitutes `crypto-keys` and contains no identifier entry.

31. [severity: medium] [src/harness/spec/review-agenda.ts:202] Agenda generation fails in a fresh repository because the output directory is never created.
   Evidence: Running `interlinked spec agenda` in a directory containing `PLAN.md` but no `.interlinked/` throws `ENOENT` for `.interlinked/review-agenda.md`.
   Why: Both agenda tests pre-create the directory, masking the first-contact command failure.

32. [severity: medium] [src/harness/spec/code-invariants.ts:29] Invariant extraction regexes raw lines without lexical or fence awareness, turning strings, comments, and examples into policy entries.
   Evidence: `const docs = "call assert(x) here";` becomes an assertion, `"// INVARIANT: only prose"` becomes an invariant comment, and fenced Markdown `MUST` prose becomes doctrine.
   Why: Generated taxonomies can therefore contain rules that source code never asserts.

33. [severity: medium] [src/harness/spec/assembly-score.ts:12] Assembly scoring is not wired into any production detector, ranking, threshold, or agenda despite claiming to rank and gate findings.
   Evidence: The file says scores “RANK and GATE findings from other detectors,” but only `assembly-score.test.ts` imports its exports; production agendas return insertion-ordered compose checks, gaps, and drift.
   Why: The advertised spike-14 false-positive control has no runtime effect, and its tests validate only isolated arithmetic.

34. [severity: medium] [src/harness/large-file-policy.ts:383] The capped nearest-ancestor fallback does not actually fail closed on real, non-symlinked roots.
   Evidence: `isInsideRoot(process.cwd(), process.cwd() + "/" + "a/".repeat(300) + "x.ts")` returns `true` once the ancestor cap is exceeded.
   Why: The fallback returns the original lexical absolute path, which still prefix-matches a canonical root; an over-deep path beneath an in-root symlink can therefore be misclassified.

35. [severity: low] [src/harness/server/review-reconcile-phase.ts:43] The round-2 cache repair can still serve stale findings because its signature uses only `mtimeMs`.
   Evidence: Replacing corpus contents while preserving both state files’ mtimes leaves `openReviewFindings` returning the prior cached array.
   Why: Coarse-timestamp or timestamp-preserving filesystems can perform real external ingests or acknowledgements without changing this signature; size/inode or content metadata is also needed.

36. [severity: low] [src/harness/server/review-reconcile-phase.ts:82] Once-per-session reconciliation guards grow without bound for the daemon lifetime.
   Evidence: `touchRecorded` and `warned` are module-level `Set`s whose only `.clear()` calls are inside `resetReviewReconcileCacheForTesting`.
   Why: Long-running daemons accumulate one string per touched finding and warned file/session; events missing a session ID also share `"unknown"` and can suppress later sessions permanently.

37. [severity: low] [src/harness/checks/spec-structure.ts:114] The design-promised duplicate-heading branch of `spec_numbering` is absent.
   Evidence: `checkSpecNumbering("## Setup\nA\n## Setup\nB", "x.md")` returns `[]`.
   Why: The implementation loops only over ID namespaces, while the cited check contract explicitly lists duplicate headings as renumber residue.

38. [severity: low] [src/harness/evaluator/complexity-pulse.ts:240] The cyclomatic-cap repair is applied only to the formatter API and not to the production event path.
   Evidence: `pulseForFile` calls `formatComplexityPulse(display, beforeFns, afterFns)` without `maxCyclomaticFor(cwd)`, leaving the default cap of 25 in effect.
   Why: A repository configured for cap 10 still receives cap-25 telemetry; the new test passes only because it calls the formatter directly with `10`.

TOTAL: 38