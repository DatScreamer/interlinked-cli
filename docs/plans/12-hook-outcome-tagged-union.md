# HookOutcome Tagged Union: Type the Block/Allow/Ask Envelope

The harness's PreToolUse / PostToolUse return type is a flat object whose
discriminant (`decision: "allow" | "block" | "ask"`) is correlated with — but not
type-coupled to — its payload (`reason?: string`, `warnings?: string[]`,
`updated_input?: JsonObject`, ~25 other optional fields). Every consumer
(`adapters/*`, `server.ts`, `daemon-protocol.ts` clients, the .mjs hook fallback,
the upcoming LLM policy escalation) has to defensively read prose `string` fields
and string-match to react differently. This is the "lie of omission" the April
2026 *Errors Deserve Better* post describes — the success/failure axis is in the
type, but the *kind* of failure is not.

This plan refactors `HarnessDecision` into a discriminated union (`HookOutcome`)
with tagged payload variants, so the compiler enforces exhaustive handling of
every block-reason / advisory-kind, and so structured payloads can travel back to
the agent in a form subagents and policy layers can react to programmatically.

## TL;DR

- `HarnessDecision` becomes `HookOutcome`, a discriminated union over
  `tag: "allow" | "allow_advisory" | "block" | "ask"`.
- Each tag carries a *typed* payload (`TaggedBlockReason`, `TaggedAdvisory`,
  `TaggedAskReason`, plus the existing side-effect bag for log entries /
  reservations).
- Refactor is **internal-first, wire-last.** Type changes land on the harness +
  adapters before the wire protocol envelope is bumped. Adapters keep emitting
  the existing `{decision, reason, warnings, ...}` JSON to Claude Code et al.
  during phase 1 — the wire format is a public-ish contract with the hook
  scripts and the third-party CLIs we install hooks into; it changes last.
- Two new harness checks fall out: `exhaustive_outcome_match` (compiler-enforced
  via `assertNever` in every consumer) and `outcome_string_reason_set` (lints
  for the legacy `decision.reason = "..."` pattern in harness internals).

## Decisions already made

| Decision | Rationale |
|---|---|
| **Tagged union, not class hierarchy.** | Plain data, JSON-serializable, narrows correctly under `if (outcome.tag === ...)` without `instanceof`. Matches the rest of the codebase (`ReservationTxn`, `RpcMessage`). |
| **`tag` as the discriminant, not `decision`.** | Avoids a field rename clash with the wire format during the transition. The internal type uses `tag`; the adapter renders `decision` on the way out. |
| **Side-effects stay on a separate field, not on the variant payload.** | `log_entries`, `reservation`, `check_results`, `tool_breakdown`, `grep_stats` are *observations* about the call, orthogonal to the allow/block decision. Flatten them onto every variant and we duplicate ~10 fields per tag; lift them into a sibling `meta` field instead. |
| **Internal-first, wire-last.** | The wire JSON is consumed by `dist/hook-entry.js`, the .mjs script, and (transitively) Claude Code / Copilot / Gemini / Codex hook handlers. Changing it without a version bump breaks installs. The internal Result-shape is a free win that doesn't need the wire change. |
| **`AdvisoryKind` is the same enum the warnings already carry as prose.** | We have ~30 advisory kinds today (supermodel-graph, content-scan, structural, etc.). The enum is the existing `[interlinked:<kind>]` prefix the adapters already emit — promote it from a string convention to a typed discriminant. |
| **No external dependency.** | `better-result` / `Effect` are not added. The pattern is what we want; the libraries are runtime overhead and a viral migration we don't need. Vanilla TS discriminated union + `assertNever` helper covers it. |
| **Pre-tool warnings on `allow`** are their own variant (`allow_advisory`), not a flag on `allow`. | The blog's core argument: every variant is its own type. `{ tag: "allow_advisory", advisories: [...] }` is structurally distinct from `{ tag: "allow" }`, and consumers that only handle the first three tags (block/allow/ask) will get a compile error when advisories are added — exactly the behavior we want. |
| **`updated_input` keeps its current shape.** | It's an input *transform*, not a *decision payload*. Lift it into the sibling `meta` field. The "modified input" path is rare (tsgo bash rewriter, command sanitizer) and orthogonal to allow/block. |

## Codebase facts this plan respects

Verified against current source. Each shaped a design decision below.

