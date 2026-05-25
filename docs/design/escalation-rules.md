# Escalation Rules — Plan-Shaped Feedback from Combinations of Per-Edit Findings

**Status:** Design / not yet implementation. Sequenced first in the no-SOTA-assumed harness extensions (A in the A/B/C/D series; B = refactor verbs, C = ratchet/quota generalization, D = BoN executor).

**Origin.** The harness emits N line-level findings per edit. When findings cluster — three `raw_sql_concat` hits across one session, two layer-violation warnings on a single five-file edit, a `circular_imports` finding co-firing with `dead_exports` — the *synthesis* across them is the actual insight ("the approach is wrong; lift the shared symbol up one layer"). Today that synthesis lives in the reader's head. This document specifies a deterministic mechanism to fire it from the harness without an LLM in the loop.

**Audience.** Engineers extending `src/harness/evaluator/` and `src/harness/check-registry/`.

**Constraint.** Deterministic only (per `feedback_harness_deterministic_only.md`). No LLM in the trigger or in the synthesized advice. Plan-shape comes from author-curated escalation entries, not from inference.

**Related.** `runtime-pipeline-staging.md` — the deterministic escalation evaluator described here runs at the end of Stage 3 in the staged pipeline, feeding aggregated findings into Stage 4 escalation triggers.

---

## TL;DR

A new evaluator stage runs after individual rule eval, before formatting. It watches the per-event finding stream and the per-session finding history. When a configured combination fires, the harness emits a single `[plan]`-tagged warning that **supplements** (not replaces) the line-level findings. Config lives in `.interlinked/escalation-rules.json` (team) and `.interlinked/escalation-rules.local.json` (personal); a built-in registry mirrors the guard-rule pattern.

Every escalation must carry a concrete alternative (a file path, a helper symbol, a code example). Vague advice ("use the right abstraction") is a config validation error.

---

## 1. Why escalation rules exist

Three patterns recur in real review traffic and are unaddressable by per-line warnings:

| Pattern | Per-line warnings (today) | Plan-shaped warning (proposed) |
|---|---|---|
| Repeated identical hit | "line 42: raw_sql_concat" × 3 across session | "Three raw_sql_concat hits this session — reach for the parameterized helper at `src/db/query.ts`. Example: `src/db/__tests__/query.test.ts:18`." |
| Co-firing related hits on one edit | "line 11: circular_imports", "line 47: structural.layer_violation" | "Edit hit cycle + layer violations. The shared symbol probably needs to lift up one layer rather than be referenced sideways. See `docs/design/three-product-architecture.md` §4." |
| Many files touched, broad-types warnings on most | 8 × `broad_object_types` | "8/10 files in this edit have `broad_object_types`. The data shape needs to be pinned at the boundary first; do that pass before the per-file edits." |

The synthesis is not derivable from any single warning. It comes from observing a pattern of warnings *as a set*. The escalation rules system is the place that pattern-matches on sets.

This is a different kind of feedback from the existing pipeline. Per-line warnings are about *what is wrong*. Escalation warnings are about *what shape the next edit should take*. Today the agent has to infer the second from the first; the proposal is to spell the second out.

---

## 2. Architecture and integration

### 2.1 Where it runs

```
PostToolUse event
  ├── individual rule eval        (existing — src/harness/evaluator/post-tool.ts)
  ├── quality checks              (existing — src/harness/quality-checks.ts)
  ├── structural checks           (existing — src/harness/structure/)
  └── escalation eval             (new — src/harness/escalation/eval.ts)
       └── reads:
            - findings emitted this turn
            - session history (src/harness/session-state.ts)
            - recurrence aggregates (src/harness/recurrence.ts)
       └── emits: zero or more [plan]-tagged warnings
```

Escalation eval runs **last** in the post-tool pipeline. It can only consume findings the rest of the pipeline produced; it never blocks an edit (PostToolUse is non-blocking). Pre-tool variant deferred to a follow-up — see §10.

### 2.2 New files

| File | Purpose |
|---|---|
| `src/harness/escalation/types.ts` | `EscalationRule`, `EscalationTrigger`, `EscalationAction`, `EscalationContext` |
| `src/harness/escalation/eval.ts` | Evaluator entry point; reads context, matches rules, emits warnings |
| `src/harness/escalation/triggers.ts` | Trigger predicates (`count_in_session`, `count_in_edit`, `any_of`, `all_of`, `files_in_edit_gte`, `recurrence_count_gte`) |
| `src/harness/escalation/registry.ts` | Built-in escalations (mirrors `rules-loader.ts` shape) |
| `src/harness/escalation/loader.ts` | Loads `.interlinked/escalation-rules.json`, hot-reload, validation |
| `src/harness/escalation/__tests__/eval.test.ts` | Trigger semantics, FP defenses, built-in regression |

