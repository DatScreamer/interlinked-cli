# Graph-Prediction Protocol — PreToolUse Awareness Ratchet via .graph Shards

**Status:** Phases 0-3 implemented and shipping in shadow mode. Companion to `agent-memory-architecture.md` — a specific instantiation of the predict/reveal/reconcile pattern, scoped to file-edit PreToolUse hooks.

**v1.3 (this revision)** reflects the narrowed first slice the reviewer recommended after v1.2:
1. **Three crisp modes** replace the v1.2 "advisory vs blocking" framing:
   - `shadow` — never blocks; logs case observations only. **Default.**
   - `soft_gate` — blocks once on E-fresh files with no cached prediction (Fire 1: challenge), reveals diff and allows on retry (Fire 2). Never blocks on the diff itself.
   - `enforced` — `soft_gate` plus ack-required (Fire 3) for high-severity miss or full-abstention against high-impact oracle.
2. **No aggregate-score gating.** Severity decisions come from explicit predicates only. Weighted-average is telemetry, not load-bearing. (Reviewer #2 of v1.2 follow-up.)
3. **Phase 1 reframed as infrastructure-only**: case classification + cache schema land before challenges fire. Shadow mode is the live first slice; cache fills via voluntary predictions.

Implementation lives in:
- `src/harness/graph-prediction-classifier.ts` — case A/B/C/D/E-fresh/E-stale + workspace-active detection
- `src/harness/graph-prediction-cache.ts` — JSONL append + last-write-wins lookup
- `src/harness/graph-prediction-parser.ts` — fenced YAML extraction with format cap
- `src/harness/graph-prediction-reconcile.ts` — explicit severity predicates + bucket-tolerance scoring
- `src/harness/graph-prediction-stop-hook.ts` — transcript harvesting on Stop
- `src/harness/graph-prediction-pre-tool.ts` — three-mode driver
- `src/harness/supermodel-shard-write-guard.ts` + `rules/builtin-rules-supermodel.ts` — `.graph.*` write protection

**Iteration history.**
- **v1** specified the protocol with bucketed counts, "any .graph.* exists" detection, Stop-hook-only cache, single-file challenge sequencing, and a fictional builtin-rule schema.
- **v1.1** addressed seven review issues: shard-near-source detection, Stop-hook + transcript-parse fallback, Case C drops the challenge fire, reconciliation pseudocode rewritten, shard freshness gates Case E-fresh vs E-stale, real `GuardRule` schema for write protection, multi-file batched challenge.
- **v1.2** (this document) addresses seven additional findings:
  1. Cases B, D, E-stale no longer block — only Case E-fresh runs the predict/reveal/reconcile loop. Other cases are silent observation that retains the existing impact-warning behavior.
  2. Workspace-level "Supermodel active" detection is split from per-target shard presence.
  3. The broken `weighted_min_score` math is dropped — severity triggers do the load-bearing decisions; weighted-average is non-load-bearing telemetry.
  4. Count fields (`impact.direct`, `impact.transitive`) use bucket-tolerance scoring instead of exact equality.
  5. Full abstention on Case E-fresh against an oracle reporting high-impact requires acknowledgment.
  6. Top-K truncation is asymmetric — all predictions count against precision; oracle top-30 caps recall only. Predictions exceeding 50 entries per section are format violations.
  7. Phase 1 reframed as infrastructure-only — no live cache fill expected before Phase 3.

The consequent simplification: protocol surface drops from "five cases each with their own challenge flow" to "one case (E-fresh) with the full protocol; other cases get observation logging." Cost envelope drops accordingly — most edits don't activate the protocol.

**Origin:** Spun out of the agent-memory-architecture thread. The Supermodel integration at `src/harness/supermodel-graph.ts` already reads `.graph.*` shards and surfaces HIGH/MEDIUM impact warnings on PreToolUse (`src/harness/evaluator/pre-tool.ts:155-194`). This document specifies a richer protocol on top of that surface: before the harness reveals the shard's contents, the agent emits a structured prediction of what the shard will contain, the harness compares prediction to reality, and the diff surfaces as a calibration ratchet — but only on the case where the oracle is authoritative.

**Audience:** Engineers building this system. Anyone implementing should also have read `agent-memory-architecture.md` (parent design — alignment principles, claim_dependencies contract, authority tiers) and `docs/integrations/supermodel.md` (existing consumer).

**Related.** `runtime-pipeline-staging.md` — the predict → reveal → reconcile loop described here runs at Stage 2 in the staged pipeline; counterfactual Graph Prediction (sandbox replay), transitive prediction K hops downstream, and test-outcome prediction are Stage 2/5 extensions specified there.

---

## 1. The motivating question

> "Could we force the agent to *predict* what the .graph file will read, before it reads it? That graph prediction should not be written to disk but immediately be compared to the actual .graph file and presented as a diff so that agent and user can see how much of the codebase the agent really understands or is at least aware of."

The proposal turns the existing one-way warning ("here's the impact of your edit") into a two-way ratchet ("predict what you think you're touching, then see what you missed"). v1.2's narrowing keeps this behavior **only where the oracle is authoritative** (Supermodel shard, current as of source mtime). Everywhere else, the existing informational warning continues unchanged.

---

## 2. Composition with the existing memory architecture

Same predict/reveal/reconcile pattern as `claim_dependencies` (parent doc §5.2), applied to a different surface, with an explicit scope restriction:

| Aspect | claim_dependencies | graph_prediction (v1.2) |
|---|---|---|
| Trigger | UserPromptSubmit / response time | PreToolUse on Write/Edit/MultiEdit/NotebookEdit/apply_patch — *only when target is Case E-fresh* |
| Surface | Assistant claims about project state | File edits where authoritative shard exists |
| Oracle | Joint inverted index over memory + codebase + history | Supermodel `.graph.*` shard (authoritative when fresh + colocated) |
| Prediction unit | Per-claim dependency declarations | Per-edit graph-neighborhood declaration (mirrors shard format) |
| Comparison | Set-difference on enforceable evidence ids | Per-section set-difference on identifiers; bucket-tolerance on counts |
| Decision | Block on enforceable miss | Acknowledge-then-proceed on (high-severity miss OR full abstention against high-impact oracle) |
| Frequency | Per concept-rich response | Per Case E-fresh edit only |

Both share deterministic boundaries (trigger, contract, oracle resolution); probabilistic methods only in the middle; the same calibration JSONL substrate (`prediction_calibration.jsonl`); the asymmetric-update property.

---

## 3. Case classification

Two independent detection layers, each cheap.

### 3.1 Workspace-level: "Supermodel active"

This is a one-time-per-session question (with mtime-based refresh) answered before any edit-level work: **does this repo have an active Supermodel daemon?**

Operationally: at least one shard-near-source pair exists in non-excluded paths. A pair `(source, shard)` qualifies iff:

1. The shard exists at `shardPathFor(source)` (colocated)
2. The source file itself exists at the predicted path
3. The source path is **not** under any of these excluded patterns:
   - `**/__tests__/fixtures/**`, `**/__fixtures__/**`, `**/test-fixtures/**`
   - `**/reference-repos/**`
   - `**/node_modules/**`
   - `**/dist/**`, `**/build/**`, `**/out/**`
4. An explicit config opt-out is **not** active: `.interlinked/config.json#supermodel.enabled: false` forces "not active."

The exclude-paths list is necessary because this repo (and most repos that consume Supermodel) carry test fixtures with `.graph.*` files for parser testing — `src/harness/__tests__/fixtures/supermodel/` has 8 such fixtures, verified. Without the colocated-source-AND-non-excluded check, every edit in this repo would trip case detection against fixture shards whose source files are dummies inside the test fixture dir.

Implementation: `find -name '*.graph.*' -path '!<excluded>...' -print -quit` early-exits on first match. Microseconds when active; only slow on truly inactive repos. Cached per session with cheap mtime check on a sentinel directory; refreshes when sentinel mtime changes.

If workspace-level detection returns **false**, every edit routes to **Case A** (no-op). Skip the rest of this document's machinery.

### 3.2 Per-target case classification (only when workspace is active)

Given Supermodel is active in this workspace:

| Target file | Shard for target | Freshness | Case |
|---|---|---|---|
| Source doesn't exist (Write to nonexistent path); `tool_input.content` declares imports | n/a | n/a | **B — New-file-with-imports** |
| Source doesn't exist; no imports declared | n/a | n/a | **C — Greenfield-new-file** |
| Source exists | none | n/a | **D — Missing-shard** |
| Source exists | present | shard mtime ≥ source mtime − 60s | **E-fresh — Authoritative** |
| Source exists | present | shard mtime < source mtime − 60s | **E-stale — Shard predates source** |

### 3.3 Freshness rule

Given source `s` (mtime `t_s`) and shard `g` (mtime `t_g`), with `STALENESS_GRACE_SEC = 60`:

- `t_g >= t_s − GRACE` → fresh (Case E-fresh)
- `t_g < t_s − GRACE` → stale (Case E-stale)

The 60-second grace tolerates race conditions where the daemon indexes within seconds of a source touch. Calibrate from observation if this proves wrong.

### 3.4 Behavior summary by case × mode

The load-bearing v1.2/v1.3 simplification: only Case E-fresh activates the predict/reveal/reconcile protocol. Other cases retain the existing `getSupermodelGraphWarning` behavior (informational warnings) plus a graph-observations log row.

| Case | shadow mode | soft_gate mode | enforced mode |
|---|---|---|---|
| A (no Supermodel active) | n/a (driver returns null) | n/a | n/a |
| B (new file, has imports) | log observation | log observation | log observation |
| C (greenfield new file) | log observation | log observation | log observation |
| D (existing file, no shard) | log observation | log observation | log observation |
| E-stale (shard predates source) | log observation | log observation | log observation |
| **E-fresh (authoritative)** | log observation | challenge → reveal → allow | challenge → reveal → ack if high-severity |

Cases other than E-fresh stay informational because PreToolUse can't ask for a prediction without blocking — we either run the full protocol or none of it. Running it against non-authoritative oracles trains the wrong reflex. The protocol gives up per-edit calibration for B/D/E-stale in exchange for keeping the contract clean.

Mode is read from `.interlinked/config.json#harness.graph_prediction.mode`; default is `shadow`.

### 3.5 Detection mechanics (cheap)

| Check | Cost | When |
|---|---|---|
| Workspace-level Supermodel-active (cached) | ~1μs (cache hit) / ~5ms (cold scan) | First PreToolUse per session; mtime-refreshed |
| `existsSync(filePath)` (target source) | ~10μs | Every PreToolUse (when workspace active) |
| `statSync(shardPathFor(filePath))` (shard + mtime) | ~10μs | Cases D/E only |
| `statSync(filePath)` (source mtime) | ~10μs | Case E only |
| Path glob match against exclude list | ~50μs | First PreToolUse per file |

Total per-edit overhead for case classification: well under 100μs. Negligible.

### 3.6 What detection deliberately doesn't try

- **Is the daemon running right now?** Workspace-level detection (presence of shard-near-source pairs) is sufficient signal.
- **Is the file in the daemon's ignore list?** Skip — Case D's framing handles the ambiguity.
- **Is the daemon backlogged?** Genuinely unknowable. Deferred-comparison handles the indexing-lag cases via voluntary predictions.

---

## 4. Real shards reference

Grounding the prediction format in observed reality. All examples below are committed at `reference-repos/supermodel-cli/` (Supermodel's own dogfood).

### 4.1 Full shard (`internal/focus/handler.graph.go`)

```go
//go:build ignore

package ignore

// @generated supermodel-sidecar — do not edit
// [deps]
// imports     internal/api/client.go
// imports     internal/cache/cache.go
// imports     internal/ui/output.go
// imported-by cmd/focus.go
// [calls]
// Run ← init    cmd/focus.go:10
// Run → getGraph    internal/focus/handler.go:342
// extract ← Run    internal/focus/handler.go:55
// [impact]
// risk        MEDIUM
// domains     CLIInfrastructure · SupermodelAPI
// direct      1
// transitive  2
// affects     cmd/focus.go
```

### 4.2 Test shard (`internal/find/handler_test.graph.go`) — no `[impact]`

```go
//go:build ignore

package ignore

// @generated supermodel-sidecar — do not edit
// [deps]
// imports     internal/api/client.go
// [calls]
// TestSearch_BasicMatch → makeGraph    internal/find/handler_test.go:191
```

### 4.3 JS variant (`npm/install.graph.js`) — minimal

```js
// @generated supermodel-sidecar — do not edit
// [calls]
// download → fail    npm/install.js:28
```

### 4.4 Format observations

- Sections can be entirely absent. Test shards skip `[impact]` (Supermodel's daemon doesn't compute impact for sinks).
- Counts in `[impact]` are exact integers (`direct      1`), never bucketed strings.
- Risk distribution skews to MEDIUM in observed dogfood (6/6 non-test shards).
- `affects` and `domains` use `· ` (middle dot + space) as separator.
- Generator marker is exact: `// @generated supermodel-sidecar — do not edit`.

---

## 5. State machine (Case E-fresh only, soft_gate/enforced modes)

PreToolUse is single-shot. The prediction protocol runs as a multi-fire challenge/retry loop. **Only Case E-fresh edits enter this state machine, and only when `mode` is `soft_gate` or `enforced`.** Shadow mode (the default) bypasses the entire state machine and logs an observation. All non-E-fresh cases return with their case-appropriate informational behavior in every mode.

### 5.1 Sequence (single-file Case E-fresh)

```
[Fire 1] Edit foo.ts → workspace-active? yes; case = E-fresh
                     → cache lookup {session, foo.ts, t_source, t_shard}
                     → empty → BLOCK with challenge: "emit graph_prediction:"
                     → agent emits prediction in next assistant message

[Fire 2] Retry Edit foo.ts → cache lookup → hit (Stop wrote it; OR transcript fallback)
                            → reconcile against shard
                            → low/med severity AND not (full-abstention + high-impact oracle)
                              → reveal diff via additional_context; ALLOW
                            → high severity OR (full-abstention + high-impact oracle)
                              → BLOCK requesting graph_prediction_ack:

[Fire 3, only on high severity / abstention-against-high-impact]
        Retry Edit foo.ts → cache has ack → ALLOW
```

Two fires for low/med-severity (typical). Three fires only on the ack-required path.

### 5.2 Cache schema

Cache lives at `.interlinked/graph-predictions.jsonl`. Cache key is `{session_id, file_path, source_mtime, shard_mtime}`. `tool_input_hash` is logged for analysis but does not drive invalidation (the prediction is about the file's neighborhood, not the proposed edit content).

```yaml
session_id: <string>
file_path: <repo-relative>
source_mtime: <iso8601>
shard_mtime: <iso8601>
shard_path: <repo-relative>
emitted_at: <iso8601>
tool_input_hash: <sha256 hex>             # logged, not key-affecting
case: E-fresh                             # v1.2: only E-fresh writes to this cache
prediction:                               # mirrors shard section structure
  deps:
    imports: [...] | unknown
    imported_by: [...] | unknown
  calls:
    callers: ["<callee> ← <caller>", ...] | unknown
    callees: ["<caller> → <callee>", ...] | unknown
  impact: <object | null>                 # null = whole section omitted
comparison_status: pending | complete | parse_failed
diff:                                     # populated when complete
  per_section_score: {deps: 0.0..1.0, calls: 0.0..1.0, impact: 0.0..1.0}
  weighted_avg: 0.0..1.0                  # non-load-bearing telemetry
  severity: low | medium | high | full_abstention
  high_impact_oracle: <bool>              # for ack-required-on-abstention rule
  miss_set: { deps: [...], calls: [...], impact: {...} }
ack_required: <bool>
ack_text: <string | null>
acknowledged_at: <iso8601 | null>
```

A separate `.interlinked/graph-observations.jsonl` logs Cases B/C/D/E-stale events for telemetry (no prediction; just classification + tool_input_hash + timestamp). Useful for later analysis: "are we missing calibration opportunities by being too conservative?"

### 5.3 Stop-hook write + transcript-parse fallback

The agent may emit `graph_prediction:` and immediately attempt the retry tool call in the same turn — before Stop fires at end-of-turn. Two-layer strategy:

- **Primary write: Stop hook.** When the agent stops generating tool calls, the harness parses the most recent assistant messages for fenced YAML blocks containing `graph_prediction:`, validates each, appends a row to `graph-predictions.jsonl`. Durable.
- **Fallback read: PreToolUse transcript parse.** On Fire 2, when disk cache shows no entry, PreToolUse opens `event.transcript_path`, reads up to the last 10 assistant messages, scans for fenced YAML blocks with `graph_prediction:` matching the target file. If found, treat as ephemeral cache entry for this fire only; Stop will commit to disk separately.
- **Parse failure path:** if a `graph_prediction:` block fails YAML parse, return `decision: block` once with reason "block didn't parse; re-emit." Two consecutive parse failures → degrade open (allow edit; log as `parse_failed`).

### 5.4 Multi-file batch challenge

`MultiEdit` and `apply_patch` can edit multiple files in one call. Linear per-file challenge would mean N fires. Batched flow:

1. **Fire 1:** harness inspects `tool_input` via `extractAllEditedFilePaths(event)`, classifies each target. **Filters out Cases A/B/C/D/E-stale** — only Case E-fresh files enter the challenge. If no E-fresh files, no challenge; informational behavior for the others. If one or more E-fresh files have no cached prediction, return one block listing all of them:

   ```
   [interlinked:graph-pred] graph_prediction required for the following files
   in your edit (all are Case E-fresh, authoritative oracle):
     src/harness/server.ts
     src/harness/evaluator/post-tool.ts
   Emit one fenced YAML graph_prediction: block per file (in one response).
   Then retry the edit.
   ```

   Files in B/D/E-stale appear in `additional_context` informationally (case + reason) but don't gate the edit.

2. **Agent emits N predictions in one response.** Each in a separate fenced YAML block, each with its own `file:` field.

3. **Stop hook caches all N**, keyed by their respective `{session, file, source_mtime, shard_mtime}` tuples.

4. **Fire 2:** harness reconciles each cached prediction. Aggregates: if any need ack (high severity OR full abstention against high-impact oracle), block with batched ack request covering all flagged files. Otherwise reveal diffs and allow.

5. **Fire 3 (only if ack required):** agent emits one `graph_prediction_ack:` block listing acknowledged misses across all flagged files. Allow.

Three fires maximum, regardless of N. Convergence independent of file count.

---

## 6. Prediction format (mirrors shard format)

The agent's `graph_prediction:` block uses the same section structure as the actual shard, with explicit abstention semantics.

```yaml
graph_prediction:
  file: src/harness/server.ts                # canonical repo-relative
  deps:
    imports:                                  # direct enumeration
      - "node:net"
      - "./evaluator"
      - unknown                               # explicit abstention; partial-knowledge OK
    imported_by:
      - "src/index.ts"
  calls:                                      # canonical "<func> ← <caller>" / "<func> → <callee>"
    callers:
      - "main ← init"
    callees:
      - "evaluatePostToolUse → fileExists"
  impact:                                     # OMIT this section to express "unknown about impact"
    risk: low | medium | high                 # or unknown
    domains: ["Server"]
    direct: 8                                 # exact integer; or unknown
    transitive: 50                            # exact integer; or unknown
    affects:
      - "src/index.ts"
```

### 6.1 Section-omission semantics

- **Whole-section omission** (no `impact:` key) → treated as `unknown` for the whole section. Mirrors test-shard reality.
- **`unknown` sentinel inside a list** → that list element is an abstention; counted toward abstention-rate, not toward set-difference.
- **Empty list** (`imports: []`) → explicit prediction of "no imports." Different from `unknown` — empty asserts absence; `unknown` declines to assert.

### 6.2 Top-K asymmetric handling

Real shards are usually small (<30 entries per section). For very large shards:

- **Recall comparison:** uses oracle's top-30 entries (lexicographic by canonical identifier) — agents aren't required to enumerate every transitive importer of a hub.
- **Precision comparison:** uses **all** predicted entries against oracle's full content — over-prediction is symmetrically penalized. An agent predicting 100 items against an oracle of 8 has precision ≤ 0.08, regardless of which items match.

This asymmetry closes a gaming attack: predicting a giant superset can no longer trivially win recall without paying the precision cost.

### 6.3 Format-validation cap

Predictions exceeding **50 entries per section** are format violations. The harness rejects with "your prediction has too many entries (>50 in section <name>); narrow your top-K or use `unknown` for the long tail." This prevents abuse of the precision asymmetry by making the upper bound explicit. 50 is generous — real shards rarely exceed 30.

---

## 7. Reconciliation (corrected scoring)

Per-section comparison; abstention is half-credit (not failure); empty-set semantics explicit; load-bearing decisions come from explicit severity triggers (§7.4), not from a synthetic weighted score.

### 7.1 Per-section list scoring

For each list section (`deps.imports`, `deps.imported_by`, `calls.callers`, `calls.callees`, `impact.domains`, `impact.affects`):

```
oracle_set      = set of actual shard contents for this section
predicted_full  = full predicted set (excluding "unknown" sentinels)
predicted_top30 = predicted_full truncated to top-30 by canonical order
abstained       = (whole section omitted) OR (any "unknown" in list) OR (section explicitly "unknown")

# vacuous and edge cases
if oracle_set is empty and predicted_full is empty:
  recall = 1.0; precision = 1.0
elif oracle_set is empty and predicted_full is non-empty:
  recall = 1.0; precision = 0.0          # over-prediction penalty
elif oracle_set is non-empty and predicted_full is empty and not abstained:
  recall = 0.0; precision = 1.0          # missed all of oracle, but didn't over-claim
elif oracle_set is non-empty and predicted_full is empty and abstained:
  recall = "abstained"; precision = "abstained"
else:
  oracle_top30 = oracle_set truncated to top-30 by canonical order
  match_recall = oracle_top30 ∩ predicted_full
  match_prec   = predicted_full ∩ oracle_set
  recall    = |match_recall| / |oracle_top30|
  precision = |match_prec| / |predicted_full|         # over-prediction penalized

# section_score
if abstained and predicted_full is empty:
  section_score = 0.5                     # full abstention: half-credit
elif abstained and predicted_full is non-empty:
  section_score = min(recall, precision) * 0.7        # partial abstention
else:
  section_score = min(recall, precision)
```

### 7.2 Bucket-tolerance scoring (count fields)

For numeric scalar fields (`impact.direct`, `impact.transitive`):

```
buckets = ["0", "1-3", "4-10", "10+"]

if predicted is "unknown" or omitted:
  count_score = 0.5                       # honest abstention
elif predicted == oracle (exact):
  count_score = 1.0
elif bucket(predicted) == bucket(oracle):
  count_score = 0.7                       # same magnitude class
elif |bucket_index(predicted) - bucket_index(oracle)| == 1:
  count_score = 0.4                       # adjacent class (off-by-one bucket)
else:
  count_score = 0.0                       # off by more than one bucket class
```

For categorical scalar fields (`impact.risk` ∈ {low, medium, high}):

```
if predicted is "unknown" or omitted:
  category_score = 0.5
elif predicted == oracle:
  category_score = 1.0
else:
  category_score = 0.0                    # classes are discrete; class jump is a hard miss
```

### 7.3 Weighted-average for telemetry

Section weights, used **only for telemetry-grade rollup** (not load-bearing decisions):

| Section | Weight | Rationale |
|---|---|---|
| `deps.imports` | 0.5 | Easy to predict (often visible in current file) |
| `deps.imported_by` | 1.5 | Hard; misses indicate genuine awareness gaps |
| `calls.callers` | 1.5 | Hard; high signal |
| `calls.callees` | 1.0 | Medium |
| `impact.risk` | 2.0 | Decision input |
| `impact.direct/transitive/domains/affects` | 1.0 each | |

Rolled up as:

```
weighted_avg = sum(section_score * weight for each section) / sum(weight for each section)
```

This metric is logged for analysis (e.g., "files where the agent's overall awareness is consistently low") but **does not drive any decision**. Load-bearing decisions come from explicit severity triggers (§7.4). Replacing the broken `weighted_min_score` from v1.1; the weighted-average doesn't have the "any section can drag down the whole score" property the v1.1 math was trying to capture, but explicit triggers handle that need directly.

### 7.4 Severity classification (load-bearing)

A miss is **high-severity** when ANY of:

- Predicted `impact.risk: low` and actual is `high`
- Predicted `impact.risk: medium` and actual is `high`
- Predicted `impact.direct ≤ 3` and actual ≥ 10 (off by more than one bucket class)
- `imported_by` recall < 0.3 AND oracle has ≥ 5 importers (missed > 70% of dependents)
- `calls.callers` recall < 0.3 AND oracle has ≥ 5 callers
- `impact.domains` recall < 0.5 AND oracle has ≥ 3 domains

A response is **fully abstained** when every section is abstained (no concrete predictions made anywhere). This is its own category, distinct from "missed."

A miss is **medium-severity** when not high and `weighted_avg < 0.6`.

A miss is **low-severity** otherwise.

### 7.5 Decision rules (Case E-fresh only)

Other cases never reach this rule set; they're observation-only.

```
if severity == high:
  decision = ack_required
elif full_abstention AND oracle_indicates_high_impact:
  decision = ack_required
else:
  decision = reveal_and_allow

oracle_indicates_high_impact:
  oracle.impact.risk == "high"
  OR oracle.impact.direct >= 10
  OR oracle.impact.transitive >= 50
```

The `full_abstention + high-impact-oracle → ack` rule (#5 of v1.2 review) is the new addition. Without it, an agent could `unknown` everything on a HIGH-impact file, receive the diff, and proceed without engagement. The ack at minimum forces "I had no model; oracle says HIGH; here's how I'm proceeding."

### 7.6 Acknowledgment format

Required only when §7.5 decision is `ack_required`:

```yaml
graph_prediction_ack:
  files:
    - file: src/harness/server.ts
      reason_for_ack: high_severity | full_abstention_against_high_impact
      acknowledged_oracle_findings:
        - "8 importers (predicted 1)"
        - "12 callers (predicted 1)"
        - "5 domains (predicted [Server])"
        - "impact: HIGH (predicted MEDIUM)"
      proceeding_with_edit: yes | revised_plan
      revised_plan_summary: "<one line if revised_plan>"
  # multi-file ack carries one entry per flagged file
```

Either "proceeding as planned" or "revised plan in light of the new information." The contract is awareness + acknowledgment, not "you must change your plan."

---

## 8. Per-case behavior (what the agent sees)

### Case A — No Supermodel active

Silent. No challenge, no `additional_context`. The protocol's other layers (claim_dependencies, push from parent doc) still run.

### Case B — New-file-with-imports

No challenge, no prediction protocol. The harness's existing impact-warning surface continues — for new files this is essentially silent (no shard exists yet, no impact to surface). Observation row written to `graph-observations.jsonl` with the case classification. If the agent voluntarily emits a `graph_prediction:` block, Stop hook caches it as `comparison_status: deferred`; deferred-resolution mechanism (§10) handles the rest.

### Case C — Greenfield-new-file

Silent. No challenge, no observation surface (nothing to log). Agent voluntary predictions still flow into the deferred mechanism.

### Case D — Missing-shard

No challenge. The existing `getSupermodelGraphWarning` returns null (no shard found), so no impact warning. Observation row written to `graph-observations.jsonl`. Optional: if `interlinked harness verbose` is on, surface `[interlinked:graph-pred] no shard for <file> — daemon may have excluded it or be behind` via `additional_context`. Otherwise silent.

### Case E-stale — Shard predates source

No challenge. The existing `getSupermodelGraphWarning` runs but the surface message is prefixed with the staleness notice: `[interlinked:supermodel-graph] <file>: shard is Δt older than source — advisory; <existing impact warning>`. Observation row written. The agent has the existing context but isn't gated.

### Case E-fresh — Standard authoritative

The only case that activates the full protocol.

```
[Fire 1 — block]
  reason: "graph_prediction required for src/harness/server.ts. Authoritative oracle (Supermodel shard, fresh). Emit prediction and retry."

[Agent's response: prediction]

[Fire 2 — typical: low/med severity AND not (abstention + high-impact)]
  additional_context: |
    [interlinked:graph-pred] Comparison against src/harness/server.graph.ts:
      [section-by-section diff]
    Edit proceeding.
  Edit proceeds.

[Fire 2 — high-severity OR (abstention + high-impact oracle)]
  additional_context: |
    [interlinked:graph-pred] Comparison against src/harness/server.graph.ts:
      [diff details + reason for ack requirement]
  reason: "Acknowledge before proceeding."

[Fire 3 — agent acks]
  Edit proceeds.
```

### Multi-file batch (mixed cases)

The harness filters the file set down to E-fresh entries. If none, no challenge; informational treatment for all files. If at least one E-fresh:

```
[Fire 1 — single batched block]
  reason: |
    graph_prediction required for the following files in your edit:
      src/harness/server.ts        (E-fresh — authoritative)
      src/harness/handler.ts       (E-fresh — authoritative)
    Other files in this edit are not in scope (Case A/B/C/D/E-stale; informational only):
      src/harness/new-helper.ts    (B — no shard yet)
      cmd/foo.ts                   (E-stale — shard older than source)
    Emit graph_prediction: blocks for the E-fresh files (one per file).
    Then retry the edit.

[Agent emits N predictions for N E-fresh files]
[Fire 2: aggregate reconciliation; ack-batch if any high-severity / abstention-high-impact]
[Fire 3 if ack required: batched ack]
```

---

## 9. Disk-write protection

Verified empirically: zero matches for `\.graph` in `src/harness/rules/builtin-rules*.ts`. The current code reads `.graph.*` shards but has no rule blocking writes. The "predictions never touch disk" property requires explicit enforcement at two layers.

### 9.1 Builtin rule (regex-pattern coverage)

Add to `src/harness/rules/builtin-rules-extras.ts`, matching the actual `GuardRule` schema:

```typescript
{
  id: "supermodel-graph-write-blocked",
  enabled: true,
  trigger: "PreToolUse",
  tool_match: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  action: "block",
  patterns: [
    {
      field: "file_path",
      regex: "\\.graph(\\.[a-zA-Z0-9]+)?$",
      flags: "i",
    },
  ],
  reason:
    "Supermodel `.graph.*` shards are read-only artifacts owned by Supermodel's daemon. " +
    "Writing to them corrupts the codebase graph. The graph_prediction contract lives in " +
    "your response text, not on disk.",
  suggestion:
    "If you intended to update the graph, edit the underlying source file and let the daemon " +
    "re-emit the shard. If you intended to emit a graph_prediction, do so in your response text.",
  severity: "high",
  category: "filesystem",
  keywords: ["graph"],
}
```

The regex covers `.graph.<ext>` and bare `.graph`. Matches `tool_input.file_path` for `Write`/`Edit`/`MultiEdit`/`NotebookEdit`.

### 9.2 Explicit pre-tool.ts logic (apply_patch coverage)

`apply_patch`'s `tool_input.patch` is a single string containing multiple file paths embedded in patch syntax. A regex-pattern rule on `field: file_path` can't see them. Extend `src/harness/evaluator/pre-tool.ts` near the existing `getSupermodelGraphWarning` block:

```typescript
function checkSupermodelShardWrite(event: HarnessEvent): { block: true; reason: string } | null {
  const toolName = event.tool_name;
  if (!toolName || !isFileWriteOrPatch(toolName)) return null;
  for (const path of extractAllEditedFilePaths(event)) {
    if (/\.graph(\.[a-zA-Z0-9]+)?$/i.test(path)) {
      return {
        block: true,
        reason: `Write to ${path} blocked: .graph.* shards are owned by Supermodel's daemon.`,
      };
    }
  }
  return null;
}
```

Called early in PreToolUse, before the prediction protocol fires. Belt-and-suspenders with the builtin rule.

---

## 10. Deferred-comparison mechanism

A brand-new file's prediction (voluntary, since Cases B/C don't challenge) is emitted before the daemon indexes. Cache row carries `comparison_status: deferred`. On subsequent PreToolUse for that file:

- **Shard now exists and is fresh** → reconcile; reveal the deferred diff.
- **Shard still doesn't exist** → continue deferral (re-check on next edit).
- **Shard never appears** (TTL = 7 days) → silent eviction. Calibration row preserved for "files where Supermodel never indexes" analysis.

Voluntary Case C predictions flow through the same mechanism. Voluntary predictions in Cases D/E-stale are ignored by the deferred mechanism (those cases have shards or have-source-but-not-shard situations that the protocol doesn't try to resolve).

---

## 11. Failure modes

### Daemon offline mid-session

Files edited before stop have shards; files edited after don't. Per-edit case classification routes appropriately. No special handling.

### Cached prediction stale because shard updated

Cache key includes `shard_mtime`. Shard mtime change → cache miss → fresh challenge.

### Recently-renamed files

`foo.ts` renamed to `foo_v2.ts`. Old shard transient; new file routes to Cases B/D. Case classification handles without special casing.

### Source mtime jitter

Some filesystems have coarse mtime granularity. The 60-second freshness grace absorbs this.

### Workspace-active status flips

User installs Supermodel mid-session. The cached workspace-active value refreshes on a sentinel mtime change; first edit after install picks up the change.

### Adversarial gaming

- Predicting the maximal set: precision penalty (§6.2 asymmetry) + format cap (§6.3, 50-entry max) close this attack.
- Abstaining everywhere: full-abstention + high-impact-oracle requires ack (§7.5). Half-credit on abstention sections keeps the score honest.

### Token-cost runaway

The v1.2 narrowing means most edits don't activate the protocol — the per-session overhead is dominated by E-fresh edits, not by every edit. Mitigations:
- Per-turn cache reuse (subsequent edits to the same file with same source/shard mtimes skip the challenge)
- §8 budget cascade from parent doc when session approaches the regime cap

---

## 12. Composition with claim_dependencies

A response that both edits a Case-E-fresh file AND makes claims about project state emits both blocks. They're scoped to different actions:

- `claim_dependencies:` covers assertions in response prose (parent doc §5.2)
- `graph_prediction:` covers the file the agent is about to edit

Token cost is additive within parent doc §8 budget caps. Reconciliation logs unified in `prediction_calibration.jsonl`:

```jsonl
{"kind": "claim_dependencies", "session_id": "...", "diff": ..., ...}
{"kind": "graph_prediction", "session_id": "...", "file": "...", "case": "E-fresh", ...}
```

The graph_prediction protocol's authoritative oracle (the Supermodel shard) is **tier B** in the parent doc's authority hierarchy.

---

## 13. Cost envelope (v1.2 narrowed)

### Wall-clock per fire

Same as v1.1 — well under 50ms total per fire; fits in the 5s default PreToolUse budget.

### Token cost per session

The v1.2 narrowing materially reduces typical-session overhead. Token cost is dominated by Case E-fresh edits; other cases contribute zero protocol overhead.

| Surface | Tokens (per fire) |
|---|---|
| Block message (Fire 1, single-file challenge) | ~80–150 |
| Block message (Fire 1, multi-file batched challenge with N=3) | ~150–250 |
| `graph_prediction:` block (agent output, single file) | ~150–350 |
| `additional_context` reveal (Fire 2) | ~150–400 |
| Block message (Fire 3, ack request) | ~100–150 |
| `graph_prediction_ack:` block (agent output) | ~50–100 |

**Two-fire (typical E-fresh):** 380–900 tokens per Case E-fresh edit.
**Three-fire (ack required):** 530–1150 tokens per Case E-fresh edit.

For a session with ~25 file edits where 5 are Case E-fresh (typical mix on a mature codebase where most edits target files with active, fresh shards), protocol overhead is ~5 × 600 = ~3,000 tokens. Well under parent doc §8 budget caps for any regime.

For a session of mostly new-file work (Cases B/C/D dominant), protocol overhead is near zero — no challenge fires, just observation logging.

---

## 14. Phasing

### Phase 0 — disk-write protection ✓ shipped

`SUPERMODEL_RULES` in `rules/builtin-rules-supermodel.ts` blocks Write/Edit/MultiEdit/NotebookEdit when `tool_input.file_path` matches `\.graph(\.[a-zA-Z0-9]+)?$`. `checkSupermodelShardWrite` in `supermodel-shard-write-guard.ts` runs early in `pre-tool.ts` to cover apply_patch's embedded paths.

### Phase 1 — case classification + cache schema infrastructure ✓ shipped

- Workspace-active detection in `graph-prediction-classifier.ts` with exclude-paths (`fixtures`, `reference-repos`, `node_modules`, `dist`, `build`, `out`) and config opt-out (`harness.supermodel.enabled: false`)
- Per-target case A/B/C/D/E-fresh/E-stale classification with 60s freshness grace
- `appendPredictionRow` / `findPredictionRow` / `appendObservationRow` in `graph-prediction-cache.ts`
- Stop-hook transcript harvester in `graph-prediction-stop-hook.ts` (wired into `server.ts` Stop handler)

### Phase 2 — prediction format + reconciliation ✓ shipped

- Fenced-YAML parser in `graph-prediction-parser.ts` (≤50-entry per-section format cap)
- Per-section scoring with asymmetric top-K (oracle top-30 for recall; full predicted set for precision)
- Bucket-tolerance scoring (1.0 / 0.7 / 0.4 / 0.0 / 0.5-abstention) on counts
- **Explicit severity predicates only** (no aggregate-score gating):
  - `risk_underestimated_low_to_high`
  - `risk_underestimated_medium_to_high`
  - `direct_count_underestimated` (pred ≤ 3 AND oracle ≥ 10)
  - `imported_by_recall_low` (recall < 0.3 AND oracle ≥ 5)
  - `callers_recall_low` (recall < 0.3 AND oracle ≥ 5)
  - `domains_recall_low` (recall < 0.5 AND oracle ≥ 3)
  - `full_abstention_against_high_impact`
- Weighted-average remains as telemetry only, not load-bearing

### Phase 3 — state machine wiring (E-fresh only) ✓ shipped in shadow mode

- `driveGraphPrediction` in `graph-prediction-pre-tool.ts` wired into `pre-tool.ts` after the existing Supermodel impact-warning surface
- Three modes: `shadow` (default), `soft_gate`, `enforced`
- Multi-file batched challenge from day one (only E-fresh files enter the challenge set)
- B/D/E-stale always log to `graph-observations.jsonl`, never block
- Default mode is `shadow` so the cache fills via voluntary predictions before enforcement turns on

### Phase 4 — flip default to soft_gate (~1 week of calibration data first)

- Observe shadow-mode telemetry: how often E-fresh fires, distribution of cases, parse-failure rate
- If shadow data looks clean, flip default to `soft_gate` via `harness.graph_prediction.mode: "soft_gate"` in default config
- Run for one week; observe re-turn frequency, false-block rate, user friction
- If false-block rate > 5%, re-tune severity thresholds before flipping to `enforced`

### Phase 5 — enforcement (ack-required) (~2 days after Phase 4 stabilizes)

- Flip default mode to `enforced`
- Cap at one ack-request fire per edit
- Continue collecting telemetry; revisit predicate thresholds quarterly

### Phase 6 — deferred-comparison resolution (~3 days)

- On every PreToolUse, check for deferred predictions matching the target file; if shard now exists and is fresh, reveal the resolved diff
- 7-day TTL eviction job
- Unify with `claim_dependencies` in `prediction_calibration.jsonl` for cross-cutting analysis

Total remaining work: ~1 week + observation windows. Phase 5's enforcement gated on Phase 4's soft-gate calibration clearing acceptable thresholds.

---

## 15. Open questions

- **Per-section weights (§7.3) need empirical calibration.** Initial values are estimates. Phase 3 telemetry should reveal which sections carry signal vs noise; weights re-tune from data.

- **Severity thresholds (§7.4) need calibration.** Constants like "imported_by recall < 0.3 AND oracle ≥ 5 importers" are guesses. Phase 3 data feeds threshold adjustment.

- **Should observation-only cases (B/D/E-stale) ever escalate to enforcement?** Telemetry might show that Case D consistently correlates with downstream errors — in that case we could add Case D enforcement. Out of scope for v1.2; revisit after Phase 3 data.

- **`tool_input_hash` as cache key.** Currently logged but not key-affecting. If telemetry shows agents reuse stale predictions across distinct edit intents inappropriately, promote.

- **Cross-session prediction reuse.** v1 keeps cache per-session. If duplicate-prediction rate is high, revisit.

- **Ack format compliance enforcement.** Stop-hook regex check requires `graph_prediction_ack:` block format. Malformed ack → re-block once requesting structured form. Pattern matches `claim_dependencies:` enforcement.

- **Reads vs writes.** v1 gates on Write/Edit/MultiEdit/NotebookEdit/apply_patch only. Gating on `Read` would multiply fires; out of scope.

- **Heuristic-oracle predictions for Cases B/D.** v1.2 explicitly drops the heuristic-oracle path because PreToolUse can't ask without blocking. If a Read-side surface (e.g. `interlinked graph predict <file>`) is added later, the heuristic oracle could activate there outside the PreToolUse path.

---

## 16. Out of scope

- **Generating shards ourselves.** Protocol consumes Supermodel-emitted shards.
- **Cloud-side reconciliation.** All comparison is local.
- **Cross-developer aggregation.** Per-developer calibration data stays local.
- **Real-time daemon coordination.** Protocol uses filesystem state only.
- **Predictions for non-edit tool calls.** Read, Grep, etc. are exploration, not mutation.
- **Heuristic-oracle predictions in PreToolUse for Cases B/D.** v1.2 drops this.

---

## 17. Reference walkthrough

A representative session under v1.2:

**Setup.** Supermodel installed and running. Working tree contains real shards under `src/harness/`. Fixture shards under `src/harness/__tests__/fixtures/supermodel/` are correctly excluded by §3.1.

**Edit attempt.** Agent attempts to edit `src/harness/server.ts` (high-impact file in our hypothetical re-run).

**Workspace-level detection:** at least one shard-near-source pair exists in non-excluded paths. Workspace = active.

**Per-target classification:**
- Source exists at `src/harness/server.ts`; not in any excluded path
- Shard exists at `src/harness/server.graph.ts`
- `shard_mtime = 2026-05-09T14:32:00Z`, `source_mtime = 2026-05-09T14:00:00Z`
- `shard_mtime - source_mtime = +32min` → fresh
- → Case **E-fresh**

**Fire 1 — challenge:**
```
[interlinked:graph-pred] graph_prediction required for src/harness/server.ts.
Authoritative oracle: src/harness/server.graph.ts (mtime: 2026-05-09T14:32:00Z, fresh).
Emit your structured prediction in your next response, then retry the edit.
```

**Agent's response (prediction):**
```yaml
graph_prediction:
  file: src/harness/server.ts
  deps:
    imports: ["node:net", "./evaluator", "./reservations"]
    imported_by: ["src/index.ts"]
  calls:
    callers: ["main ← init"]
    callees: ["evaluatePostToolUse → evaluator/post-tool.ts"]
  impact:
    risk: medium
    domains: ["Server"]
    direct: 1
    transitive: 30
    affects: ["src/index.ts"]