| Fact | Source | Plan implication |
|---|---|---|
| `HarnessDecision` has 30+ optional fields, only `decision` required | `src/harness/types.ts:119-204` | The refactor's main value is forcing tag → payload coupling. The optional-everything shape is exactly the lie-of-omission problem. |
| Adapter switches on `decision.decision === "block"` etc. with prose `reason` | `src/harness/adapters/claude-code.ts:120-173` | Adapter is the canonical "consumer." It will become the boundary translator: `HookOutcome` (typed) → adapter wire JSON (string-y). |
| Daemon protocol indexes results by method to `HarnessDecision` | `src/harness/daemon-protocol.ts:103-118` | Wire-format change = `RpcResult["hook.*"]` change. Phase 4 work; not phase 1. |
| `decision.warnings` is `string[]` of pre-formatted lines | `src/harness/types.ts:132`, `src/harness/adapters/claude-code.ts:121` | Each warning today is `[interlinked:<kind>] <message>` prose. The kind prefix is the de facto discriminant — promote it. |
| 30 `[interlinked:*]` advisory kinds already documented as a string convention | grep `[interlinked:` `src/harness/**/*.ts` finds: structural, supermodel-graph, content-scan, project-setup, edit-diagnostics, grep, Bash, Edit, Write, etc. | Existing kinds enumerate the `AdvisoryKind` union directly — no design exercise needed, just a typed copy. |
| Reservations already use the discriminated-union + `applyTransition` pattern | `src/harness/reservations.ts` (per CLAUDE.md "Reservations are a single-source-of-truth state machine") | This plan applies the same shape one level up to the harness's outer envelope. Same pattern, broader scope. |
| `[proven]` / `[heuristic]` determinism tag already on every finding | `src/harness/quality-checks.ts::classifyDeterminism` | `TaggedAdvisory` carries `determinism` as a typed field rather than a prose prefix. |
| `decision.warnings` is built up imperatively (push prose strings into the array) all over `evaluator/*` and `server.ts` | grep `warnings.push(` `src/harness/**/*.ts` finds ~80 call-sites | Phase 1 keeps these working: the `HookOutcome` builder offers `addAdvisory(kind, message)` that the call-sites swap into incrementally. No big-bang. |
| Reason for `decision: "block"` is a plain `string` everywhere it's set | grep `reason:` `src/harness/evaluator/**` ~60 call-sites | Each call-site fits one of ~12 block-reason kinds (destructive, supply_chain, secret, protected_file, reservation_conflict, repo_confinement, policy_violation, content_scan, classifier_block, ratchet, structural_breaking, custom_rule). Phase 1 enumerates them; phase 2 migrates call-sites. |
| Fallback path in `.mjs` script speaks the same `{decision, reason}` shape | `src/lib/hooks-template.ts` (per `docs/plans/08-hook-server-protocol-mismatch.md`) | The .mjs is generated at install time and ships independently. Wire change requires rebuilding + reinstalling on every dev box. Phase 4 only. |
| `HarnessDecision.additional_context` exists to route adapter-specific text out-of-band | `src/harness/types.ts:166-172` | Already a precedent for "this is a typed channel for a specific consumer." Justifies adding more typed channels (TaggedAdvisory carries channel hints). |

## Why this codebase specifically benefits

1. **Subagent recovery.** Claude Code subagents reading our `decision.reason`
   today have to regex-match prose to decide whether to retry. With
   `TaggedBlockReason.tag === "rate_limited"` they can branch programmatically.
   Cited use-case: the Supermodel-graph blast-radius warning
   (`docs/plans/07-supermodel-graph-integration.md`) is currently a
   `[interlinked:supermodel-graph] HIGH ...` prose string; subagents have no
   reliable way to act on it.

2. **LLM policy escalation v2** (per memory:
   `project_llm_policy_enforcement.md`) — when the classifier promotes from
   shadow to enforce, its decision needs to carry *why* in a form the agent
   can map to behavior. Prose works for v1 (shadow); typed payloads are
   load-bearing for v2 (enforce).

3. **Telemetry honesty.** Today we count `[interlinked:*]` advisories by
   regex over `decision.warnings`. With `TaggedAdvisory.kind` as a string
   literal type, the count is type-checked — adding a new kind without a
   counter shows up as a compile error in the telemetry aggregator.

4. **Recurrence aggregation** (per CLAUDE.md "Recurrence" section) — the
   `harness_caught` recurrence rows currently group by `check_id` parsed out
   of message prose in some paths. `TaggedAdvisory.check_id` becomes a
   typed field everywhere.

