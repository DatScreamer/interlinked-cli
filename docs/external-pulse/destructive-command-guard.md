# destructive_command_guard (dcg)

- **Source:** https://github.com/Dicklesworthstone/destructive_command_guard (Jeffrey Emanuel)
- **Encountered:** 2026-06-12, user-directed evaluation ("anything from the past 3 months worth adapting?")
- **Verdict:** PR (compound — adopt mechanisms + taxonomy, reimplemented independently; **no verbatim ports** — see license)

## 1. Core idea (one sentence, your words)

A compiled Rust PreToolUse deny-gate for AI-agent shell commands: ~800 destructive patterns across 25 categories (git/fs/cloud/db/SaaS), evaluated through a span-classifying shell parser (code vs data vs heredoc-body) with per-segment safe-pattern carve-outs, a layered allowlist, and a hard fail-open deadline (~200 ms) — hooked into 7+ agents (Claude Code, Codex, Gemini, Copilot, Grok, Hermes, Pi).

## 2. Anatomy (concrete walkthrough)

~179k lines Rust, 1,721 commits (born 2026-01-07; 524 commits in the last 3 months — this thing is moving fast). Load-bearing files:

- `src/packs/` — 797 `destructive_pattern!` macro entries in 86 files / 25 categories (compiled in, no data files). Each carries severity, reason, long-form recovery explanation, and `PatternSuggestion[]` safer alternatives (e.g. push-force suggests `--force-with-lease --force-if-includes` + a preview-fetch command).
- `src/evaluator.rs` — pipeline: block-list → allow-list → inspection-wrapper exemption → heredoc tiers → AC-keyword quick-reject → span classification → wrapper normalization (sudo/env/command, ≤32 iterations) → per-pack safe-then-destructive matching **per command segment**.
- `src/packs/mod.rs::split_command_segments` — quote/subshell-aware split on `; | || && &`; a safe-pattern match excuses *only its own segment* (closed a real bypass: `railway service list && railway volume delete --yes` was allowed because the safe pattern matched the compound).
- `src/heredoc.rs` — three tiers: RegexSet trigger → bounded extraction → ast-grep on the body. Distinguishes executing sinks (`bash <<EOF`, `python3 -`) from data sinks (`cat`, `tee`, `git commit -F -`), masking only the latter; target resolution bounded to the heredoc's own physical line (soundness fix, #136).
- `tests/corpus/` — 320 TOML cases: `true_positives/` (17), `false_positives/` (152 — **5× the positives**), `bypass_attempts/` (44: sudo/env wrappers, `python -u -c`, obfuscation), `edge_cases/` (quoting, multi-segment, unicode, ReDoS). `canonical.toml` is an explicitly cross-harness golden corpus (`schema_version = 1`).

One eval: hook JSON in → agent protocol detected → command segmented → spans classified → `git push --force` matches `core.git:push-force-long` → exit 1 + JSON `{permissionDecision: "deny", ruleId, severity, remediation}`; Codex gets the stderr/exit-2 variant.

