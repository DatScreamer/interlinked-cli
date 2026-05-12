# Tier 3 — Async Deep Review

**Status:** Designed (2026-05). Not built. Existing `/review` and `/security-review` skills cover the on-demand version; Tier 3 adds auto-invocation on pre-push and integrates the prose-policy evaluation that Tier 1 and Tier 2 can't reach.

**Audience:** Future-you when you build Tier 3 wiring. Companion to `tier-2-llm-policy-gate.md`.

**Companion docs:**
- `docs/design/tier-2-llm-policy-gate.md` — the synchronous LLM gate
- `skills/enforce/SKILL.md` §15.4 — prose.md artifact format
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/feedback_reluctance_to_push.md` — why we don't gate push
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/feedback_ci_failure_is_harness_gap.md` — every red CI is a harness gap
- `skills/security-review/` and `skills/review/` — existing on-demand reviewers (if applicable; pull paths from `interlinked skill list`)

---

## 1. Problem statement

Tier 1 and Tier 2 together handle ~30-70% of distillable skill content (varies by skill shape). The remainder is **prose** — definitions, principles, methodologies, vocabulary discipline, architectural taste — that no synchronous gate can evaluate. Examples from skills already analyzed:

- `disk-forensics` "Document chain of custody for real investigations" — no edit-time signal.
- `improve-codebase-architecture` "Apply the deletion test to anything you suspect is shallow" — methodology, not a gate.
- `improve-codebase-architecture` LANGUAGE.md term definitions — context the agent needs to use vocabulary correctly.
- `recon` Phase 1 passive-recon checklist — methodology.
- `owasp-audit` the entire A01-A10 checklist — what to look for *in the audited code*, not what the agent does.

These are all valuable. The agent has to follow them to do good work. But the deterministic harness can't enforce "did you apply the deletion test?" because the application is mental, not observable.

Tier 3 is the layer that **looks at the agent's work after it's done** and evaluates it against the prose policies. Wide scope (full repo + staged commits + session log), slower model (Sonnet/Opus), less frequent (per push, not per tool call), warn-only output.

## 2. Position in the architecture

```
┌── Tier 1: per-tool-call deterministic ─────────────────┐
│  Regex on tool_input; sub-10ms; block/warn/allow       │
└────────────────────────────────────────────────────────┘
                       │
                       ▼
┌── Tier 2: per-tool-call LLM gate ──────────────────────┐
│  gpt-oss-safeguard on Groq; 3-6s; block/warn/allow     │
│  Trajectory-aware                                      │
└────────────────────────────────────────────────────────┘
                       │
                       ▼
┌── Tier 3: per-push (or on-demand) cloud review ────────┐
│  Claude Sonnet/Opus; 30-120s; warn-only                │
│  Wide scope: full repo + staged commits + session log  │
│  Consumes prose.md from active skills                  │
└────────────────────────────────────────────────────────┘
```

Tier 3 runs **after** the agent's work is committed locally but **before** it's pushed remote. The natural integration point is the git pre-push hook.

## 3. Trigger model

### 3.1 Pre-push hook (primary)

```
$ git push
  │
  ▼ pre-push hook fires
  │
  ▼ interlinked review --staged --auto
  │   ├── identify commit range: @{u}..HEAD
  │   ├── if no commits in range: exit 0 (push proceeds)
  │   ├── load active prose policies from .interlinked/policies/
  │   ├── invoke Tier 3 review with (repo, diff, prose, session log)
  │   ├── write findings to .interlinked/reviews/<range-sha>.md
  │   ├── print summary findings to stderr
  │   └── exit 0  (warn-only — never blocks push per feedback_reluctance_to_push)
  │
  ▼ git push proceeds
```

Critical: Tier 3 **never** blocks push. It writes findings, prints to stderr, exits 0. The user reads the findings and decides whether to act on them — fix locally, address in follow-up, or accept.

### 3.2 On-demand (`/review`, `/security-review`)

Existing skills, unchanged. Tier 3 reuses their prompt templates and pipeline. The difference vs pre-push:
- Scope can be wider (full repo) or narrower (specific paths) per user direction.
- No commit range constraint.
- Results print to the conversation, not to a file.

### 3.3 Scheduled (deferred to v1.1+)

Optional: nightly or on-merge-to-main runs that re-review changes since the last review. Useful for catching architectural drift over time. Not in v1 because it requires infrastructure (cron, CI, etc.) and the pre-push trigger covers most of the value.

