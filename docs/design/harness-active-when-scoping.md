# Active-When Scoping for Distilled Rules

**Status:** Design / not yet implementation. Precondition for safely running `/enforce` against SKILL.md trees without curation. Composes with: `skills/enforce/SKILL.md` (§2c, §6.5, §10), `harness/types.ts` (`GuardRule`, `SessionTrajectory`), `three-product-architecture.md` (the rule set we ship in Free CLI).

**Scope:** Defines a scope-attachment mechanism that lets distilled rules carry runtime activation predicates, replacing the expand-the-skip-list path with an expand-the-vocabulary path. Specifies the new `GuardRule.active_when` field, the predicate vocabulary, the skill-marker session-state mechanism that backs it, and the back-compat / migration story. No implementation yet.

**Audience:** Engineers touching `harness/`, `harness/structure/`, `skills/enforce/`, and any future skill-authoring tooling.

---

## TL;DR

A distilled rule today fires whenever its `tool_match` + `patterns` match. The §2c gap is real: a rule extracted from `tdd/SKILL.md` ("never refactor while RED") fires the same in a TDD session as outside one. Two options exist: (a) skip more aggressively at distill time so SKILL.md trees produce fewer rules; (b) extract every imperative but attach scope conditions so rules are dormant until contextually live.

This doc picks (b). We add `active_when` to `GuardRule`, populate it from source context at distill time, and back it with a small skill-marker mechanism in `SessionTrajectory`. The result: every imperative in every SKILL.md becomes a real rule, but only fires when the imperative's home context is live. The skip list (§2d) shrinks back to truly inert files (test fixtures, persona files); descriptive design docs and skill bodies stop being a dilemma.

The load-bearing piece is the **skill-marker mechanism** — without a deterministic signal of "what skill is active right now," `active_when` is just a fancy comment. The proposed mechanism is explicit: a slash-command preamble or a Claude Code SkillStart hook posts an `entered` event to the harness; the harness records `active_skills` in session state with a TTL; `active_when` predicates read that state.

---

## 1. Problem

### 1.1 The §2c gap

> Skill rules have no runtime "active skill" scope — the harness does not surface skill-invocation context to the evaluator, so once distilled a skill rule fires whenever its `tool_match` + `patterns` match, like any other rule.
>
> — `skills/enforce/SKILL.md` §2c

This forces a bad choice at distill time:

- **Distill hot** (default action per §5 ladder) → rules over-fire outside their home context. Example: `tdd/SKILL.md`'s "never refactor while RED" blocks every refactor, not just the ones during a TDD cycle. Users disable, lose the signal entirely.
- **Distill cold** (downgrade everything skill-sourced to `ask` per §5c) → rules become noise. Users reflex-yes through prompts, which trains worse than no enforcement.
- **Skip the file** (extend §2d) → the imperatives are real and worth enforcing, just not unconditionally. We lose them.

The audit findings against `mattpocock/skills` and `garrytan/gstack` confirm the shape: most SKILL.md content is operationally meaningful but contextually scoped. Without scope attachment, ~70% of distillable imperatives stay shadow rules or get aggressively skipped.

### 1.2 The expanded-skip-list temptation

A first-pass response is to grow §2d's skip list to cover `model-overlays/`, `*-CLAUDE.md` variants, `review/specialists/`, `docs/designs/`, and test fixtures. This is the wrong fix. It throws out enforceable signal because the harness can't express *when* it should fire.

The right fix is to expand the vocabulary so nothing has to be skipped except files that genuinely contain no agent-directed imperatives (persona, identity, memory indexes, build-output fixtures).

### 1.3 What "scope" actually means

Per the prior audit work, distillable imperatives split along five scope axes the harness already partially observes:

| Axis | What "scope" means | Today |
|---|---|---|
| Active skill | "Only when /tdd is the live skill" | Not tracked |
| Phase / mode | "Only while in RED phase" | §6.5 has `tdd_state(file)` |
| Recent action | "Only after a `/ship` invocation in the last N steps" | §6.5 has `last_command_was`, not windowed |
| File scope | "Only when editing files matched by skill globs" | `tool_match` + `patterns[].field=file_path` covers it |
| Role / overlay | "Only when claude.md model-overlay is in effect" | `applies_to_roles` covers role; no overlay tracking |

`active_when` is the unification of these into a single composable scope condition.

---

## 2. Proposal

