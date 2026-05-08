# Hook & Rule Conflict Detection

**Status:** Design / not yet implementation. Composes with: `harness-active-when-scoping.md` (scope tightens the conflict surface), `skills/enforce/SKILL.md` (§10 conflict_merge resolves precedence; this doc adds structural overlap detection on top), `harness/types.ts` (`GuardRule`), `harness/rules-loader.ts` (where rules are merged at boot).

**Scope:** Defines a deterministic detector that flags when two or more rules — built-in, hand-curated, or distilled — would behaviorally conflict. Specifies the four conflict kinds, the two detection windows we wire (distill-time + load-time; per-call runtime is deferred), the structural-overlap algorithm, the report schema, and the agent/user surfaces. Does **not** address semantic conflicts that need LLM judgment — that's a v2.

**Audience:** Engineers touching `harness/rules-loader.ts`, `harness/structure/`, `skills/enforce/SKILL.md`, the `interlinked verify` and `interlinked harness status` commands, and anyone reasoning about why a particular rule did or didn't fire.

---

## TL;DR

Today, two rules can silently disagree. The harness picks the strictest action per `(trigger, tool_match, patterns)` match and surfaces one reason; the user has no signal that a second rule fired with a different action, or that one rule strictly subsumes another. With the active_when work landing, distilled rules from multiple SKILL.md sources can pile up faster than precedence resolution can keep them coherent. The Matt Pocock TDD audit was the canonical proof: his `tdd/SKILL.md` says "ask the user which behaviors to test before writing tests" while our `tdd_new_file_gate` blocks every new `.ts` file. Both rules apparently authoritative. Both behaviorally incompatible. The harness silently took the stricter action; the human had to discover the conflict by reading code.

This doc adds a deterministic conflict detector. **Distill-time** (in /enforce) catches new rules whose domain overlaps existing rules with disagreeing actions. **Load-time** (in `rules-loader.ts`) recomputes the full conflict matrix after merge and writes `.interlinked/rule-conflicts.json` for `interlinked verify` and `interlinked harness status` to surface. Per-call runtime detection is intentionally deferred — the agent already sees the strictest action, marginal value doesn't justify per-call cost.

Three conflict kinds are detected structurally: **strict subsumption** (A's domain ⊆ B's, actions differ), **partial overlap** (domains intersect, actions differ), **duplicate domain** (identical `(trigger, tool_match, patterns)`, different actions or sources). A fourth — **semantic conflict** — is acknowledged and punted to a later LLM-aided pass.

Active_when shrinks the conflict surface: rules with disjoint scope are not conflicts. The detector computes overlap modulo scope. Importing 50 skill rules without scope yields O(N²) conflicts; with `active_when.skill` populated, conflicts only arise within the same scope or against always-on rules. This is the second-order argument for active_when — not just correctness, also auditability.

---

## 1. Why this matters now

### 1.1 The Matt-TDD discovery

We audited Matt's `tdd/SKILL.md` against our harness's TDD enforcement (`evaluator/tdd-new-file-gate.ts`, `behavioral-checks.ts`, `server-tdd-cycle.ts`). Two real conflicts:

- **Strictness mismatch.** Matt's rule asks the user which behaviors to test; ours blocks every `.ts` file without a companion test in `enforce` mode. If both shipped, our gate would silently shadow Matt's — same pre-condition, stricter action.
- **Anti-pattern coverage gap.** Matt's headline rule ("DO NOT write all tests first, then all implementation") is not enforceable in our current `tdd_cycles` machinery — we key off `impl_edits_before_test` per file, not "wrote N test files in K steps without intervening source." Distilling Matt's rule would emit a regex that doesn't match the harness's view of the world.

Both kinds need detection: the first is structural (we'd catch it), the second is semantic (we won't catch it in v1; flag for human review).

The TDD case is now resolved by skipping TDD-themed skills in `/enforce` (see `skills/enforce/SKILL.md` §2d). But the same pattern recurs across other domain pairs (review-checklist skills vs built-in code-review behaviors, ship-skill commit hygiene vs harness git-guard rules, etc.). Without a detector, every such pair has to be discovered by audit.

### 1.2 What the harness already does (and doesn't)

`evaluator/rule-matching.ts` uses OR-on-positive, AND-on-negated semantics (§6). When two rules independently match the same call, the call site iterates rules in order and returns on the first `block`/`ask`. The harness picks the *first matching* strict action, not the strictest across all matches — so rule iteration order can hide conflicts. Today's mitigations:

- `/enforce` §10 conflict_merge: precedence-based merge at distill time, only for rules from different source files. Tracks the loser in `overridden_sources[]`.
- `rules-loader.ts` `disabled_rules`: explicit user disable wins over any rule.
- Built-in vs custom: built-ins load first; custom rules append.

None of this catches structural overlap. None tells the user "these two rules disagree."

---

## 2. The four conflict kinds

### 2.1 Structural (v1 — detected)

**A. Strict subsumption.** Rule A's evaluation domain is a subset of rule B's, AND `A.action` ≠ `B.action`. The narrower rule is shadowed if the broader rule fires first or has a stricter action; if the narrower rule has the stricter action, every call that triggers it also triggers the broader (which then loses on action). Either way, one rule is doing nothing useful.

> Example: built-in `tdd_new_file_gate` blocks every new `.ts` file. A distilled rule "ask before creating new test files" with `tool_match: ["Write"]`, `pattern: file_path ~ /\.test\.ts$/`, `action: ask` is strictly subsumed (every test file IS a `.ts` file). The narrower rule never fires — block wins.

**B. Partial overlap.** Neither rule's domain is a subset of the other, but they intersect, and actions disagree on the intersection. Common case is two pattern lists sharing one anchor token but otherwise distinct.

> Example: rule A: `command ~ /^git\s+push\b/, action: ask`. Rule B: `command ~ /^git\s+push.*main\b/, action: block`. B is strictly subsumed. But change A to `command ~ /^git\s+(push|merge)\b/`: A and B intersect on push-to-main, disjoint elsewhere, actions disagree on the intersection.

**C. Duplicate domain.** Identical `(trigger, tool_match, patterns_normalized)` from two different sources, with different actions OR different reasons OR different severities. The harness picks first-match-wins; the second rule is invisible.

> Example: distilling the same imperative from `CLAUDE.md` and `gstack-full-CLAUDE.md` (a CLAUDE.md fragment for orchestrator injection) yields two identical-domain rules. Both load. Only one ever fires. The other clutters `distilled-rules.json` and confuses `/enforce list`.

### 2.2 Semantic (v2 — punted)

**D. Behaviorally incompatible despite disjoint domains.** Two rules are about the same domain semantically, but their patterns don't structurally overlap.

> Example: Matt's TDD prose advises light-touch test selection; our `test_first_mode = enforce` is a default-on broad gate. The patterns are disjoint (Matt's rule is about user dialogue; ours is about file creation). Detecting this requires an LLM that reads both rules' prose and decides "these conflict in spirit."

V1 does not detect (D). It flags rules in the same `category` or sharing a `group_id` prefix as **review candidates** — not conflicts, just "you have multiple imperatives in this domain, eyeball them." That handles the audit-driven case without committing to LLM dependency.

---

## 3. Detection windows

| Window | When | Output | Goal |
|---|---|---|---|
| **Distill-time** | inside `/enforce` after rule-build, before write | `distilled-rules.json` `conflicts[]` field (existing, extended) | Catch conflicts the moment a rule is created. Refuse to ship distilled rules that strictly subsume a built-in unless the user opts in. |
| **Load-time** | inside `rules-loader.ts` after merging built-in + custom + distilled + overrides | `.interlinked/rule-conflicts.json` (new file, written each load) | Compute the full conflict matrix; surface it via `interlinked harness status` and `interlinked verify`. Keep it idempotent — same rules in, same report out. |
| **Per-call runtime** | inside `evaluator/pre-tool.ts` when a rule fires | optional `also_matched: [{rule_id, action}]` field on `HarnessDecision` | **Deferred to v2.** The agent already sees the strictest action; marginal information value doesn't justify the per-call evaluation cost. Reconsider if usage data shows agents misunderstanding decisions. |

Distill-time and load-time both run on every rule-set change; they're idempotent and cheap (O(N²) on rule count, with N typically <500 even after aggressive distillation, completing in single-digit ms).

---

## 4. Computing structural overlap deterministically

Regex containment is undecidable in general. The detector uses a four-case ladder that handles >95% of real-world conflicts cheaply, leaving the rest to a "near-duplicate, human-review" tag. **Default-skip when uncertain.**

### 4.1 Step 1 — trigger and tool_match comparison

Two rules cannot conflict if:
- Their `trigger` values disagree and neither is `"both"` (PreToolUse rule cannot conflict with PostToolUse rule on the same call).
- Their `tool_match` sets are disjoint (rule on `Edit` cannot conflict with rule on `Bash`).

Compute `triggerOverlap = a.trigger === b.trigger || a.trigger === "both" || b.trigger === "both"` and `toolOverlap = setIntersection(a.tool_match, b.tool_match) || a.tool_match.includes("*") || b.tool_match.includes("*")`. If either is false, exit — no conflict.