```

**Fire 2 — comparison + reveal:**

Reconciliation against actual shard:

| Section | Predicted | Oracle | Score |
|---|---|---|---|
| `deps.imports` | 3 (3 match) | 3 | 1.0 |
| `deps.imported_by` | 1 (1 match) | 8 | recall 0.125, precision 1.0 → 0.125 |
| `calls.callers` | 1 (1 match) | 12 | recall 0.083 → 0.083 |
| `calls.callees` | 1 (1 match) | 23 | recall 0.043 → 0.043 |
| `impact.risk` | medium | high | 0.0 (high-severity trigger) |
| `impact.direct` | 1 (bucket "1-3") | 12 (bucket "10+") | 0.0 (off by >1 bucket; high-severity trigger) |
| `impact.transitive` | 30 (bucket "10+") | 67 (bucket "10+") | 0.7 (same bucket) |
| `impact.domains` | 1 (1 match) | 5 | recall 0.2 → 0.2 |

**Severity:** HIGH (multiple triggers fire). **Decision:** ack_required.

```
[interlinked:reconciliation] Comparison against src/harness/server.graph.ts:
  deps.imports:        match (3/3)                              ✓
  deps.imported_by:    predicted 1; actual 8                     ✗
  calls.callers:       predicted 1; actual 12                    ✗
  calls.callees:       predicted 1; actual 23                    ✗
  impact.risk:         predicted MEDIUM; actual HIGH              ✗ (high-severity trigger)
  impact.direct:       predicted 1; actual 12                     ✗ (high-severity trigger)
  impact.domains:      predicted [Server]; actual [Server, Evaluation, Lifecycle, Cohort, Reservations]
                                                                  missed 4 domains

  reason: "HIGH-severity miss on impact + callers. Acknowledge before proceeding."
```

**Fire 3 — agent acknowledges:**
```yaml
graph_prediction_ack:
  files:
    - file: src/harness/server.ts
      reason_for_ack: high_severity
      acknowledged_oracle_findings:
        - "8 importers (predicted 1)"
        - "12 callers (predicted 1)"
        - "5 domains (predicted [Server])"
        - "impact: HIGH (predicted MEDIUM)"
      proceeding_with_edit: revised_plan
      revised_plan_summary: |
        Will narrow the edit to a specific PostToolUse handler section
        rather than touching the central event dispatcher.
```

**Edit proceeds.** Calibration log records the high-severity miss + the agent's revised plan.

**Outcome.** Agent enters the edit with calibrated awareness: 12 callers (not 1), 8 importers (not 1), 5 domains (not 1), HIGH impact (not MEDIUM). Total token overhead: ~1,100 tokens — within the parent doc §8 wide-regime per-edit allocation.

The protocol's contract — *awareness before mutation* — is enforced precisely where the oracle is authoritative (Case E-fresh) and silent everywhere else. This is the v1.2 architectural commitment: don't run the protocol against non-authoritative oracles, don't enforce on advisory data, do force engagement when both stakes (high impact) and signal (authoritative shard) are present.