### 2.1 Schema addition

Add an optional `active_when` field to `GuardRule`:

```ts
interface GuardRule {
  // ...existing fields
  active_when?: ActiveWhen;
}

interface ActiveWhen {
  // All listed conditions must hold (AND). Omitted axis = always-on for that axis.
  skill?: string | string[];          // skill name(s); rule fires only if at least one is active
  phase?: PhaseSpec;                  // RED/GREEN/REFACTOR or other typed phase
  after_command?: AfterCommandSpec;   // "the user ran X within last N steps"
  file_scope?: string;                // additional file_path regex, AND-ed with patterns
  overlay?: string | string[];        // model-overlay name(s) currently active
  agent_source?: AgentRole | AgentRole[]; // when this distinction matters at scope-time
                                          // (distinct from existing applies_to_roles which gates evaluation)
  predicate?: SessionPredicate;       // §6.5 escape hatch for novel session-state checks
}

interface PhaseSpec {
  name: "tdd_state" | "ship_phase" | "review_phase" | string; // string keeps it open
  value: string;                      // "red", "green", "verifying", etc.
  scope?: "file" | "session";         // tdd_state is per-file; ship_phase is per-session
}

interface AfterCommandSpec {
  pattern: string;                    // regex, matched against trajectory.commands_run
  window_steps: number;               // default 10
}

type SessionPredicate = {
  name: string;                       // matches §6.5 vocabulary
  args: Record<string, unknown>;
};
```

A rule fires when:

1. Its `tool_match` matches the call (existing).
2. Its `patterns[]` evaluate true under §6 OR/AND-negated semantics (existing).
3. Its `active_when` is satisfied — every listed axis holds, or `active_when` is absent (new).

Order matters: `active_when` is checked first, before pattern evaluation, so a dormant rule short-circuits without spending regex cycles. This keeps the per-call cost of dormant rules near-zero and preserves the existing latency budget (per `three-product-architecture.md` Free-CLI tier).

### 2.2 Skill marker mechanism (the load-bearing piece)

`active_when.skill` requires the harness to know which skill is active. Three options were considered; we pick option 1 plus the option-3 manual escape hatch.

**Option 1 — Explicit invocation marker (selected).** When a slash command fires, a tiny preamble step posts `{event: "skill_enter", name: "ship", session_id, ttl_seconds: 1800}` to the harness Unix socket. The harness records this in `SessionTrajectory.active_skills` as a `Map<skill_name, {entered_at, expires_at, source}>`. The marker expires on TTL or on an explicit `skill_leave` event.

Three sub-options for *how* the preamble fires:

1a. **Skill frontmatter declares `enforce-marker: true`** and the user's `interlinked-activity.mjs` hook script reads it. Requires hook-script awareness of skill metadata — adds coupling we'd otherwise not have.

1b. **Slash-command preamble calls `interlinked skill enter <name>`** from the SKILL.md body. Cheap, explicit, requires skill author to opt in. Skills that don't opt in stay flat (rules fire always-on, like today). This is the recommended default.

1c. **Claude Code SkillStart/SkillEnd hooks** post the events automatically. Requires harness to support those hook events; some agents (Codex, Copilot) don't fire skill-lifecycle events. Reserve as agent-specific enrichment, not the contract.

We standardize on **1b** as the contract, with 1c as best-effort enrichment for agents that support it. The CLI command `interlinked skill enter <name>` is one new entry point; the matching `interlinked skill leave <name>` is its pair. Skill authors copy-paste a one-line preamble; that's the cost.

**Option 2 — Inferred from tool sequence.** Pattern-match the trajectory ("if last 5 calls look like ship's signature, treat as in-ship"). Probabilistic. Violates `feedback_harness_deterministic_only.md` — no.

**Option 3 — User declaration on enable (manual escape hatch).** `interlinked enforce activate <skill>` flips a global active bit; user manages it. Useful for dev-time and for skills that aren't slash-invoked. Kept as a fallback, not the default.

### 2.3 Distiller changes

`/enforce` populates `active_when` based on source context:

| Source location | `active_when` populated as |
|---|---|
| `<skill-name>/SKILL.md` body | `{ skill: "<skill-name>" }` |
| `review/specialists/<spec>.md` | `{ skill: "review", file_scope: "<spec-relevant-glob>" }` if known |
| `model-overlays/<model>.md` | `{ overlay: "<model>" }` |
| Root `CLAUDE.md`, `AGENTS.md`, `.clinerules/`, etc. | `active_when` omitted (always-on) — these are the project-wide gates |
| `*.local.md`, `AGENTS.override.md` | `active_when` omitted (always-on, highest precedence) |
| Skill body imperative that references "after running ship" | `{ after_command: { pattern: "^/ship\\b", window_steps: 20 } }` |
| Skill body imperative that references TDD state ("while RED…") | **Not emitted.** TDD enforcement is owned by the harness's native primitives (`tdd_new_file_gate`, `tdd_cycle_violation`, `tdd_regression`, `tdd_commit_gate`). The §2c skip-list entry for TDD-themed skills drops these files before the distiller sees them. |

The distiller uses lexical heuristics to infer phase/after-command axes from the imperative's own prose ("while X", "after Y", "during Z"); when it can't, it falls back to `active_when.skill` only. The `confidence` field already tracks distillation certainty — a rule with multiple inferred scope axes lands at lower confidence and may downgrade per §7.

### 2.4 Predicate vocabulary additions to §6.5

Two new entries the harness must support to make `active_when` non-vapor:

| Phrase | Predicate | Reads from |
|---|---|---|
| "while skill X is active" | `skill_active(name)` | `SessionTrajectory.active_skills` |
| "after running X within last N steps" | `command_in_window(pattern, window_steps)` | `SessionTrajectory.commands_run` (last N) |

Plus one extension: `active_when.predicate` is a generic escape hatch that maps to existing §6.5 entries (`tdd_state`, `tests_passed_recently`, etc.) without new vocabulary work.

---

## 3. Composition rules

### 3.1 AND across axes

`active_when` is AND-ed across listed axes. Omitted axes are always-on. Empty `active_when: {}` is equivalent to omitting the field.

### 3.2 OR within an axis

`skill: ["ship", "land-and-deploy"]` fires when *either* skill is active. Same for `overlay`, `agent_source`. `phase` and `after_command` are single-valued — author multiple rules if you need OR across them.

### 3.3 Layering with `applies_to_roles`