### 4.2 Step 2 — pattern field grouping

Conflicts on different fields are not conflicts. A rule on `command` cannot conflict with a rule on `file_path` even if both target Bash — they look at different parts of the input. Group each rule's patterns by `field`. Compare only same-field pairs.

### 4.3 Step 3 — pattern skeleton normalization

For each pattern, compute a *skeleton* — a canonical string for fast comparison:

1. Strip leading/trailing whitespace flag noise (`(?i)`, `(?m)`).
2. Normalize whitespace classes: `\s+` → `\s+`, `[ \t]+` → `\s+`.
3. Anchor normalization: leading `^` kept; word boundaries `\b` kept; group anchors `(^|\/)` collapsed.
4. Extract literal anchor tokens — runs of literal characters between metacharacters. Example: `^git\s+push\b.*\bmain\b` → literal tokens `["git", "push", "main"]`.

Two patterns with **identical skeletons** are treated as the same domain. Patterns sharing **all literal anchor tokens** with no contradicting differences are treated as overlapping. Patterns sharing only one literal token (e.g., both contain `git`) are flagged at low confidence as "review candidates" but not asserted conflicts.

### 4.4 Step 4 — action disagreement check

If the rules pass steps 1–3 and have different `action` values per the partial order `block` > `ask` > `soft_block` > `rewrite` > `warn`, **conflict confirmed**. Annotate with the disagreement direction.

Actions can also "disagree" in non-strict ways: same action, different `severity`, different `reason` text, different `suggestion`. These get a separate `kind: "soft_disagreement"` tag — not blocking, just noise to the user reading rationale strings.

### 4.5 Active_when modulo

Two rules with disjoint `active_when` axes do not conflict. Compute scope intersection per axis:

- `skill`: set intersection of arrays. `["tdd"] ∩ ["ship"] = ∅` → no conflict.
- `phase`: equal-or-empty. Different `phase.value` → disjoint.
- `after_command`: incomputable for arbitrary regex; conservatively assume overlap.
- `file_scope`: pattern overlap via the same skeleton machinery.
- `overlay`, `agent_source`: set intersection of arrays.

If any axis intersection is empty, the rules are scope-disjoint and the conflict is dropped. If all axes either intersect or are absent, the conflict stands.

A rule with no `active_when` (always-on) intersects with anything — its scope is the whole space.

### 4.6 What's not detected (v1)

- **Regex containment beyond literal-token equality.** `^git\s+push\b` vs `^git\s+(push|pull)\b` — the first is contained in the second, but our skeleton machinery doesn't model alternation containment. Falls into "near-duplicate, human-review."
- **Negate-pattern interaction.** `negate: true` patterns are exceptions; modeling their interaction across rules is exponential. Conservatively, two rules with overlapping positive patterns are flagged regardless of their negate sets — the user resolves by reviewing the actual rule text.
- **Cross-field correlation.** "Rule A applies when both `command` and `cwd` look a certain way" vs "Rule B applies when only `command` matches." If A's positive patterns are a strict subset of B's, A is subsumed; that's caught. Cross-field AND-style scopes aren't.

These are explicit gaps. The "review candidate" tag covers them.

---

## 5. Conflict-report schema

Single output artifact: `.interlinked/rule-conflicts.json`. Distill-time annotations also land in `distilled-rules.json` `conflicts[]` (existing field, extended).