5. **Compiler-enforced exhaustiveness** is the closest the harness can get
   to a "did you handle this rule" check. Today, adding a new advisory kind
   in the evaluator silently flows out as a `[interlinked:newkind]` string
   that no consumer specially handles. With the union, a new variant is a
   compile error in every consumer that doesn't have a fallback case.

## Proposed types

```ts
// src/harness/outcome/types.ts (new file)

import type { JsonObject } from "../../lib/json-types.js";
import type { CheckResultEntry, GrepStats, LogEntry,
                ReservationAction } from "../types.js";

/* ---------- Discriminated outcome ---------- */

export type HookOutcome =
  | { tag: "allow"; meta?: OutcomeMeta }
  | { tag: "allow_advisory"; advisories: TaggedAdvisory[]; meta?: OutcomeMeta }
  | { tag: "block"; reason: TaggedBlockReason; meta?: OutcomeMeta }
  | { tag: "ask"; reason: TaggedAskReason; meta?: OutcomeMeta };

/* ---------- Block-reason variants ---------- */
// Enumerated from existing call-sites in src/harness/evaluator/**.

export type TaggedBlockReason =
  | { kind: "destructive_command"; rule_id: string; matched: string;
      message: string }
  | { kind: "supply_chain"; vector: SupplyChainVector; details: JsonObject;
      message: string }
  | { kind: "secret_in_content"; matchers: string[]; redacted_count: number;
      message: string }
  | { kind: "protected_file"; path: string; reason_code:
      "system_file" | "credentials" | "vcs_internal";
      message: string }
  | { kind: "reservation_conflict"; path: string; held_by: string;
      expires_at: string; message: string }
  | { kind: "repo_confinement"; attempted_path: string; cwd: string;
      message: string }
  | { kind: "policy_violation"; rule_id: string; severity:
      "critical" | "high" | "medium" | "low";
      category: string; message: string }
  | { kind: "content_scan"; finding_kind: string;
      classifier: "regex" | "ml"; message: string }
  | { kind: "classifier_block"; classifier_id: string; confidence: number;
      cited_rules: string[]; message: string }
  | { kind: "ratchet_violation"; metric: string; baseline: number;
      observed: number; message: string }
  | { kind: "structural_breaking"; affected_files: string[];
      message: string }
  | { kind: "custom_rule"; rule_id: string; message: string };

export type SupplyChainVector =
  | "phantom_dependency"
  | "postinstall_script"
  | "untrusted_registry"
  | "lockfile_drift"
  | "package_homograph";

/* ---------- Ask-reason variants ---------- */
// `ask` is a "block but user can override" — narrower set than block.

export type TaggedAskReason =
  | { kind: "pre_block_check"; check_id: string; line?: number;
      message: string }
  | { kind: "ratchet_one_off"; metric: string; message: string }
  | { kind: "policy_escalation_shadow"; classifier_id: string;
      message: string };

/* ---------- Advisory variants ---------- */
// One per existing [interlinked:*] prefix. Carries the determinism tag the
// CLAUDE.md "Findings carry a determinism tag" section already enforces.

export type TaggedAdvisory =
  | { kind: "structural"; check_id: string; line?: number;
      message: string; determinism: Determinism }
  | { kind: "supermodel_graph"; risk: "LOW" | "MEDIUM" | "HIGH";
      affected_files: string[]; message: string;
      determinism: Determinism }
  | { kind: "content_scan"; finding_kind: string;
      classifier: "regex" | "ml"; message: string;
      determinism: Determinism }
  | { kind: "project_setup"; check_id: string; message: string;
      determinism: Determinism }
  | { kind: "edit_diagnostic"; tool: string; line?: number;
      message: string; determinism: Determinism }
  | { kind: "grep_acceleration_summary"; stats: GrepStats;
      message: string; determinism: Determinism }
  | { kind: "tool_observation"; tool: string; observation_kind: string;
      message: string; determinism: Determinism }
  | { kind: "trajectory"; observation_kind: string; message: string;
      determinism: Determinism }
  | { kind: "behavioral"; check_id: string; message: string;
      determinism: Determinism }
  | { kind: "quality_check"; check_id: string; line?: number;
      message: string; determinism: Determinism }
  | { kind: "suggestion"; check_id: string; score: number;
      message: string; determinism: Determinism };

/* ---------- Determinism (re-exported from existing types) ---------- */

export type Determinism =
  | "fully_deterministic"
  | "partially_deterministic"
  | "heuristic";

/* ---------- Sibling meta — orthogonal observations ---------- */

export interface OutcomeMeta {
  log_entries?: LogEntry[];
  reservation?: ReservationAction;
  check_results?: CheckResultEntry[];
  checks_skipped?: import("../check-engine/types.js").SkipEntry[];
  checks_timing_ms?: number;
  checks_ran?: string[];
  tool_breakdown?: Array<{ tool: string; ms: number;
    finding_count: number }>;
  grep_stats?: GrepStats;
  summary?: string;
  updated_input?: JsonObject;
  telemetry_receipt_id?: string;
  /** Internal escalation request — set by evaluator, consumed by server.ts */
  _escalation?: import("../types.js").EscalationRequest;
  /** Internal content-scan request — set by evaluator,
   *  consumed by server.ts */
  _contentScan?: import("../content-scanner/types.js").ContentScanRequest;
}

/* ---------- Builder + assertNever ---------- */

export function assertNever(x: never): never {
  throw new Error(`unhandled HookOutcome variant: ${JSON.stringify(x)}`);
}

export class OutcomeBuilder {
  private advisories: TaggedAdvisory[] = [];
  private meta: OutcomeMeta = {};

  addAdvisory(a: TaggedAdvisory): this {
    this.advisories.push(a);
    return this;
  }
  setMeta<K extends keyof OutcomeMeta>(k: K, v: OutcomeMeta[K]): this {
    this.meta[k] = v;
    return this;
  }
  build(): HookOutcome {
    if (this.advisories.length === 0)
      return { tag: "allow", meta: maybeMeta(this.meta) };
    return {
      tag: "allow_advisory",
      advisories: this.advisories,
      meta: maybeMeta(this.meta)
    };
  }
  blockWith(reason: TaggedBlockReason): HookOutcome {
    return { tag: "block", reason, meta: maybeMeta(this.meta) };
  }
  askWith(reason: TaggedAskReason): HookOutcome {
    return { tag: "ask", reason, meta: maybeMeta(this.meta) };
  }
}

function maybeMeta(m: OutcomeMeta): OutcomeMeta | undefined {
  return Object.keys(m).length === 0 ? undefined : m;
}
```

