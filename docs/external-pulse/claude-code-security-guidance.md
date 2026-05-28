# Claude Code "security-guidance" plugin — Anthropic-shipped three-tier hook plugin

- **Source:** https://code.claude.com/docs/en/security-guidance ; plugin source at https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance
- **Encountered:** 2026-05-26, user pasted the URL + `@INTAKE.md` pointer in an interlinked-cli session, asking how to apply the design to interlinked's harness for first-time codebases.
- **Verdict:** PR (per-edit pattern parity audit + catastrophic-backtracking validator + user-scope rule lookup) + memory crossreference (validates [[project_three_tier_policy_enforcement]] — Anthropic ships the same three-tier shape).

## 1. Core idea (one sentence, my words)

A three-layer security plugin for Claude Code that runs a deterministic regex match per file edit, a background LLM diff-review per turn, and a deeper codebase-aware LLM review per commit — none of which block — deployed entirely through the same hook events interlinked uses, so it is a shipped vendor canonical of the [[project_three_tier_policy_enforcement]] shape.

## 2. Anatomy

Prose docs source plus an open-source plugin repo. Six load-bearing claims and one architectural choice:

1. **Three review layers, three depths, three hook events.** Per-edit pattern (PostToolUse on Edit/Write/NotebookEdit, no model call) → per-turn diff review (Stop event, background LLM call against a captured `UserPromptSubmit` baseline) → per-commit deep review (PostToolUse on Bash, filtered to `git commit`/`git push`, agentic LLM with Read access to callers, sanitizers, related files). All three layers are advisory; none block writes or commits.

2. **The reviewer is a separate Claude instance with fresh context.** The end-of-turn and commit reviews are not the writing model grading itself — they are separate Claude calls with a security-focused prompt starting from the diff. The page's own framing: "the reviewer starts from the diff, has no investment in the original approach, and is instructed only to find problems." Echoes [[project_supervisor_pattern]] detection/decision split. Cost: per-edit layer is free; per-turn and per-commit each spend model usage; default model Opus 4.7, override via `SECURITY_REVIEW_MODEL` / `SG_AGENTIC_MODEL`.

3. **Three lookup scopes for user rules.** `~/.claude/claude-security-guidance.md` (user) + `.claude/claude-security-guidance.md` (project, committed) + `.claude/claude-security-guidance.local.md` (project, gitignored). All loaded and concatenated; combined cap 8 KB. Same three-scope shape applies to `security-patterns.{yaml,yml,json}`. Admins can ship org-wide rules by pushing the user-scope file via device management.

4. **Per-edit pattern list is a small set of fixed-cost categories.** Dynamic code execution (`eval(`, `new Function`, `os.system`, `child_process.exec`); unsafe deserialization (`pickle`); DOM injection (`dangerouslySetInnerHTML`, `.innerHTML =`, `document.write`); GitHub workflow file edits (under `.github/workflows/`, which can grant repo-level permissions). Substrings or regex; up to 50 custom rules; "skips regexes that look prone to catastrophic backtracking."

5. **Rate limits and dedup discipline.** Per-edit warnings fire once per pattern per file per session (so re-edits do not flood the conversation). End-of-turn reviews cover ≤30 changed files per turn and fire at most three times in a row before yielding back to the user. Commit/push reviews are capped at 20 per rolling hour.

6. **Per-layer disable via env var.** `ENABLE_PATTERN_RULES=0`, `ENABLE_STOP_REVIEW=0`, `ENABLE_COMMIT_REVIEW=0`, `ENABLE_CODE_SECURITY_REVIEW=0` (kill all model layers), `SECURITY_GUIDANCE_DISABLE=1` (kill everything). Plus `/plugin disable` and per-project override semantics that write to `.claude/settings.local.json` rather than the checked-in file.

The defining architectural choice — **"none of the layers block writes or commits"** — is the deliberate opposite of interlinked Tier 1 (which DOES block on hard imperatives). Both stances are defensible: theirs is universal defense-in-depth that does not gate; ours is opinionated taste enforcement ([[feedback_taste_enforcement]]) on a smaller, fully-deterministic surface. Surface for the rationale audit; not a flaw.

## 3. Deterministic or agentic?

Hybrid, layered: layer 1 deterministic (substring/regex, no model in the loop); layers 2 + 3 agentic (Claude calls with diff or codebase reads). Per [[feedback_harness_deterministic_only]], only layer 1 is CLI-eligible; layers 2 + 3 auto-route to Guardrails / Agent CI. License: docs page is Anthropic proprietary; plugin source repo is on Anthropic's public GitHub, expected permissive but verify before any code-borrow. Patterns can be borrowed as data regardless of license.