```json
{
  "version": 1,
  "computed_at": "2026-04-30T18:30:00Z",
  "computed_by": "harness:rules-loader@1",
  "rule_set_hash": "sha256:abc123…",
  "stats": {
    "rules_total": 142,
    "rules_built_in": 77,
    "rules_distilled": 58,
    "rules_curated": 7,
    "conflicts_strict_subsumption": 2,
    "conflicts_partial_overlap": 1,
    "conflicts_duplicate_domain": 3,
    "review_candidates": 4
  },
  "conflicts": [
    {
      "kind": "strict_subsumption",
      "confidence": "high",
      "rules": [
        { "id": "tdd_new_file_gate", "source": "built-in", "action": "block", "severity": "high" },
        { "id": "enforce-skill-tdd-ask-which-behaviors", "source": "skill:tdd", "action": "ask", "severity": "medium" }
      ],
      "trigger": "PreToolUse",
      "tool_match_overlap": ["Write", "Edit", "MultiEdit", "apply_patch"],
      "shared_skeleton": { "field": "file_path", "literal_tokens": [".ts", ".tsx"] },
      "winning": "tdd_new_file_gate",
      "winning_reason": "broader domain (every .ts file) AND stricter action (block beats ask)",
      "scope_intersection": { "skill": null },
      "fix_options": [
        "/enforce disable enforce-skill-tdd-ask-which-behaviors  (recommended; harness already enforces TDD natively)",
        "Edit guard-rules.local.json to relax test_first_mode if you want lighter-touch enforcement",
        "Accept (the shadow is intentional)"
      ]
    },
    {
      "kind": "duplicate_domain",
      "confidence": "high",
      "rules": [
        { "id": "enforce-local-claude-md-no-force-push", "source": "local:CLAUDE.md", "action": "block", "severity": "critical" },
        { "id": "enforce-openclaw-claude-md-no-force-push", "source": "local:openclaw/gstack-full-CLAUDE.md", "action": "block", "severity": "critical" }
      ],
      "trigger": "PreToolUse",
      "tool_match_overlap": ["Bash"],
      "shared_skeleton": { "field": "command", "literal_tokens": ["git", "push", "force"] },
      "winning": "enforce-local-claude-md-no-force-push",
      "winning_reason": "first-match-wins iteration order; both rules have identical effect",
      "scope_intersection": { "skill": null },
      "fix_options": [
        "/enforce remove --source local:openclaw/gstack-full-CLAUDE.md  (CLAUDE.md fragment, redundant with main CLAUDE.md)",
        "Add openclaw/*-CLAUDE.md to /enforce §2d skip list  (recommended — see harness-active-when-scoping.md follow-ups)"
      ]
    }
  ],
  "review_candidates": [
    {
      "kind": "shared_category",
      "category": "distilled-from-md",
      "subcategory": "review-checklist",
      "rule_ids": ["enforce-skill-review-...", "enforce-skill-review-...", "enforce-skill-review-..."],
      "rationale": "Multiple rules from the same review-checklist source. Likely fine, but worth eyeballing for semantic redundancy."
    }
  ]
}
```

The `fix_options` array is opinionated — it surfaces concrete CLI commands the user can run, not generic prose. Each entry is a one-liner; the recommended option is marked with `(recommended; …)`.

### 5.1 Distilled-rules.json extension

`distilled-rules.json` already has `conflicts[]` for precedence merges (per /enforce §8). Extend it with the new `kind` values from this doc:

```json
"conflicts": [
  // existing precedence-based entries...
  {
    "kind": "structural_subsumption",
    "rules": ["enforce-skill-tdd-ask-which-behaviors"],
    "subsumed_by": "tdd_new_file_gate (built-in)",
    "action_at_distill_time": "emitted with note in distilled_action_reason"
  }
]
```

The distill-time detector also has access to source provenance (`source.file`, `source.lines`, `source.quote`), which the load-time detector does not — so distill-time reports are richer per-rule. Load-time reports are richer cross-rule.

---

## 6. Surface integration

Three integration points:

### 6.1 `interlinked harness status`

Add a "Rule conflicts" section after the existing "Rules loaded" section:

```
Rules loaded:        142 (77 built-in + 58 distilled + 7 curated)
Rule conflicts:      6  (2 strict, 1 partial, 3 duplicate)
Review candidates:   4  (cross-source semantic review)
                     Run `interlinked harness conflicts` for details.
```

### 6.2 `interlinked harness conflicts` (new subcommand)

Pretty-prints `.interlinked/rule-conflicts.json` with grouped conflicts and color-coded fix options. Optional `--json` for machine-readable output. Optional `--rule <id>` to filter to one rule's conflicts.

### 6.3 `interlinked verify`

Add a `--conflicts` flag (advisory by default — surfaces but does not gate). When `--all-checks` is passed, conflicts elevate to advisory findings in the verify report.

### 6.4 `/enforce list`

Add a Conflicts column to the source-grouped output:

```
Source                              Rules  Block  Ask  Advisory  Disabled  Conflicts
local:AGENTS.md                       8      5     1        2          0          0
local:CLAUDE.md                       5      2     1        2          1          1
gh:mattpocock/skills/tdd              0      0     0        0          0          —  (skipped per §2d)
skill:migrate-to-shoehorn             1      1     0        0          0          0
```

Skipped sources show `—` in the Conflicts column with a footnote pointing to the §2d skip rationale.

### 6.5 PreToolUse decision (deferred)

Optional `decision.also_matched: [{rule_id, action, reason}]` for the agent to mention in its rationale. **Not in v1.** The latency math doesn't justify it; the harness already takes the strictest action. Reconsider when we have telemetry on agent confusion about why a particular rule fired.

---

## 7. Open questions