## 4. Scope

The review runs against three sources of information:

### 4.1 Staged commit range

Default: `@{u}..HEAD` — commits that exist locally but haven't been pushed to the upstream branch.

If there's no upstream (e.g., fresh local branch): `main..HEAD` (or the project's default branch).

If neither exists: scan the working tree's `git status` (uncommitted changes) plus the most recent commit.

### 4.2 Full repo context

The reviewer agent has read access to the entire repo for cross-reference questions:
- "Does this change introduce a pattern that contradicts the architecture in `docs/design/architecture.md`?"
- "Is this new module shadowing an existing one in a sibling directory?"
- "Does the new dependency conflict with `package.json`?"

This is the leverage Tier 3 has over Tier 2 — full visibility instead of single-trajectory.

### 4.3 Prose policies + session log

For each skill that was active during the session that produced these commits, load:
- `.interlinked/policies/<group>.prose.md` — definitions + principles + methodology checkpoints
- `.interlinked/session-trajectories/<session-id>.jsonl` — the tool-call log (if persisted; see §10)

This is the new content Tier 3 evaluates that Tier 1/2 can't.

## 5. Model selection

| Model | Cost / 1M output | Best for |
|---|---|---|
| Claude Sonnet | mid-tier | Most reviews. Strong code reasoning, good cost. **Default.** |
| Claude Opus | higher | Complex architectural reviews, multi-file refactors. Manual escalation via `--model opus`. |
| Claude Haiku | cheapest | Lint-level checks only; not used for Tier 3 (depth too shallow). |

**Why Claude over gpt-oss-safeguard:** Tier 3 needs general reasoning over code + prose, not policy classification specifically. Claude's longer context window (1M tokens) and code understanding fit the wide-scope task. gpt-oss-safeguard is purpose-built for policy decisions on small inputs; wrong tool for "review a 10-commit branch against an architecture skill."

**Why Sonnet default not Opus:** Most reviews are scoped to a few files. Sonnet handles that at ~1/5 the cost. Opus available for the cases where reasoning depth matters.

## 6. Input format

The reviewer agent's prompt has four sections:

```
┌── SECTION 1: Active prose policies (cached prefix) ─────────────────┐
│                                                                     │
│ The agent that produced these commits had the following skills      │
│ active. Use these policies as the framework for evaluating the      │
│ commits. Cite policy_id when flagging a violation.                  │
│                                                                     │
│ ─── skill:disk-forensics ───                                        │
│ <verbatim skill-disk-forensics.prose.md>                            │
│                                                                     │
│ ─── skill:improve-codebase-architecture ───                         │
│ <verbatim skill-improve-codebase-architecture.prose.md>             │
│                                                                     │
│ ... (all prose policies for skills active during the session)       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
┌── SECTION 2: Session trajectory summary ────────────────────────────┐
│                                                                     │
│ The agent ran ~317 tool calls during this session. Summary:         │
│  - 142 Reads (45% src/, 30% docs/, 25% other)                       │
│  - 89 Edits (61% src/, 22% docs/, 17% test/)                        │
│  - 47 Bash commands (12 npm run test, 8 git, 27 other)              │
│  - 26 Writes (new files: see git status)                            │
│                                                                     │
│ Notable trajectory events:                                          │
│  [step 12] BLOCKED by Tier 1 (rule: prod-env-write)                 │
│  [step 145] WARNED by Tier 2 (policy: P3 hash-before-analysis)      │
│  [step 287] Agent ran `/grill-with-docs` skill                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
┌── SECTION 3: Commit range diff ─────────────────────────────────────┐
│                                                                     │
│ git diff @{u}..HEAD (3 commits, 18 files, +547/-203):               │
│                                                                     │
│ <full diff, possibly truncated at large files; large files          │
│  summarized as "<file>: <N> lines added, <M> deleted">              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
┌── SECTION 4: Review task ───────────────────────────────────────────┐
│                                                                     │
│ Review the commit range against the active prose policies. For      │
│ each finding, output JSON matching:                                  │
│                                                                     │
│ {                                                                   │
│   "findings": [                                                     │
│     {                                                               │
│       "severity": "critical|high|medium|low|info",                  │
│       "policy_id": "<id from prose policies>",                      │
│       "file": "<path>", "lines": "<n>-<m>",                         │
│       "issue": "<one-line summary>",                                │
│       "rationale": "<why this matters; cite policy verbatim>",      │
│       "suggested_remediation": "<concrete next step>"               │
│     }                                                               │
│   ],                                                                │
│   "summary": "<2-3 sentence overall assessment>",                   │
│   "did_session_follow_methodology": true|false,                     │
│   "methodology_notes": "<which steps did/didn't the agent follow>"  │
│ }                                                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 7. Output format

The reviewer's structured JSON output gets serialized to:

### 7.1 Findings file (per review run)

`.interlinked/reviews/<range-sha>.md`:

```markdown
# Tier 3 review: <range-sha>
Range: @{u}..HEAD (3 commits, 18 files, +547/-203)
Date: 2026-05-12T15:42:00Z
Model: claude-sonnet-4-6