Existing `applies_to_roles` gates whether the rule is *evaluated at all* for a given agent. `active_when.agent_source` is finer: the rule is evaluated, but its scope condition includes the agent. We keep both — `applies_to_roles` for gross filtering (don't load this rule for codex sessions), `active_when.agent_source` for scope (this rule is dormant unless the agent is X).

### 3.4 Override semantics (§10 conflict resolution)

When a higher-precedence source emits an always-on version of a rule that a lower-precedence source emits with `active_when`, the always-on version wins per existing §10 strictness rules. We do **not** merge `active_when` clauses — the user's mental model is "the override fully replaces the underlying rule," which means the override's scope (or lack of it) is binding.

---

## 4. Back-compat and migration

### 4.1 Existing rules

Rules without `active_when` keep current behavior (always-on). The harness ignores unknown fields per existing pattern, so older harness builds reading newer `distilled-rules.json` files just see flat rules — they over-fire compared to a scope-aware harness, but they don't crash.

### 4.2 Existing distilled rules

`/enforce` regenerates `distilled-rules.json` per run; a single re-distillation upgrades existing rules to scope-aware form. Overrides in `distilled-rules.overrides.json` apply on top, so user mods (disable, modify) survive.

### 4.3 Skip-list (§2d) unchanged in this doc

We keep §2d as it is. Test fixtures, persona files, memory indexes, and architecture docs stay skipped — they contain no agent-directed imperatives regardless of scope. The five gaps the gstack audit flagged are revisited in a follow-up doc; this design intentionally removes the pressure to expand them.

### 4.4 Harness loader

`rules-loader.ts` adds an `evaluateActiveWhen(rule, trajectory)` step before pattern evaluation. The new path is a small predicate dispatch: read `active_skills`, check phase, query last-N commands. Cost is O(1) per axis. We document the per-call cost in the harness latency budget.

---

## 5. Open questions

1. **Nested skills.** Sub-agent in `/review` during `/ship`: are both skills active? Default is yes (set semantics). Rules with `active_when.skill = "ship"` fire; rules with `active_when.skill = "review"` also fire. The skill author who wants "only ship and not review" writes `skill: "ship", agent_source: "main"` (or a similar finer condition).
2. **Marker leak across sessions.** Hard cap on `expires_at` (default 30 min, max 4 hours) prevents a forgotten `skill enter` from making rules sticky. Harness garbage-collects expired markers on every event.
3. **Auto-detection from agent_source.** Should `model-overlays/claude.md` rules attach `active_when.overlay = "claude"` (manual) or `active_when.agent_source = "claude"` (automatic)? Probably the latter — the overlay is the agent. Distiller picks based on overlay-file home directory.
4. **Slash command without preamble.** A skill author who doesn't add `interlinked skill enter` gets flat (always-on) rules from their skill — same as today. We document this clearly. The opt-in cost is one line.
5. **`/enforce list` UX.** The list output should surface scope: a user looking at why a rule isn't firing today wants to see `active_when` at a glance. New column proposed.
6. **Verify pipeline interaction.** `interlinked verify` runs out-of-band of trajectory state. Scope-conditional rules that require `active_skills` cannot evaluate during verify (no live session). Document as: verify treats `active_when.skill`-gated rules as advisory-only; runtime hooks treat them as live.

---

## 6. Implementation order

Land in this order. Each step ships independently; the next step builds on the prior.

1. **Type additions** — extend `GuardRule` and `SessionTrajectory` in `harness/types.ts`. No behavior change, types only. (1 PR, ~50 LOC.)
2. **Skill-marker primitives** — `interlinked skill enter`/`leave` CLI commands; harness socket handler for `skill_enter` / `skill_leave` events; trajectory garbage-collection of expired markers. Tests for TTL, double-enter, missing-leave. (1 PR, ~250 LOC + tests.)
3. **Predicate evaluator** — `evaluateActiveWhen()` in `harness/evaluator.ts`. Handles all five axes with O(1) dispatch. Hard-coded predicate vocabulary; document the extension point. (1 PR, ~200 LOC + tests.)
4. **Distiller `active_when` population** — update `skills/enforce/SKILL.md` step 7 to emit `active_when` based on source location. Keep §5 ladder unchanged; the change is purely additive to rule output. Update worked examples. (1 PR, doc-only + a few harness regression cases.)
5. **`/enforce list` scope display** — show `active_when` in tabular output. (1 PR, formatter only.)
6. **Verify-pipeline scope handling** — document and enforce that scope-conditional rules degrade to advisory in verify. (1 PR, ~50 LOC + test.)

Total: ~6 PRs, ~600 LOC plus docs. The first three unblock everything else; #4–#6 can land in parallel after the predicate evaluator ships.

---

## 7. What this enables

- Pointing `/enforce` at a SKILL.md tree without curation. Every imperative gets distilled; only contextually-live ones fire. The skip-list debate ends.
- Review-checklist files (`review/specialists/security.md`, `data-migration.md`) become enforceable as `active_when.skill = "review"` advisory rules. Not noise outside `/review`; targeted signal inside it.
- Model-overlay rules (`model-overlays/claude.md`) become enforceable as `active_when.agent_source = "claude"` rules. The overlay's behavioral guidance becomes hook-enforced for that agent only.
- Phase-scoped imperatives in non-TDD skills (e.g., a `/ship` rule that fires only during the verifying phase, a `/review` rule scoped to the synthesis pass) become first-class `phase: ...` rules — not shadow. (TDD is owned by harness primitives, not active_when — see §2.3 table footnote and the /enforce skill's §2d skip list.)
- Sub-agent boundary rules become expressible: `active_when.agent_source = "main"` for top-level-only rules.
- The `feedback_taste_enforcement.md` thesis ("checks are taste levers") gets a scope vocabulary that matches user mental models — taste is contextual, and now the rules know it.

---

## 8. What this does **not** do

- Does not turn flat-list rule evaluation into a graph or a stateful workflow. The harness stays deterministic and per-call.
- Does not introduce LLM evaluation at runtime — `active_when` axes are deterministic predicates with O(1) dispatch.
- Does not add a UI. `/enforce list` is the only surface change.
- Does not change `guard-rules.json` semantics. Hand-curated rules are unaffected unless their author opts into `active_when`.
- Does not solve the cross-session distribution-shift problem (training-data-bias from blocked counterfactuals) — orthogonal concern, separate doc.

---

## 9. Decision

Adopt this design. Land in the order above. Open question #1 (nested skills, set semantics) is the only one that may need real-world feedback before it stabilizes; the rest are mechanical.