## 4. Substrate vs. surface

The substrate is two-part: (a) the three-tier hook architecture, (b) the three-scope (user / project / project-local) rule lookup with size cap and rule-count cap. The surface is "security review." Both substrates apply to any review domain — quality, taste, license, supply-chain — not just security. The page is explicit that "the plugin is built entirely on hooks": no novel framework, only a thoughtful arrangement of the same lifecycle events interlinked already hooks.

## 5. Lane (1–6)

Multi-lane:

- **Lane 4 (pattern, primary)** — the three-tier shape + three-scope lookup + rate-limit and dedup discipline. Validates [[project_three_tier_policy_enforcement]]; no new design beat, but a small machinery list.
- **Lane 2 (detection technique)** — the per-edit pattern list. Audit against `src/harness/checks/` for any patterns we are missing; port what is not covered.
- **Lane 3 (substrate)** — the catastrophic-backtracking-regex skip; the per-pattern-per-file-per-session dedup primitive; the user-scope rule path. These are *machinery* improvements, not detectors.
- **Lane 5 (cloud-only fodder)** — per-turn LLM diff review and per-commit deep review; already designed in [[project_llm_policy_enforcement]] (Tier 2) and `docs/design/tier-3-async-deep-review.md` (Tier 3). The plugin validates choices already made there.

## 6. Dependency & displacement

- **Deps:** plugin runtime is Python 3.8+ (environmental, not npm). We do not import anything — we borrow patterns as data and the rate-limit / dedup / disable-switch discipline as policy. **Zero new npm runtime dep.** Even the per-turn and per-commit review designs already documented in Tier 2/3 design memos do not import the plugin; they reimplement.
- **Displacement:**
  - Per-edit pattern check overlaps `src/harness/checks/*` (eval/exec, XSS, secrets). Audit + port for any gaps; see §7.
  - Per-turn diff review overlaps our Stop-event reflection helpers (`commit-cadence.ts`, `verification-stop-checks.ts`) — but ours are deterministic-only by [[project_posttooluse_stays_sync]] + [[feedback_harness_deterministic_only]]; their model-backed version is exactly [[project_llm_policy_enforcement]] Tier 2 that we have already designed but not built.
  - Per-commit deep review overlaps our Tier 3 roadmap (`docs/design/tier-3-async-deep-review.md`).
  - Three-scope lookup overlaps our two-tier (`config.json` + `config.local.json`) — they have a *third* `~/.claude/` user-scope. **Gap.**
  - Rate limiting and dedup discipline has no clear analog in our PostToolUse pipeline. **Gap.**

## 7. Smallest spike

≤1 day, three independent PR-sized chunks:

1. **Per-edit pattern parity audit.** Grep `src/harness/checks/*` for each plugin pattern category; the likely gaps (verify in the audit) are `pickle` / `pickle.loads` (Python unsafe deserialization), edits to `.github/workflows/` (workflow privilege escalation), and raw `.innerHTML =` outside React contexts. Each missing pattern is a small detector entry in `src/harness/checks/<family>.ts` + registry entry per the CLAUDE.md cookbook (`entries-warnings.ts` + `check-metadata.ts`). Ships with ≥3 positive and ≥3 negative cases per check.

2. **Catastrophic-backtracking validator on user-supplied regex.** A 20-line guard at the load boundary in `rules-loader.ts` (and the `/enforce` distillation pipeline) that rejects patterns matching the canonical nested-quantifier shapes — `(a+)+`, `(a*)*`, `(a|a)+`, alternations over overlapping ranges. The plugin uses the same heuristic; we are unprotected today when a `/enforce`-distilled rule ingests a hostile or unlucky regex from an unfamiliar repo's AGENTS.md.

3. **User-scope rule lookup.** Add `~/.interlinked/distilled-rules.json` and `~/.interlinked/guard-rules.json` as additional load points in `rules-loader.ts`, merged below project rules in precedence (project rules win on conflict). Solves the consultant/freelancer case where personal rules port across client repos. Shape is taken straight from the plugin's three-scope lookup. The precedence spec is the slightly larger part of this PR.