### 2.3 Reuses

- `src/harness/session-state.ts` — per-session finding counts already tracked; expose iterator
- `src/harness/recurrence.ts` — `harness_caught` records already accrued; query by signature
- `src/harness/check-metadata.ts` — escalation entries reference check ids; validation cross-checks
- `src/harness/quality-checks.ts::classifyDeterminism` — extended to map escalation-emitted findings to a new `[plan]` tag

### 2.4 Config layering

| File | Git | Contains |
|---|---|---|
| `src/harness/escalation/registry.ts` | committed | Built-in escalations (cannot be modified, only disabled) |
| `.interlinked/escalation-rules.json` | committed | Team-shared user escalations + `disabled_escalations: []` |
| `.interlinked/escalation-rules.local.json` | gitignored | Personal overrides |

---

## 3. Trigger language

A trigger is a predicate over `EscalationContext`. The context is:

```typescript
interface EscalationContext {
  // Findings emitted by this PostToolUse event
  edit_findings: ReadonlyArray<{ check_id: string; file: string; line?: number; severity: Severity; }>;
  // Findings accumulated this session (oldest → newest)
  session_findings: ReadonlyArray<{ check_id: string; file: string; turn: number; }>;
  // Recurrence-log query (signature → count over rolling window)
  recurrence_count: (signature: string, window_days: number) => number;
  // Files this edit touched
  edit_files: ReadonlySet<string>;
  // Session metadata
  session_id: string;
  agent_source: string;
}
```

### 3.1 Trigger primitives

```typescript
type EscalationTrigger =
  | { kind: "count_in_edit"; check: string; gte: number }
  | { kind: "count_in_session"; check: string; gte: number }
  | { kind: "files_in_edit_gte"; n: number }
  | { kind: "any_of"; checks: string[]; min_distinct: number }
  | { kind: "all_of"; checks: string[] }
  | { kind: "recurrence_count_gte"; signature: string; window_days: number; gte: number }
  | { kind: "and"; clauses: EscalationTrigger[] }
  | { kind: "or"; clauses: EscalationTrigger[] };
```

Composability is intentional: real escalations need conjunction (e.g., "broad_object_types AND files_in_edit_gte:5").

### 3.2 Why no regex/script triggers

Two reasons. **(1) Determinism + auditability:** every trigger reduces to a finite count or set query over the context. A reviewer can read the trigger and predict when it fires. **(2) FP discipline:** richer trigger languages tempt cleverness, and clever escalations are exactly the ones that mis-fire and undermine trust. Combinator triggers from primitives are sufficient for the patterns we've actually seen.

If a real pattern requires more expressiveness, add a new typed primitive — don't open a script escape hatch.

---

## 4. Escalation actions

```typescript
type EscalationAction = {
  kind: "synthesize_warning";
  approach: string;        // Human-readable plan-shape advice
  alternative: {
    // ≥1 of these required (validated at load)
    file_path?: string;
    helper_symbol?: string;
    example_path?: string;
    design_doc?: string;
  };
  related_findings_filter?: {
    // Which line-level findings this synthesis subsumes
    check_ids: string[];
    // If "demote": demote subsumed findings from warning → info on this edit only
    // If "keep" (default): emit synthesis alongside untouched findings
    on_match: "demote" | "keep";
  };
};
```

The `alternative` block is non-optional. Validation rejects entries where every alternative field is empty — generic advice without a concrete pointer is the failure mode this whole system is trying to avoid.

`on_match: "demote"` is the principled "synthesis replaces noise" path: if the plan-shape advice subsumes 5 line-level warnings, demote those 5 to info-level on this edit so the agent's attention is on the synthesis. Default is `keep` (additive) until the demotion logic is proven non-noisy in shadow mode (§8).

---

## 5. Built-in escalations to ship in Phase 1

Five entries cover the patterns most worth synthesizing today. All have been observed in practice in this repo's `.interlinked/recurrences.jsonl`.