## Summary

[2-3 sentence overall assessment]

## Findings (N total)

### [SEVERITY] policy:<id> — <file>:<lines>
**Policy:** <prose policy quote>
**Issue:** <one-line summary>
**Rationale:** <why this matters>
**Remediation:** <concrete suggestion>

---

## Methodology assessment

Did the session follow the skill's prescribed methodology? **Yes/No**

[Notes on which steps the agent followed and which were skipped]

## Did this review affect the push?

No. Tier 3 is warn-only. Push proceeded; findings written here for reference.
```

### 7.2 Stderr summary (printed before push)

```
[interlinked tier-3 review] Range: 3 commits, 18 files
  Findings: 2 high, 1 medium, 3 low
  Full report: .interlinked/reviews/abc1234.md

  HIGH: src/auth/middleware.ts:45 — adapter introduced but no second
        consumer; one-adapter rule (skill:improve-codebase-architecture)
  HIGH: src/db/migrate.ts:12 — schema change without ADR per
        docs/adr/ convention
  MEDIUM: src/api/users.ts:88 — banned vocabulary "service" used in
        architectural comments

Push proceeding (warn-only).
```

### 7.3 Optional: integration with /ultrareview

If `/ultrareview` is invoked manually, it uses the same Tier 3 pipeline with `--model opus` and `--scope full-repo` (or whatever scope the user specifies). Same prompt structure, same output format, longer runtime.

## 8. Cache strategy

Tier 3 reviews are cached by `(commit-range-sha, scope-id, prose-policy-hashes)`:

- **commit-range-sha**: hash of the commit range being reviewed.
- **scope-id**: configuration (e.g., `staged-only`, `full-repo`).
- **prose-policy-hashes**: hash of the concatenated prose.md files at review time.

Cache hits return the existing `.interlinked/reviews/<range-sha>.md` without re-running the LLM. Common cache hit scenarios:
- User runs `git push`, hits pre-push hook → review runs → push fails for network reasons → user retries push → cache hits, no re-review.
- User runs `git push --force` after rewriting history → range-sha changes → cache miss → re-review.
- User adds a new commit → range-sha changes → cache miss → re-review with the larger range.

**Invalidation:** policy files change → invalidate. Model version changes → invalidate. User manually `interlinked review --no-cache` → bypass.

## 9. Cost model

| Review scope | Input tokens | Output tokens | Cost / review (Sonnet) | Cost / review (Opus) |
|---|---|---|---|---|
| Tight (1 commit, 3 files) | ~5K | ~2K | ~$0.03 | ~$0.15 |
| Typical (3-5 commits, 10-20 files) | ~20K | ~3K | ~$0.10 | ~$0.50 |
| Heavy (20+ commits, full-repo scope) | ~150K | ~5K | ~$0.60 | ~$3.00 |

**Frequency:** 1 review per push. A typical dev does 3-10 pushes/day. Daily cost: ~$0.30-$1.00 (Sonnet) for typical-scope reviews. Opus on-demand only.

**Annualized:** ~$60-200/year per dev for Sonnet. Tractable.

**Compared to Tier 2:** Tier 2 is many small calls (~$0.01-0.13/session); Tier 3 is fewer big calls (~$0.10/push). Combined per-dev annual: ~$60-300, dominated by Tier 3 frequency.

## 10. Session log / trajectory persistence

Tier 3's value depends on having the agent's session trajectory available. The harness already records tool calls to memory; for Tier 3, those need to be persisted across the session boundary.

**Plan:** the harness writes a JSONL trajectory file per session at session end:
- Path: `.interlinked/session-trajectories/<session-id>.jsonl`
- Content: one line per tool call, redacted for secrets (same as Tier 2's trajectory format)
- Lifecycle: kept for 30 days, then GC'd by `interlinked maintenance` or similar
- Linked to commits via session_id annotation in commit metadata (TBD how; possibly a git note)

When Tier 3 runs, it finds the session_id(s) associated with the commit range and loads their trajectories. If a commit has no session_id (e.g., human commit), no trajectory section in the prompt — Tier 3 reviews diff + prose policy without the session-log context.

**Open: how does the commit know its session_id?** Options:
- Git note (`git notes add -m "session: <id>"` on each commit during the session)
- Embed in commit trailer (`Interlinked-Session-Id: <id>`)
- Side-table at `.interlinked/commits.jsonl` mapping sha → session_id

Leaning git note — it's mainline git, survives rebase, and `git log --show-notes` displays it inline.

## 11. Integration with existing /review and /security-review

The existing skills are user-invocable, on-demand. Tier 3 reuses their prompt templates with extensions:

- `/review`: code review focused on correctness, design, performance. Tier 3 adds prose-policy evaluation to its scope.
- `/security-review`: security-focused review (auth, input validation, secrets). Same — Tier 3 adds prose-policy evaluation.
- `/ultrareview`: multi-agent comprehensive review. Tier 3 contributes the prose-policy dimension to the existing aggregation.

The reviewer agent's system prompt is augmented with: "If skills are active for the session that produced these commits, evaluate against their prose policies as part of your review." The existing skills' prompts handle the rest.

**Backward compatibility:** existing users of `/review` keep the same behavior. New behavior triggers only when (a) `.interlinked/policies/<group>.prose.md` exists for any active skill, and (b) the session trajectory is available.

## 12. Per-skill prose evaluation pipeline

For each prose.md loaded into the prompt:

1. **Definitions section** → used as vocabulary glossary. The reviewer cites canonical terms in findings; flags banned vocabulary in the diff.
2. **Principles section** → each principle includes a "Tier 3 evaluation" sub-section describing how to apply it (per §15.4 of /enforce SKILL.md). The reviewer applies each principle to the diff and reports per-finding.
3. **Methodology checkpoints** → boolean per-checkpoint outputs ("Did the agent follow X?"). Used in the `did_session_follow_methodology` field of the verdict.
4. **Source** section → ignored at review time; for human cross-reference.

Per-finding cite trail:
```
Finding → policy_id → prose.md section → verbatim source quote → original SKILL.md line range
```

This is the auditability story. Any finding can be traced back to a specific imperative in a specific skill's source markdown.

## 13. Warn-only contract (binding per feedback_reluctance_to_push)

Tier 3 **NEVER blocks push.** Even on critical findings, the push proceeds and the findings get written to disk.

Reasons:
1. Push-gating creates pressure to fast-path around the gate (e.g., `git push --no-verify`).
2. Findings can be wrong (LLM judgment isn't perfect). False-block on push is catastrophic for flow.
3. CI catches things Tier 3 might miss; a final gate exists downstream.
4. Per `feedback_reluctance_to_push`: the harness's job is observability, not enforcement at the push boundary.

**However**: the user can configure `block_on_critical: true` in `.interlinked/config.local.json` for their own discipline. Default off. This is opt-in only.

## 14. Failure modes

| Failure | Detection | Handler |
|---|---|---|
| Claude API unreachable | fetch error | Skip Tier 3, write `<range-sha>.skipped.md` with reason, push proceeds. |
| API rate limit | response 429 | Back off, retry once with delay. If still failing: skip. |
| LLM timeout (>120s) | hard timeout | Skip, log to `.interlinked/policy-misses.jsonl`. |
| Prose policy load error | file read error | Skip that policy, continue with others. Don't fail the whole review. |
| Session trajectory missing | no file at expected path | Run review without trajectory section; note absence in findings. |
| Cache file corrupt | parse error | Treat as cache miss; re-review; overwrite cache. |

All paths fail-open (no push blocking).

## 15. Integration with verify and ultrareview

Existing `interlinked verify` runs deterministic checks across the working tree. Tier 3 complements it:
- `verify` = deterministic, fast, runs in CI / pre-commit
- Tier 3 = LLM-based, slow, runs in pre-push or on-demand

`/ultrareview` is the comprehensive sibling: spins up multiple specialist agents in the cloud. Tier 3 contributes prose-policy evaluation as one of those specialists. Implementation: when `/ultrareview` runs, it includes Tier 3 in its fan-out, and the Tier 3 findings appear in the ultrareview aggregated report.

## 16. Open decisions

1. **Where does the session_id live?** Git note vs commit trailer vs side-table. Leaning git note.

2. **Auto-invoke on `git push` or require explicit opt-in?** Pre-push hook is auto; user opts in by installing the hook. The `interlinked enable` command should offer Tier 3 hook installation as part of the wizard.

3. **Cross-session reviews.** Should Tier 3 see prior reviews of the same files when reviewing new commits? "Last time you reviewed this module, you flagged X. The new commits don't address X." Useful for tracking unresolved findings.
   - Leaning: yes, but optional. v1.1.

4. **Tier 3 model selection per active skill.** Could let skills declare a preferred model (`prose.md` frontmatter `tier_3_model: opus`). Most skills don't care; some (architectural review) benefit from Opus.
   - Leaning: per-skill override available, default Sonnet.

5. **Findings TTL.** How long do `.interlinked/reviews/<range-sha>.md` files live? Forever (audit trail) or GC'd?
   - Leaning: keep 30 days, then move to `.interlinked/reviews/archive/` with compression.

6. **Branch-level vs commit-level review.** Current design reviews the commit range as one unit. Alternative: review each commit separately and aggregate. Per-commit is more granular but ~Nx more expensive.
   - Leaning: range-level. Per-commit available via `interlinked review --per-commit`.

7. **Pre-push review for force-pushes.** `git push --force` rewrites history. Should Tier 3 re-review the new range?
   - Leaning: yes — `range-sha` changes, cache misses, fresh review runs.

8. **Pre-push review when CI will also run.** If the project has CI that runs `/security-review` post-merge, Tier 3 pre-push is redundant for some teams.
   - Leaning: still run Tier 3 pre-push — the value is local fast feedback, not gating. Users who don't want it disable via config.

9. **Multi-runner sessions.** A user might use Claude Code, then switch to Cursor for the same task. The session ID changes; multiple session trajectories should aggregate into one review.
   - Leaning: detect via "commits in this range have different session_ids" and load all relevant trajectories.

10. **Privacy: what about secrets in trajectories?** The harness already redacts secrets at trajectory-build time, but full file contents (per the `tool_input.content` field on FileWrite) might contain sensitive code.
    - Leaning: Tier 3 uses the same redaction as Tier 2's trajectory builder. Plus the diff itself contains the same content the user is about to push publicly, so the privacy floor is already established by the push action.

11. **Tier 3 in CI.** Run Tier 3 as a CI check on PRs?
    - Leaning: yes, as opt-in. `interlinked review --ci` mode that outputs GitHub-flavored markdown for PR comments.

12. **Tier 3 for non-skill prose.** What about prose in regular doc files (e.g., `docs/architecture.md`)? Should Tier 3 evaluate against those too?
    - Leaning: only if explicitly added as prose-policy in `.interlinked/policies/` via `/enforce <path>`. Random docs shouldn't auto-become enforcement targets.

---

## Implementation order

When you sit down to build Tier 3:

1. **Session trajectory persistence.** Without this, Tier 3 has no insight into how the agent worked. Build first.
2. **Commit ↔ session linkage.** Git notes (or whichever mechanism wins) so Tier 3 can find the trajectory for a commit range.
3. **`interlinked review --staged` command.** No LLM yet; just the data-gathering pipeline (diff + trajectory + prose policies). Validate the inputs look right.
4. **Cloud reviewer wiring.** Hook up Anthropic API, structured output, cache layer. Run on a small set of test commits.
5. **Pre-push hook installation.** Add to `interlinked enable` wizard. Default off; user opts in.
6. **Calibration.** Run for a week against your own pushes. Measure: false-positive rate per skill, useful-finding rate, latency budget.
7. **Tier 2 integration.** Ensure Tier 3 sees Tier 2 verdicts in the trajectory (so it doesn't re-flag things Tier 2 already warned about).
8. **CI mode (`--ci`).** GitHub-flavored output for PR comments. Optional CI integration.

**Pre-requisites not built yet:**
- Session trajectory persistence (the harness records to memory, doesn't yet write to disk per-session)
- Commit-to-session linkage (git notes or alternative)
- The `interlinked review` command (currently `/review` is a slash-skill, not a CLI command — needs surface for auto-invocation)
- Anthropic API integration (Claude Sonnet — straightforward, no blockers)

None of these block prototyping with hand-built inputs. They block GA.