1. **What counts as "the same skeleton"?** The literal-token-equality heuristic catches identical patterns and near-identical patterns reliably. But subtle differences — different anchors (`\b` vs `(^|/)`), different whitespace handling — can yield same-skeleton labels for genuinely-different patterns. Calibration is an open empirical question; ship the v1 algorithm, observe false-positive rate, tune.
2. **How do we handle rules with empty `patterns: []`?** These fire on `tool_match` alone. Two rules with identical `tool_match` and empty patterns are duplicates by definition; flag as `kind: "duplicate_domain"`.
3. **What about rules with ratchet semantics?** A rule that fires on "non-null assertion count increased" doesn't have a regex domain — it's a metric. Out of scope for structural overlap; flag separately if two metric-rules touch the same metric.
4. **Per-call runtime detection in v2 — what's the trigger?** Most likely: a `--debug-rules` flag on the harness that turns on the `also_matched` field for dev sessions. Would NOT ship as default-on.
5. **Cross-`active_when` semantics.** Rule A: `active_when.skill = "tdd"`. Rule B: `active_when.after_command: { pattern: "^/tdd\\b" }`. These can both fire when /tdd is invoked (the marker AND the recent command). Treat as overlapping unless we can prove disjoint — conservatively flag.
6. **`agent_source` overlap with `applies_to_roles`.** Existing `applies_to_roles` gates evaluation entirely. New `active_when.agent_source` gates only scope. Two rules with disjoint `applies_to_roles` are not loaded for the same call → no conflict possible. Handled by the trigger/tool-match step before scope-modulo logic kicks in.

---

## 8. Implementation order

Three PRs. Each ships independently; all three together complete the v1.

1. **Skeleton + overlap algorithm.** New module `harness/conflict-detection.ts` with: `extractSkeleton(pattern)`, `computeOverlap(ruleA, ruleB)`, `computeScopeIntersection(activeWhenA, activeWhenB)`, `classifyConflict(ruleA, ruleB)`. Pure functions, ~200 LOC plus tests.
2. **Load-time integration.** Wire the detector into `rules-loader.ts` after merge. Write `.interlinked/rule-conflicts.json`. Add `interlinked harness conflicts` subcommand. ~150 LOC + CLI tests.
3. **Distill-time integration + /enforce surface.** Update `skills/enforce/SKILL.md` self-checks (§12) to emit conflicts into `distilled-rules.json`. Update `/enforce list` output. ~50 LOC + doc updates.

Total: ~400 LOC across three PRs. The first PR unblocks the other two; PRs 2 and 3 can land in parallel.

Composes naturally with active_when (`harness-active-when-scoping.md`):
- Active_when ships first (Steps 1–4 in that doc).
- Conflict detection follows; the detector reads `active_when` from `GuardRule` objects, so it has to land after the type addition.
- Both arrive together at the user-visible surface (`interlinked verify`, `/enforce list`).

---

## 9. What this is NOT

- **Not a rule resolver.** The harness still picks first-match-wins-strictest at runtime. Conflict detection surfaces *that* a conflict exists; it does not change which rule wins. Existing precedence and severity logic in `evaluator/pre-tool.ts` is untouched.
- **Not a semantic checker.** Two rules whose prose addresses the same domain but whose patterns are disjoint will not be flagged as conflicts. They land in the "review candidates" bucket — informational, not assertive.
- **Not a runtime gate.** The detector runs at distill-time and load-time. It does not run on every PreToolUse — that violates the latency budget per `feedback_hook_latency_budget.md`.
- **Not a replacement for the §2d skip list.** Some sources should still be excluded entirely (test fixtures, persona files, TDD-themed skills that compete with our native gates). Skip-list and conflict-detection are complementary: skip handles "should never load", conflict-detection handles "loaded, but doesn't make sense alongside what's already there."
- **Not a hook-script wiring detector.** Multiple skills installing PreToolUse hooks at the Claude Code / Codex / etc. layer is a separate concern (hook composition, ordering, exit code precedence). That's an `interlinked enable` concern, addressed elsewhere.

---

## 10. Decision

Adopt this design as the v1 conflict detector. Implementation lands after `harness-active-when-scoping.md` Steps 1–4 complete (the detector reads `active_when` and depends on the type additions). Expect to revisit:

- **Skeleton calibration** after first ~20 distilled rule sets pass through, when we have FP/FN data.
- **Per-call runtime** when telemetry shows agents misunderstanding decisions.
- **Semantic conflicts (kind D)** when the LLM-assisted distillation pass arrives — same model run can do "are these two rules in the same domain?" as a side-quest.

The Matt-TDD case is already resolved by the §2d skip-list update; this detector is the general mechanism that prevents the next Matt-TDD from needing an audit to surface.