| ID | Trigger | Approach (one-liner — full text in registry) |
|---|---|---|
| `repeated-raw-sql-concat` | `count_in_session(raw_sql_concat) ≥ 2` | "Use parameterized helper `parameterizedQuery` at `src/db/query.ts:42`." |
| `layering-via-cycle-and-violation` | `all_of(circular_imports, structural.layer_violation) AND files_in_edit_gte: 2` | "Lift the shared symbol up one layer rather than reference sideways." |
| `broad-types-on-many-files` | `count_in_edit(broad_object_types) ≥ 5` | "Pin the data shape at the boundary first; do that pass before the per-file edits." |
| `repeated-suppression-additions` | `count_in_session(suppressions-unjustified) ≥ 3` | "Three unjustified suppressions this session — the underlying type/lint error wants a real fix." |
| `dead-export-with-cycle` | `all_of(dead_exports, circular_imports) on same file` | "Cycle plus dead export on the same file usually means the export was kept to break the cycle. Remove both." |

Each registry entry carries its `approach` text inline. No external string table — auditable in one file.

### 5.1 The "concrete alternative" discipline

Every entry's `alternative.file_path` or `alternative.helper_symbol` is verified at config-load time:

- `file_path` must exist on disk
- `helper_symbol` must resolve in the project graph (uses `src/harness/project-graph.ts`)
- `example_path` must exist on disk
- `design_doc` must exist on disk

Stale references are a load-time error, not a runtime no-op. Rationale: a stale escalation is worse than no escalation — the agent reads the advice, follows it to a dead pointer, and loses trust in the system. Better to refuse to load.

A nightly CI check in `npm run docs` extends to validate built-in registry pointers against the working tree (the same way `docs-freshness.test.ts` works today).

---

## 6. False-positive defenses

The risk model: a wrongly-fired escalation is much more damaging than a wrongly-fired line-level warning, because it makes a stronger claim ("your approach is wrong"). Three defenses, layered:

### 6.1 Trigger-level minimums

- Every escalation requires ≥2 base check hits. No escalation fires on a single finding.
- Session-scoped triggers require the hits to span at least 2 distinct turns. Three hits in one edit ≠ a "repeated" pattern; it might be one bad commit being inserted as a multi-edit.

### 6.2 Per-session rate limit

Each escalation id can fire at most **3 times per session**. If the agent isn't acting on it after three syntheses, more syntheses won't help and start to feel like nagging.

### 6.3 Shadow mode default

New built-in escalations land disabled (`shadow: true`), which means they:

- Append to `.interlinked/escalations-shadow.jsonl` (signature, context, would-have-text)
- Don't surface to the agent

After accumulating ≥30 shadow firings across ≥10 sessions, a maintainer reviews and either flips `shadow: false` or refines the trigger. The shadow log is the calibration substrate (mirrors the `Phase 0.5 — shadow evaluation` discipline from `agent-memory-architecture.md` §0).

### 6.4 The escape hatch

Local config can disable any escalation by id (`disabled_escalations: ["broad-types-on-many-files"]`). This is the same pattern as guard rules — built-ins are immutable, disablement is per-environment.

---

## 7. The `[plan]` determinism tag

Findings today are tagged `[proven]` (compiler ran the actual code) or `[heuristic]` (regex/AST shape). Escalations introduce a third:

| Tag | Source | Reading |
|---|---|---|
| `[proven]` | tsc / biome / mypy / cargo / semgrep / parser-verified | "the code in fact does this" |
| `[heuristic]` | regex / AST shape match | "this matches a pattern that's usually wrong" |
| `[plan]` | escalation rule fired on a combination | "the approach across these edits looks wrong; consider this shape instead" |

Tag assignment lives in `src/harness/quality-checks.ts::classifyDeterminism`. Add a branch for findings emitted via `escalation/eval.ts` (carry an `origin: "escalation"` discriminator on the emitted finding). No parallel maintenance.

The tag matters because the agent (or human reader) treats different determinism levels differently. A `[plan]` warning is meant to prompt reflection on approach, not a line-level edit. Mis-tagging an escalation as `[heuristic]` would cause the agent to look for a per-line fix that doesn't exist.

---

## 8. CLI surface

```bash
interlinked harness escalations list                    # All loaded escalations + status (active/shadow/disabled)
interlinked harness escalations show <id>               # Full text, trigger, alternative refs
interlinked harness escalations test <id> --session <s> # Replay session through this escalation, show fires
interlinked harness escalations shadow                  # Read .interlinked/escalations-shadow.jsonl, group by id
interlinked harness escalations propose                 # Suggest new escalations from recurrence aggregates
```

`escalations propose` is the link to the recurrence system. It walks `.interlinked/recurrences.jsonl`, finds signatures with `count ≥ N` over the rolling window where no escalation currently fires, and prints a suggested entry. The maintainer pastes into the registry. (Strictly deterministic — counting + grouping, no LLM.)