## Phased migration

The refactor splits into four phases. Each is mergeable on its own; later
phases depend on earlier ones but the code stays compiling and tests stay
green at every commit. Estimated combined effort: ~1–2 dev weeks.

### Phase 1 — Internal type, no wire change

**Goal:** make the typed envelope available inside the harness, prove the
exhaustiveness pattern works, do not touch the wire format.

| File | Status | Purpose |
|---|---|---|
| `src/harness/outcome/types.ts` | new | All `HookOutcome` types + `assertNever` + `OutcomeBuilder`. |
| `src/harness/outcome/__tests__/types.test.ts` | new | Compile-time exhaustiveness tests (TS-level: a missing case fails to compile). One runtime test per builder method. |
| `src/harness/outcome/from-decision.ts` | new | `decisionToOutcome(d: HarnessDecision): HookOutcome` — best-effort lift from the legacy shape, lossy by design (string `reason` becomes `kind: "custom_rule"`). |
| `src/harness/outcome/to-decision.ts` | new | `outcomeToDecision(o: HookOutcome): HarnessDecision` — exhaustive flattener. Variants render to the existing prose shape so adapters keep working unchanged. |
| `src/harness/outcome/__tests__/round-trip.test.ts` | new | Property test: for every `TaggedBlockReason`/`TaggedAdvisory` variant, `decisionToOutcome(outcomeToDecision(o))` preserves the discriminant + message. |

No existing files change in Phase 1. The new types live alongside, and the
two adapter functions stand by for Phase 2.

### Phase 2 — Migrate evaluator + server.ts to build outcomes internally

**Goal:** every harness code path that constructs a decision constructs an
outcome instead. The wire-out conversion happens at the boundary
(`server.ts` socket write).