Last-3-months delta (the new stuff): bounded regex walkers `(?:[^\s&;|`()<>]+\s+)*` replacing `(?:\S+\s+)*` so patterns can't span shell boundaries (#121/#124); per-segment safe-pattern gating; heredoc data-sink masking saga (#136); PowerShell `-Command` descent (#125); inspection-wrapper exemption with tail-metacharacter guard, later hardened against bare-redirect tails (#132); Grok/Hermes protocol support + Pi recipe; Modal pack; history FTS (FrankenSQLite); `dcg scan` → SARIF + GitHub Action.

## 3. Deterministic or agentic?

Fully deterministic — regex (`regex` + `fancy_regex`) + ast-grep structural matching; no model anywhere; per-tier µs/ms budgets with a 200 ms deadline that fails **open**. **License: MIT with an "OpenAI/Anthropic Rider" — not plain MIT.** The rider voids all license grants to OpenAI, Anthropic, their affiliates, and anyone acting on their behalf. Treat lane-3 code-borrow AND verbatim corpus translation as blocked for this repo; ideas, mechanisms, and taxonomy reimplemented independently are fine (and individual shell commands like `git reset --hard` are unprotectable facts — what we must not copy is their expression: pattern source, prose, case selection/arrangement).

## 3b. Role in its native architecture — and does it transfer?

Native role: *the* security boundary for agent shell execution — but deliberately fail-open (200 ms deadline, `DCG_BYPASS=1`, HMAC allow-once codes with 24 h TTL), so really a high-recall tripwire, not a trust boundary. That matches our stance exactly (`feedback_local_checks_not_a_trust_boundary`, `feedback_safety_continuity`). In our topology the role is already occupied by the 116-rule guard in the daemon + inline cold fallback; dcg content transfers as **hardening of an existing boundary**, not a new layer. Their multi-agent protocol dispatch overlaps our `CLIENT_INSTALL_REGISTRY`; their Codex `unified_exec` PreToolUse gap note and Grok/Hermes wire shapes are useful reference data for ours.

## 4. Substrate vs. surface

Substrate: span-classified shell parsing (segmentation, quoting, wrapper stripping, heredoc target resolution), the bounded-walker regex discipline, and the corpus/QA harness (FP-majority corpus, repro-by-issue files, meta-tests, CI test-count sentinel ≥3700, 11 fuzz targets). Surface: the `dcg` binary, per-agent adapters, history FTS, `dcg scan`/Action. The substrate concepts are borrowable without touching the binary.

## 5. Lane (1–6)

**2 (detection technique)** for the mechanisms — bounded walkers, per-segment safe-pattern gating, data-sink masking, inspection-wrapper exemption with tail-metachar guard; **plus 4 (pattern)** for the QA conventions (FP-majority corpus, repro-by-issue, golden isomorphism, test-count sentinel). Their 797-rule breadth is lane-2 *inspiration* only (rider blocks porting; we author our own).

## 6. Dependency & displacement

- **Deps:** zero if reimplemented in TS (regex + small pure functions). Skip their binary (license + we already own this hook point). Skip ast-grep tier — our heredoc needs are coverable by regex + line-bounded target resolution; escalate to AST only if FP data demands it.
- **Displacement:** overlaps `src/harness/rules/builtin-rules*.ts` (116 rules / 197 patterns) and the inline cold fallback. Nothing else displaced — history⇄`activity.jsonl`+recurrence, scan⇄`recurrence scan` (theirs adds CI-file extractors: workflow YAML / Dockerfile `RUN` / Makefile — a real gap of ours).
- **Equivalence:** core git/fs destructive rules — **shipped**, but ~40/197 of our patterns use boundary-spanning walkers (`.*` ×37, `(?:\S+\s+)*` ×3): today `builtin-git-clone-into-tree` FP-blocked a `git clone <url> /tmp/dcg && …` twice because `.*` walked across `&&` (fixed same session); our stash rule false-fires on `git diff && echo 'git stash drop'`. Segment-bounded matching — **absent**. Data-vs-code span classification — **absent** (we'd block `echo 'git reset --hard'`). Safe-variant carve-outs — **partial** (we have `--force(?!-with-lease)`; no tmpdir-safe `rm -rf` carve-outs, no combined-short-flag `-uf` coverage). Platform packs — **partial** (~60 platform patterns vs their ~700; we lack secrets/feature-flag/email/search/monitoring SaaS coverage entirely). FP-majority corpus + repro-by-issue + fuzz — **absent** (we have per-rule vitest + parity test; `fast-check` already in-repo makes property tests cheap). Allow-once HMAC bypass codes — **absent** (we have env-var bypass + `disabled_rules`).

## 7. Smallest spike

One day: (a) author `src/harness/rules/__tests__/guard-corpus.test.ts` + a JSON corpus in their four-bucket taxonomy (own-written cases, ~80 seeds: the clone FP, stash-via-echo FP, segment bypasses, wrapper prefixes, tmpdir-safe rms), run every case through the real evaluator; (b) fix the walker defects it exposes by introducing a shared `SEGMENT_BOUNDED_WALKER` regex fragment constant and converting the worst offenders. Started today: the clone-rule fix + its first regression tests are this spike's seed.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Corpus harness + bounded-walker conversion + per-segment safe-pattern eval; then own-authored high-value rules (tmpdir-safe rm carve-outs, combined short flags, secrets/SaaS deletes); CI-file scan extractors for `recurrence scan` | §7 | now |
| Agent CI (P4–5) | Their `scan --git-diff` → SARIF → PR-comment shape as reference for our Tier-3 review output format | re-read `action/action.yml` when building | parked |

## 9. Artifact

PR. Compound verdict: **adopt** the four mechanisms (bounded walkers, segment-scoped safe patterns, data-sink masking for heredocs, inspection-wrapper tail guard) and the QA taxonomy (FP-majority corpus, repro-by-issue, test-count sentinel) — all independently reimplemented; **reject** verbatim ports of patterns/corpus/prose (license rider) and the binary-integration path; **skip** history FTS, shell completions, allow-once HMAC (nice UX, not now).

### What shipped (2026-06-12, uncommitted on main)

Mechanisms:
- **Span classifier upgrade** (`evaluator/spans.ts`): heredoc bodies masked only when the line-bounded receiving command is a known data sink (`cat`/`tee`/`git commit -F -`…); interpreter inline-exec payloads (`bash -c '…'`, `python -u -c "…"`, `pwsh -Command`) reclassified `inline_code` so `executed_only` rules still scan them. New `HEREDOC_DATA_SINKS`, `resolveHeredocTarget`, recall-first inline-exec detector.
- **Span-aware `decomposeCommand`** + broadened trigger (`/[;&|\n]/`, was `&&`/`||`/`;` only): newline/pipe/background compounds now decompose, closing the `safe --dry-run\nreal` cross-segment-negate bypass. Atomic regions (quotes, inline-code, heredoc bodies) never split.
- **Inspection-wrapper exemption** (`evaluator/inspection-wrapper.ts`): hardened `evaluateMetaTestWrapper` — the old prefix-only test blanket-allowed `interlinked harness test "x" && rm -rf /` (chained tail ran unguarded; a real bypass found by dogfooding). Strict tail guard: prefix + one inert argument, any chain/redirect/substitution tail disqualifies.
- **Bounded walkers + `executed_only`** on `git push --force` (×2: block rule + temporal), `stash drop|clear`, `checkout -- `, `git add -i`; added bundled-short-flag force coverage (`-uf`/`-fq`); **added `executed_only`** to `rm-rf-root`, `git reset --hard`, `git clean -f` (they fired on quoted/heredoc mentions — real FPs found by the corpus). `builtin-rules-temporal.ts` extracted to hold the 800-line cap.
- **`file-dump-guard` first-command-group bounding**: the live `head … "295 lines"` misreport — a trailing `sed -n '295,350p'` leaked its `-n 295` onto a leading `head` across `;`. Now bounded to the first command group.

Surfaces:
- **Guard corpus** (`__tests__/guard-corpus.test.ts`): 69 cases in five buckets (true_positive / false_positive-majority / bypass_attempt / edge_case / known_gap) run through the real evaluator, with FP-majority + count-sentinel + unique-id meta-assertions. Surfaced 3 real FP-class bugs (reset-hard/clean-f/rm-rf-root masking) and 2 documented gaps (bare-URL clone, `$()`-in-double-quotes masking).
- **CI-file command extractors** (`ci-command-extractor.ts` + `scanCIFilesForRecurrences`): workflow `run:` / Dockerfile `RUN` / Makefile recipes → guard rules → `codebase_existing` recurrences. The `dcg scan` surface, wired into `interlinked recurrence scan`.

Full suite green (17990 passed). Not committed (awaiting per-turn authorization).

## Notes

- Convergent evolution, same week-class: their #124 ("bound the walker to a single command") is byte-for-byte the bug our clone rule exhibited today. Their honest `KNOWN LIMITATION` comment (git.rs ~309) concedes regex alone cannot fix quoted-argument FPs — full fix needs pre-regex tokenization. That's the ceiling for our regex rules too; segment splitting buys most of the value for a fraction of a tokenizer.
- The rider irony: a guard built to protect Claude Code sessions licenses-out Anthropic itself. The rider targets the companies, not their users; our repo still treats it as a hard no-copy line.
- Their fail-open + bypass-escape-hatch posture (deadline, `DCG_BYPASS`, allow-once) is a second independent witness for our safety-continuity stance.
- Related intakes: `sondera-coding-agent-hooks.md` (Rust hook gate, LLM-classifier variant), `failproofai.md` (deterministic policy competitor), `railway-agent-incident.md` (we built the Railway pack from the same post-mortem they did).
- Worth re-checking in ~3 months: their pre-regex shell tokenizer (announced direction), Codex `unified_exec` gap closure, whether packs externalize to data files (would make independent reimplementation comparisons easier).