`interlinked verify --escalations-only` runs the escalation evaluator over the current session log without re-running base checks. Used in CI to fail when a session accumulated escalations.

---

## 9. Testing

Mirrors the patterns in `src/harness/__tests__/`:

- `escalation/__tests__/triggers.test.ts` — each trigger primitive: positive, negative, edge cases (empty session, exactly-N boundary)
- `escalation/__tests__/builtin-escalations.test.ts` — every built-in: ≥3 positive cases, ≥3 negative cases (same shape as inline checks per `feedback_generalize_across_codebases.md`)
- `escalation/__tests__/concrete-alternative-validation.test.ts` — config validation rejects vague approaches, verifies pointer resolution
- `escalation/__tests__/rate-limit.test.ts` — same id can't fire >3× per session
- `escalation/__tests__/shadow-mode.test.ts` — shadow firings append to shadow log without surfacing
- `escalation/__tests__/integration.test.ts` — full PostToolUse flow with both line-level and escalation findings

Existing `docs-freshness.test.ts` extends to validate built-in escalation pointer freshness.

---

## 10. Phased rollout

| Phase | Deliverable | Gate to next |
|---|---|---|
| 1 | Types + evaluator + 5 built-in escalations (all `shadow: true`) | All ≥3/3 pos/neg tests pass |
| 2 | Config loader + hot-reload + CLI `list`/`show`/`test`/`shadow` | Used in 1 real session for ≥1 week |
| 3 | `[plan]` tag in determinism classifier; flip 2 of 5 built-ins to `shadow: false` based on shadow data | True-fire rate ≥ 70% on the 2 promoted entries' shadow log |
| 4 | `propose` command; `--escalations-only` verify mode; `on_match: demote` action | Demote not used until Phase 4 calibration shows non-noisy |
| 5 | PreToolUse escalation variant (advisory, never blocks) | After PostToolUse calibration is stable |

Each phase ships its own tests. Phase boundaries are hard — Phase 3 doesn't start until Phase 2's 1-week validation completes.

---

## 11. Failure modes acknowledged

- **Repeated identical hits within one session aren't always a repeated mistake.** Counter-example: agent is methodically migrating 12 callsites of an unsafe API; each callsite legitimately fires the same check before being fixed. Mitigation: trigger requires hits across ≥2 turns *and* doesn't require hits to be in distinct files (so legitimate bulk migration in one turn doesn't fire). Edge cases will surface in shadow mode.
- **The synthesis text gets stale.** If `parameterizedQuery` is renamed, every escalation that points to it goes stale. Mitigation: load-time validation of `helper_symbol` via project graph; nightly CI check.
- **Authors write generic-feeling syntheses.** Mitigation: alternative block is non-optional; reviewer rejects entries that don't carry a concrete pointer.
- **The agent ignores `[plan]` warnings.** No deterministic countermeasure available. The same agent that ignores `[heuristic]` will ignore `[plan]`. Escalation rules raise the *quality* of feedback; they don't raise the *attention* the agent pays to feedback. That's a model-side problem.

---

## 12. Open questions

1. **Demote default.** `on_match: demote` is potentially better than `keep` (less noise, sharper synthesis). Phase 4 decides based on calibration data — is line-level information lost when demoted?
2. **PreToolUse escalations.** Some escalations could fire pre-edit ("you're about to make the same mistake the harness blocked twice this session"). Adds a blocking surface; needs a stronger FP defense. Phase 5 only.
3. **Cross-session escalations.** Today only `recurrence_count_gte` reaches across sessions. Could a `[plan]` warning fire on a session's *first* finding if recurrence shows ≥10 hits across the team? Tempting but surfaces in a context where the current agent has no immediate referent. Defer.
4. **Author-curated vs mined.** Phase 4's `propose` is a mined-from-data path. Should mined entries auto-promote after threshold, or always require human paste? Conservative answer: always require human paste — preserves the curated-text discipline.

---

## 13. Composition with the larger system

Escalation rules complete a triangle:

| Layer | Surface | Frequency | Question answered |
|---|---|---|---|
| Per-line check (today) | `[proven]` / `[heuristic]` warning | Every edit | "Is this code wrong here?" |
| **Escalation rule (this doc)** | `[plan]` synthesis | Combinations / sessions | "Is the approach wrong?" |
| Recurrence aggregator (today) | `interlinked recurrence` CLI | Across sessions / team | "What patterns recur enough to ratchet?" |

The recurrence aggregator already produces the data; escalation rules consume it during the edit window. Together they convert one-shot warnings into a feedback cadence: warn → synthesize → ratchet (Doc C).