| File | Status | Purpose |
|---|---|---|
| `src/harness/evaluator/pre-tool.ts` | edit | Return `HookOutcome` from the evaluator. Replace `decision.reason = "..."` with `OutcomeBuilder.blockWith({kind, ...})`. |
| `src/harness/evaluator/post-tool.ts` | edit | Same — build `HookOutcome` with advisories per check. |
| `src/harness/evaluator/write-content-guards.ts` | edit | The ~25 block-reason call-sites here become typed `TaggedBlockReason` constructors. |
| `src/harness/evaluator/tdd-new-file-gate.ts` | edit | Likewise for the TDD gate's ask-reason path. |
| `src/harness/server.ts` | edit | At the socket write boundary, `outcomeToDecision(outcome)` to keep the wire format unchanged. |
| `src/harness/server-bridge.ts` | edit | Guard event emission consumes `HookOutcome` (server-confirm rejection path is `outcome.tag === "block" && outcome.reason.kind === "reservation_conflict"`). |
| All `evaluator/*.test.ts` | edit | Assertions move from `decision.decision === "block"` and `decision.reason.includes("...")` to `outcome.tag === "block" && outcome.reason.kind === "..."`. Cleaner, less brittle. |

By the end of Phase 2 the harness internals are fully tagged. The wire is
still legacy.

### Phase 3 — Adapters render from outcome, keep wire format

**Goal:** adapters consume `HookOutcome` directly, render to the existing
wire format. This is where exhaustive-match enforcement bites — adding a
new tag becomes a compile error in `claude-code.ts`, `copilot.ts`, etc.

| File | Status | Purpose |
|---|---|---|
| `src/harness/adapters/claude-code.ts` | edit | `encodeDecision(decision: HarnessDecision)` becomes `encodeOutcome(outcome: HookOutcome)`. Body switches on `outcome.tag` then on the variant `kind`. Final compile-time check via `assertNever(outcome)`. |
| `src/harness/adapters/copilot.ts` | edit | Same — currently identical wire shape. |
| `src/harness/adapters/gemini.ts` | edit | Same. |
| `src/harness/adapters/codex.ts` | edit | Same. |
| `src/harness/adapters/__tests__/*.test.ts` | edit | Assertions consume the typed outcome directly. |

### Phase 4 — Wire protocol bump (optional, gated)

**Goal:** the wire format itself becomes the typed outcome. Tagged variants
flow all the way to the agent.

| File | Status | Purpose |
|---|---|---|
| `src/harness/daemon-protocol.ts` | edit | `RpcResult["hook.*"]` becomes `HookOutcome`. `PROTOCOL_VERSION` bumps to `"2"`. |
| `src/harness/daemon-server.ts` | edit | Negotiate protocol version on connect; serve v1 (legacy `HarnessDecision`) for older clients, v2 (HookOutcome) for new ones. Routing is by `RpcRequest.schema_version`. |
| `src/lib/hooks-template.ts` | edit | The .mjs hook script learns to read v2 frames. Backward compat: if the daemon negotiates v1 (older daemon), the script reads the old shape via the existing path. |
| `dist/hook-entry.js` | regen | Built artifact. |
| `src/commands/__tests__/wire-version-negotiation.test.ts` | new | Round-trip test: v1 client ↔ v2 daemon ↔ v1 client all interop correctly during the rollout window. |

**Phase 4 is gated** on:
- 30+ days of Phase 3 in production with no adapter regressions.
- The .mjs hook redistribution channel (per `docs/plans/08-hook-server-protocol-mismatch.md`) being healthy enough to push a script update without breaking existing installs.
- A documented deprecation timeline for v1 readers.

If those gates aren't met, the project ships at end-of-Phase-3 and v1 stays
the wire forever. The internal Result-pattern win is already captured.

## Two new harness checks that fall out of this work

### `outcome_string_reason_set` (post, warning, default)

Detects assignments of bare prose strings to the `reason` field of a
HarnessDecision (or, post-Phase-2, anywhere a `TaggedBlockReason.message` is
set without a structured `kind`). After Phase 2 lands, `decision.reason = "..."`
is an anti-pattern in harness code — the typed builder is the only correct
construction path.

