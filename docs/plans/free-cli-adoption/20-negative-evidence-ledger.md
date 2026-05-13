# Negative Evidence Ledger

**Status:** Proposed.
**Phase:** 3.
**Source repos:** franken_engine, process_triage, eidetic_engine_cli, CASS.
**Scope:** Local, deterministic evidence ledger for rule outcomes, absence-as-evidence signals, and `/enforce` lifecycle commands. No network on the hot path.

## Why

Today distilled rules are mostly static. `.interlinked/distilled-rules.overrides.json` can disable or modify rules, and `recurrences.jsonl` can count repeated patterns, but there is no append-only record of whether a specific rule firing later proved helpful, harmful, or neutral.

The missing primitive is evidence valence:

- Positive evidence: the rule fired and the agent fixed a real issue.
- Negative evidence: the rule fired, was suppressed, and no downstream issue appeared, or the user undid the harness-driven change.
- Neutral evidence: the rule fired but the later result is unknown.
- Absence-as-evidence: expected evidence was missing, such as no tests after code edits or no UI interaction after frontend changes.

This plan ports the useful local subset of Jeffrey's negative-evidence ledger patterns into Interlinked CLI.

## Source Patterns

| Pattern | What to port | What not to port |
|---|---|---|
| franken_engine trust card | `positive_count`, `negative_count`, `neutral_count`, most-recent evidence, risk trend | Signed hash-chain audit; that stays in Guardrails tier |
| process_triage resource evidence | `ResourceNotFound` style absence-as-evidence as a typed signal | Domain-specific resource model |
| eidetic_engine_cli evidence ledger | Evidence pointers, artifact hashes, replay status, `insufficient_evidence` outcome | Full claim-verification certificate system |
| CASS confidence decay | 90-day half-life, 4x harmful multiplier, PITFALL-style inversion | Silent background mutation |

## Artifacts

Append-only ledger:

```text
.interlinked/rule-outcomes.jsonl
```

One JSON object per outcome:

```json
{
  "schema_version": 1,
  "rule_id": "enforce-tdd-write-test-first",
  "session_id": "2026-05-12T18-42-11Z",
  "fired_at": "2026-05-12T18:44:02.137Z",
  "recorded_at": "2026-05-12T18:50:21.004Z",
  "agent_action": "addressed",
  "subsequent_evidence": "no_issue",
  "valence": "positive",
  "evidence_ref": {
    "decision_ref": ".interlinked/decisions/2026-05-12T18-42-11Z.jsonl#42",
    "review_ref": null,
    "artifact_hash": "hmac-sha256:..."
  }
}
```

Derived aggregate:

```text
.interlinked/evidence-summary.json
```

This file is rebuildable from `rule-outcomes.jsonl` and can be deleted safely.

## Types

Add a small local module, likely `src/harness/rule-outcomes.ts`:

```ts
export type EvidenceValence = "positive" | "negative" | "neutral";

export type RuleOutcomeAction =
    | "addressed"
    | "suppressed"
    | "ignored"
    | "fix_recurred";

export type SubsequentEvidence =
    | "no_issue"
    | "ci_failed"
    | "reviewer_flagged"
    | "user_undid"
    | "unknown";

export interface RuleOutcomeEntry {
    schema_version: 1;
    rule_id: string;
    session_id: string;
    fired_at: string;
    recorded_at: string;
    agent_action: RuleOutcomeAction;
    subsequent_evidence: SubsequentEvidence;
    valence: EvidenceValence;
    evidence_ref: {
        decision_ref?: string;
        review_ref?: string;
        artifact_hash?: string;
    };
}

export interface EvidenceSummary {
    rule_id: string;
    positive_count: number;
    negative_count: number;
    neutral_count: number;
    fire_count: number;
    negative_ratio: number;
    most_recent_at?: string;
    most_recent_description?: string;
    risk_trend: "improving" | "stable" | "degrading";
    effective_severity: "block" | "warn" | "advisory" | "pitfall";
}
```

## Workstreams

### A. Per-rule outcome ledger

Implement append-only writes with atomic append semantics and validation:

- Validate every entry against the TypeScript type and JSON schema.
- Reject entries without `rule_id`, `session_id`, `fired_at`, `recorded_at`, and `valence`.
- Include provenance pointers whenever the outcome is derived from a decision log, review file, CI result, or user override.
- Never rewrite `rule-outcomes.jsonl`; rebuild summaries separately.

Aggregation:

- Compute raw counts for positive, negative, neutral.
- Compute weighted counts with 90-day half-life.
- Apply 4x multiplier to negative/harmful outcomes.
- Compute `negative_ratio`.
- Classify trend as improving, stable, or degrading from recent weighted movement.

### B. `/enforce` lifecycle commands

Add commands to the `/enforce` skill flow:

- `/enforce outcomes <rule_id>` prints ledger rows and the aggregate summary.
- `/enforce auto-demote [--dry-run]` proposes demotions for `negative_ratio > 0.5 && fire_count > 20`.
- `/enforce auto-invert [--dry-run]` proposes PITFALL-style warning rewrites for persistently harmful rules.

Bulk commands default to dry-run unless the existing `/enforce` command framework already has an explicit apply/accept lifecycle. Applying a demotion or inversion must update `.interlinked/distilled-rules.overrides.json` with provenance back to the outcome summary.

### C. EvidenceValence in Cedar context

Extend the Cedar request builder with evidence fields:

```ts
context.evidence = {
    positive_score: number;
    negative_score: number;
    neutral_count: number;
    insufficient_evidence: boolean;
    negative_evidence: string[];
    signals: Array<{
        id: string;
        value: string;
        valence: "positive" | "negative" | "neutral";
        confidence_bps: number;
        source: "t1" | "t2" | "t3" | "rule-outcome";
    }>;
};
```

Example Cedar intent:

```cedar
forbid (principal, action, resource)
when {
    context.evidence.negative_score > 5 &&
    context.evidence.positive_score < 2
};
```

### D. Absence-as-evidence Tier 1 signals

Promote implicit "missing expected proof" checks into structured negative evidence:

- `tests_not_run`
- `no_recent_commit`
- `ui_not_interacted`
- `stubs_introduced`
- `no_verification_after_edit`

These signals are deterministic and local. They can warn, block, or feed Cedar depending on the policy. They must not rely on LLM inference.

### E. `InsufficientEvidence` classifier outcome

Tier 2 classifiers emit `InsufficientEvidence` when confidence is below threshold. Do not default low-confidence output to benign.

Cedar can then route it to:

- log and observe,
- ask for more context,
- escalate to T3,
- or allow with a visible degraded-confidence note.

## Acceptance

- Unit tests cover ledger append, malformed entry rejection, summary rebuild, half-life weighting, and 4x negative multiplier.
- Regression tests prove bulk demotion/inversion commands do nothing without explicit apply/accept.
- `/enforce outcomes <rule_id>` works against a fixture ledger.
- `auto-demote` identifies a fixture rule with `negative_ratio > 0.5 && fire_count > 20`.
- `auto-invert` writes a PITFALL-style override only when explicitly accepted.
- Cedar context builder includes evidence fields and validates against `docs/design/interlinked-cedar-extensions.cedarschema`.
- Existing recurrence tests still pass; this ledger composes with `recurrences.jsonl` and does not replace it.

## Out Of Scope

- Cross-tenant aggregation of rule outcomes.
- Thompson-sampling or bandit rankers over global finding fix rates.
- Community-tuned rule packs.
- Signed hash-chain audit verification.
- Background mutation of distilled rules without user review.

Those are Interlinked MCP Server / Guardrails features. The Free CLI ships only the local, deterministic substrate.