§7 (1) and (2) are PR-able in a single session; (3) is the slightly larger one because of precedence semantics — write the small precedence spec into the PR description.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Pattern parity, catastrophic-backtracking validator, user-scope rule lookup, dedup discipline on PostToolUse warnings | §7 (1)(2)(3) | now |
| Guardrails (P2–3) | Per-turn LLM diff classifier already in [[project_llm_policy_enforcement]]; plugin validates the "separate-Claude-with-fresh-context" choice and the 30-files-per-turn cap | looser — Tier 2 design exists | next |
| Agent CI (P4–5) | Per-commit deep review already designed; plugin validates the "20-per-rolling-hour" rate-limit shape and the review-independence principle | looser — Tier 3 design exists | parked |

## 9. Artifact

**PR** for the three §7 items (pattern parity + catastrophic-backtracking validator + user-scope path), plus a small PostToolUse dedup primitive if the verification probe confirms the gap. **Memory crossreference** to [[project_three_tier_policy_enforcement]] noting Anthropic ships the same three-tier shape — confirms the framing without changing the design.

## Notes

- **The three-tier shape is now ≥4-source.** Our [[project_three_tier_policy_enforcement]] design, Sondera's two-product split with Cedar + LLM classifier ([[reference_sondera_products_two_repos]]), FailproofAI's stop-event workflow gates (`failproofai.md`), and now Anthropic's own security-guidance plugin all converge on the per-edit-deterministic + per-turn-LLM + per-commit-deep shape. This is the corpus's strongest pattern crossing yet; the design is the emerging shape of "agent harness," not ours alone.

- **"The reviewer is a separate Claude instance with fresh context."** Sharpens the LLM-classifier framing in [[project_llm_policy_enforcement]] and the supervisor split in [[project_supervisor_pattern]]. Practical implication for our Tier 2 build: do not hand the classifier the writing agent's context; give it the diff only.

- **"None of the layers block" is the deliberate opposite of our Tier 1.** Both stances are defensible. Theirs is universal defense-in-depth that does not trip first-time users; ours is opinionated taste enforcement that catches invariants the writing model is not asked to find. Splitting the wider Tier 2/3 design from Tier 1's stance is correct; flag for awareness in the [[project_three_tier_policy_enforcement]] note.

- **Dedup-once-per-pattern-per-file-per-session.** Verification probe pending; if we currently re-warn on every edit of the same finding, we train agents to ignore warnings — exactly the failure mode the plugin engineers around. Likely concrete first-time-user UX gap.

- **Per-layer disable env vars are themselves a first-time-user feature.** Letting `INTERLINKED_DISABLE_POSTTOOLUSE=1` (or per-tier equivalents) exist as a kill switch without uninstalling would let new adopters preview the harness in audit-mode for a day before flipping enforcement on. Cf. their `SECURITY_GUIDANCE_DISABLE=1`. Pairs with the verdict in `failproofai.md` and the broader "first-day adoption" thread.

- **PostToolUse-stays-sync rule still holds.** Per [[project_posttooluse_stays_sync]], we do not move our PostToolUse to async. The plugin's per-turn diff review fires on `Stop`, not `PostToolUse`, so it does not violate this rule — it is a Stop-event reflection, the same channel `verification-stop-checks.ts` uses. The asynchronous-LLM design is at the Stop and commit boundaries, not the per-edit boundary; matches our split.

- **Plugin is open source and 100% hooks.** `github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance` — worth reading the exact pattern list and the catastrophic-backtracking detector before writing the §7 PRs.

- **Workflow-file edit detection is a defense category interlinked is silent on.** Edits under `.github/workflows/` can grant repository-level permissions to an action; an agent edit there is a privilege-escalation primitive. The plugin warns; we should at minimum mirror.

## Methodology notes

- **First Anthropic-shipped reference implementation of the three-tier framing.** Previous intakes (`failproofai.md`, [[reference_sondera_products_two_repos]]) gave us the design pattern; this intake gives us the *canonical implementation* by the same vendor we hook into. INTAKE.md note worth folding back at the next revision: when the upstream vendor ships an implementation of a pattern we already designed, the intake's job is to (a) record the validation, (b) extract any *small* machinery deltas (rate limits, dedup, per-layer disable) the design memos did not specify, and (c) audit the detection list for parity. The validation alone is not a PR; the machinery deltas and parity gaps are.

- **First-time-codebase UX is the lens that surfaces the machinery deltas.** Reading the plugin as an evaluation of interlinked's design for *known* repos misses the point; reading it as "what would let interlinked run cleanly in a repo it has never seen" surfaces the user-scope rule path, the rate-limit/dedup discipline, the per-layer disable env vars, and the catastrophic-backtracking validator — none of which are about the *checks themselves*, all of which are about the harness behaving sanely on first contact.