```ts
// Detector sketch (post Phase 2):
//   /\b(decision|outcome)\.reason\s*=\s*["'`]/   // direct assignment
//   /\bblockWith\s*\(\s*\{[^}]*kind:\s*["']custom_rule["']/  // catch-all kind
```

Not a default warning until Phase 2 completes; otherwise it would fire on
the legacy code itself.

### `exhaustive_outcome_match` (post, warning, default; type-system check)

A compile-time check, not a regex one — verifies that every `switch
(outcome.tag)` and every `switch (reason.kind)` in adapter code ends with
`assertNever(...)`. Implementation: AST walk for `SwitchStatement` whose
discriminant resolves to a `HookOutcome.tag` or `Tagged*.kind` type, with no
default case calling `assertNever`. Falls back to grep if AST unavailable.

This is the harness asking the rest of the codebase: "did you actually
handle every variant, or did you write a permissive default?"

## Validation

For each phase:

| Phase | Pass criteria |
|---|---|
| 1 | All new tests green; no existing tests touched; `npm run typecheck` clean. |
| 2 | All evaluator/server tests green; manual harness probe (`node cli/dist/harness/server.js --verbose` + raw socket call) returns identical wire JSON before and after migration. |
| 3 | Adapter tests green; **end-to-end probe**: run `interlinked harness restart`, do a real Claude Code edit, verify `additionalContext` and `decision.reason` look identical to pre-refactor. |
| 4 | v1↔v2 negotiation tests green; one week of dogfood with the new wire on this CLI's own development before the .mjs script is regenerated for downstream installs. |

## Open questions

1. **Should `OutcomeMeta` be required (vs optional `meta?`)?** Required would
   force every variant to carry timing/log info even when there is none; optional
   keeps the empty-meta case small. Lean: optional, with a builder that omits
   the field when empty. (Already encoded in the sketch above.)

2. **Is `additional_context` a meta field or its own advisory kind?** Currently
   it's a side-channel string. It's used by adapters to attach text to
   `hookSpecificOutput.additionalContext`. Lean: leave as a `meta` field for
   now (it's not a *finding*, it's a *channel hint*); revisit when migrating
   adapters in Phase 3.

3. **Do `_escalation` / `_contentScan` belong on the outcome at all?** They're
   internal coordination payloads consumed by `server.ts`, not facts about the
   tool call. Could live on a sibling internal envelope rather than `meta`.
   Lean: leave on `meta` to minimize Phase 1 surface; consider lifting in a
   Phase 5 cleanup.

4. **Versioning strategy for the wire format.** `PROTOCOL_VERSION = "1"` is the
   current envelope version. Phase 4 bumps to `"2"`. Open: do we serve both
   versions on the same socket (negotiated per-connection via
   `RpcRequest.schema_version`), or do we run two sockets? Lean: same socket,
   per-request negotiation — matches the existing envelope shape and avoids a
   second socket file.

5. **What about the .mjs script's inline-fallback patterns?** When the daemon
   is unavailable, `.mjs` falls back to its own pattern matchers (sleep, rm
   -rf, force push, DROP). Those patterns *are* the legacy `HarnessDecision`
   shape — does the fallback need to be tagged-union aware? Lean: no, keep
   the inline fallback minimal and untyped; it's a last-resort safety net
   that serializes back to the wire format directly.

## What this plan deliberately does NOT do

- **No external library adoption.** No `better-result`, no `Effect`. The
  pattern is the value; libraries are runtime overhead and a viral
  migration we don't need.
- **No restructuring of how findings are produced.** `CheckResultEntry`,
  `quality-checks.ts`, `generic-checks.ts` keep their shape. Only the
  *envelope* that carries findings to consumers changes.
- **No new wire-level features.** Phase 4 changes the *shape* of the wire,
  not its capabilities. Anything you can express today you can express
  after; the difference is that now the type system enforces handling.
- **No change to the `.interlinked/` JSON schemas.** `activity.jsonl`,
  `recurrences.jsonl`, etc. keep their shapes. The outcome type is an
  *in-memory* / *wire* type, not a storage type.
- **No change to the LLM policy classifier interface.** The classifier
  currently returns a free-form rationale string; it stays that way. The
  outcome side just types the *consumption* of that string into a
  `TaggedBlockReason.kind === "classifier_block"` variant.

## Cross-references

- `docs/plans/08-hook-server-protocol-mismatch.md` — the wire-format change
  in Phase 4 has to land *after* the protocol-mismatch fix; otherwise we'd
  be bumping a wire that the hook script can't even reach.
- `feedback_harness_deterministic_only.md` — the typed advisory kinds /
  block reasons are pure data; no LLM in the typing pipeline.
- `feedback_safety_continuity.md` — the fallback path stays untyped and
  permissive; the typed envelope is the *happy path*, not a single point
  of failure.
- `project_classifier_inference.md` — `TaggedBlockReason.kind ===
  "classifier_block"` is the typed channel for the v2 enforce-mode
  classifier output.
