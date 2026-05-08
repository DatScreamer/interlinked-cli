# Memory as a Hook-Insertion Primitive

**Status:** Plan / not yet implementation. New work; does not supersede any existing doc.

**Scope:** A runtime memory subsystem for the Interlinked free CLI and (optionally) Guardrails. Memories are short, scoped assertions that can alter the result of a `PreToolUse` (or `PostToolUse`) hook event by injecting `additional_context`, and can block only when they compile to a deterministic trigger with explicit block eligibility. Designed to run fully locally (free CLI) with optional cloud assist. Distinct from `cm context` style read-only retrieval and from conversational personalization, which is treated as inject-only context rather than a blocking guardrail.

**Audience:** Engineering, anyone building or evaluating the free CLI's harness.

**Companion docs:**
- [`three-product-architecture.md`](./three-product-architecture.md) — overall product split, latency budgets per tool class, escalation flow.
- [`free-cli-architecture.md`](./free-cli-architecture.md) — the daemon, socket RPC, `.interlinked/` layout, and future tool-call check declaration shape this subsystem may eventually share.
- [`../plans/free-cli-adoption/01-evaluator-architectural-upgrades.md`](../plans/free-cli-adoption/01-evaluator-architectural-upgrades.md) — evaluator changes this can share once tool-call checks exist.
- [`../plans/free-cli-adoption/05-trajectory-state-machine.md`](../plans/free-cli-adoption/05-trajectory-state-machine.md) — the trajectory layer that supplies "did the agent listen" signal.

**Sources studied (external):**
- `Dicklesworthstone/cass_memory_system` — the procedural-memory layer over agent sessions. Cloned at `reference-repos/cass_memory_system/`.
- `Dicklesworthstone/coding_agent_session_search` (cass) — the episodic-memory engine and embedder pattern that cass-memory sits on top of. Cloned at `reference-repos/coding_agent_session_search/`.

---

## TL;DR

cass-memory's procedural-memory tower (diary → reflector → validator → curator → playbook) is **architecturally interesting but the wrong shape for our problem.** It exists because its only delivery surface is `cm context` text the agent may or may not read. The correctness compensations (LLM reflector, 90-day decay, maturity ladder, evidence gate) are all working around an unenforceable contract.

We have an enforceable contract: the harness hook envelope. So we collapse the entire pipeline to:

1. A local memory store with append-only feedback, a compact manifest, and optional vector sidecars. SQLite is a later storage optimization, not a Phase-M0 assumption.
2. A daemon-side lookup path that first runs exact deterministic triggers (regex/AST/graph/git-history/check-result), then semantic top-K retrieval for inject-only guidance.
3. A combined score `relevance × confidence × maturity × scope_match`, used for ranking and injection. It is never sufficient for blocking by itself.
4. Two thresholds: `T_inject` injects rules as `additional_context`; `T_block` can return `decision: "block"` only when the matched memory is both `block_eligible` and `action_capability: "blockable"`.
5. A deterministic, append-only feedback loop driven by existing PostToolUse and session-state signals — "did the agent take a safer relevant action?" measured by exact comparators, check-resolution state, and trajectory evidence, never by an LLM on the hot path.

Embedding inference is local-first (FastEmbed/ONNX MiniLM, opt-in 90 MB), with a **hash-embedder fallback** (FNV-1a, 0 bytes) so the system has a non-trivial floor even with zero downloads. Cloud assist is reserved for offline rule mining and ambiguous-case classification, never the hot path.

The animal-kingdom test ("memory is whatever changes behavior") is the design's anchor: only behavior-changing artifacts are persisted; `helpful_count` increments only on observable relevant course corrections, not merely on "the next tool call was different."

---

## 1. Why cass-memory is the wrong template (despite being good)

cass-memory is a working reference. We borrow specific mechanisms from it (decay formula, hash-embedder fallback, append-only forget log, deterministic curator, embedding cache keyed by content hash). We do **not** borrow its top-level architecture, for three reasons:

### 1.1 Delivery-surface mismatch

cass-memory's `cm context` returns rules as text in stdout (`reference-repos/cass_memory_system/src/commands/context.ts:854-1039`). The agent must read and obey them. Our harness already returns `{ decision: "block" | "allow", reason?, additional_context? }` to a hook script that the runner *enforces*. The latter is a different category of object: a block changes the permission envelope, and an injection enters context through a protocol path rather than a best-effort CLI transcript.

This is the animal-kingdom point reduced to engineering: a system that *cannot* change behavior reliably needs all of cass-memory's correctness scaffolding (LLM-distilled rules, evidence gates, maturity tiers, decay) because each rule has only a probability of mattering. A system that *does* change behavior reliably needs much less, because every retrieval has a guaranteed downstream effect that can be measured.

### 1.2 Cost / latency mismatch

cass-memory's reflector (`reference-repos/cass_memory_system/src/reflect.ts:326-438`) does up to `maxReflectorIterations` (default 3) LLM calls per session at session-end batch time, and the validator (`README.md:1096-1120`) adds further LLM calls per delta. That is fine for a "weekly digest of agent learnings" product. It is a non-starter for a runtime hook that must answer in <800 ms p99 on the free tier with no per-request cost.

### 1.3 Storage and write-path mismatch

cass-memory writes YAML at `~/.cass-memory/playbook.yaml` (`reference-repos/cass_memory_system/src/playbook.ts:95-105`) with full-file rewrites under `withLock` (`reference-repos/cass_memory_system/src/lock.ts`). PlaybookBullet has 24 fields including a `feedbackEvents[]` array with full provenance per event (`reference-repos/cass_memory_system/src/types.ts:65-100`). Most of those fields are inputs to the recomputation of `effectiveScore` — i.e., they exist so the score can be reconstituted at read time.

For a hot-path system we want O(1) score lookup, not O(events) recomputation. Persist the precomputed counters; persist the feedback events in a separate append-only JSONL only as audit trail; rebuild counters periodically (daemon idle, batched). This is a small but consequential schema collapse.

### 1.4 What we keep from cass-memory

| Borrowed pattern | Source | Why we keep it |
|---|---|---|
| Decay formula `0.5^(age/halfLife)` with 4× harmful multiplier | `src/scoring.ts:30-104` | Right shape for time-decaying confidence. |
| Hash-embedder (FNV-1a, 384-dim, normalized) fallback when ML model absent | `coding_agent_session_search/README.md:236-259` (cass), and the cass-memory `none` model path in `src/semantic.ts:367-368` | Lets the free CLI ship a useful semantic floor in 0 bytes. |
| Embedding cache keyed by `contentHash(content)` | `src/semantic.ts:535-700` | Free invalidation on rule edit; same trick works for any structural fingerprint. |
| Append-only forget log + load-time filter | `src/playbook.ts:344-427` | Forgetting is durable and reversible; never destructive. |
| Maturity ladder as a *gate* for promotion to block-eligibility | `src/scoring.ts:110-145` | Prevents random embeddings from ever reaching the block threshold. |
| Trauma "scream + attach machine-readable warning" pattern | `src/commands/context.ts:649-679`, `src/trauma.ts:29-64` | Same idea as our existing destructive-command guard; we generalize it. |
| Provenance overwriting (never trust the proposer to identify itself) | `src/reflect.ts:266` (`sourceSession ?? sessionPath`) | We're applying it to memory provenance: the daemon records who/when, not the rule author. |

Things we explicitly *drop*:

- LLM reflector (out of hot-path budget; replaced by deterministic mining + optional offline mining).
- LLM validator (replaced by a `block_eligible` promotion gate that requires repeat-harmful evidence).
- Multi-iteration reflection loop (one pass, deterministic).
- YAML playbook (replaced by append-only local state plus compact manifests; SQLite remains an optional storage backend after packaging/runtime dependency review).
- The Diary working-memory layer (no analog needed; the harness already records every PreToolUse/PostToolUse).
- `maturity` as persisted state — recompute on read like cass-memory recomputes `effectiveScore` (`src/scoring.ts:110-145`).

---

## 2. Architectural anchor: behavior-change is the test

> *"In the animal kingdom, the only way to tell whether an animal actually has something memorized is if it changes its behavior."* — design constraint stated by Q.

Two consequences:

1. **Inputs that don't change behavior aren't memories.** A `cm context` style retrieval that the agent ignores is, by definition, not a memory under this contract. So we don't optimize for a retrieval that *might* matter; we wire memory directly into the only mechanism that *makes* it matter — the harness decision envelope.

2. **Feedback comes from observed behavior change, not annotations.** The cass-memory `helpful`/`harmful` deltas need an LLM to extract them from session text (`src/reflect.ts`) plus an outcome classifier (`src/outcome.ts`). We can replace the LLM with a deterministic comparator: did the next tool call's signature match the pattern the memory was warning against? This is cheap, reproducible, and runs on existing PostToolUse data with no extra agent action required.

This is the load-bearing architectural difference. Everything in §3–§5 is implementation that follows from it.

### 2.1 Memory classes and blockability

The system must not conflate "not regex-enforceable" with "not enforceable." Some useful memories are not expressible as a regular expression but still compile to deterministic checks:

- **AST / parser checks:** "Do not introduce React class components" or "no sync fs calls inside request handlers."
- **Import graph checks:** "UI cannot import from `db/`" or "public package exports cannot re-export internal helpers."
- **Git-history checks:** "First edit to billing this quarter; review the runbook before changing it."
- **Check-result checks:** "If this file repeatedly creates `export_surface` failures, surface the companion-file checklist before editing."

Those can warn or block depending on false-positive risk because they have deterministic triggers. The memories that should *not* block are the ones whose trigger is semantic, statistical, or personal:

- **Semantic taste / intent:** "Prefer data-oriented design over OOP unless the class earns its keep."
- **Proportion / scope judgment:** "This PR is doing two unrelated things."
- **Absence with semantic correctness:** "The rollback plan actually reverses this migration."
- **Statistical priors:** "This e2e suite is flaky about 30% of the time."
- **Human personalization:** "This user prefers terse follow-ups."

The type system should make this distinction explicit:

```typescript
export type MemoryTriggerKind =
  | "regex"
  | "ast-pattern"
  | "tool-args-shape"
  | "graph-query"
  | "git-history-query"
  | "check-result"
  | "semantic"
  | "statistical"
  | "personalization";

export type MemoryActionCapability =
  | "blockable"        // may block only with deterministic trigger + block_eligible
  | "inject_only"      // may alter additional_context, never decision
  | "personalization"; // separate conversational channel, never a safety gate
```

Hard invariant:

```typescript
function canEverBlock(memory: Memory): boolean {
  return memory.action_capability === "blockable"
    && memory.block_eligible
    && !["semantic", "statistical", "personalization"].includes(memory.trigger_kind);
}
```

Learned preferences may graduate into enforcement only when they compile down into a deterministic shape. Example: learning "this user names branches `qc/topic`" is a memory problem; enforcing it later can be a regex after human acceptance.

---

## 3. Data model

### 3.1 The `Memory` row

```typescript
// cli/src/harness/memory/types.ts (new)

export interface Memory {
  id: string;                    // ulid; stable across the lifetime of the rule
  display: {
    title: string;               // <=80 chars; what shows in additional_context lines
    description?: string;        // 1–2 sentence body; rendered when budget allows
  };
  content: string;               // canonical rule text; becomes block reason; also embedded for retrieval
  trigger_kind: MemoryTriggerKind;
  action_capability: MemoryActionCapability;
  signature_kind:
    | "regex"
    | "ast-pattern"
    | "tool-args-shape"
    | "graph-query"
    | "git-history-query"
    | "check-result"
    | "embedding-only"
    | "none";
  signature: string | null;      // serialized deterministic matcher; null for pure semantic/statistical memories
  embedding: Float32Array | null;// 384-dim if model available, else null (force hash mode)
  scope: {
    kind: "global" | "repo" | "path-glob" | "tool-name" | "language";
    value: string;               // glob, "Edit", "typescript", etc.
  };
  block_eligible: boolean;       // CAN this memory ever block? false by default for learned rules
  source: "hand" | "inline" | "learned" | "imported" | "pr-review";
  source_ref: string;            // file:line, session id, PR url
  // --- counters (precomputed, recomputed periodically) ---
  helpful_count: number;         // decay-adjusted
  harmful_count: number;         // decay-adjusted
  injection_count: number;       // how many times we've shown this to the agent
  block_count: number;           // how many times we've blocked with it
  last_event_ts: number;         // ms epoch; for staleness display
  created_at: number;
  updated_at: number;
}
```

Field-level notes:

- `display.title` / `display.description` exist to make `additional_context` skim-friendly. Title is what the agent sees per-line; description fills in only when the 1 KB envelope budget allows. `content` remains the canonical body and the block reason — the title/description split borrows the `{title, description, content}` shape from Google's ReasoningBank (`reference-repos`-external; arXiv 2509.25140) where it produced meaningfully more skim-able injected memories. Block path always uses `content` verbatim regardless of title/description.
- `trigger_kind` says what kind of evidence makes this memory relevant. It is intentionally broader than regex: AST, graph, git-history, and check-result memories can be deterministic and therefore potentially blockable.
- `action_capability` says what the memory may do. `semantic`, `statistical`, and `personalization` triggers must use `inject_only` or `personalization`; they are never `blockable`.
- `signature` is **not** the embedding. It's the cheap deterministic matcher used in the feedback loop ("did the next relevant call violate this rule?"). For most learned blockable rules it's a regex, AST pattern, graph query, git-history query, or check-result matcher. For pure semantic/statistical memories it is `null` and therefore cannot supply local compliance evidence.
- `block_eligible` defaults to `false` for `learned`, `embedding-only`, `semantic`, `statistical`, and `personalization` memories. Only `hand` and `imported` curated deterministic sources may start eligible; `learned` rules earn eligibility through promotion (§5.3).
- We store decayed counters (not the full event log) because decay is monotone — if we recompute counters periodically using stored event timestamps, we save the per-PreToolUse cost of summing N events. Event log is JSONL audit, not the source of truth for the score.

### 3.2 Storage layout

```
.interlinked/
├── memory/
│   ├── memories.jsonl                # M0 accepted rows; one normalized Memory per line
│   ├── counters.json                 # M0 derived counters, rebuildable from feedback-events
│   ├── embeddings.bin                # contiguous f32 buffer aligned to manifest order
│   ├── embeddings.meta.json          # model name, dimension, row offsets, content hashes
│   ├── feedback-events.jsonl         # append-only audit; rolled into counters periodically
│   ├── forget.jsonl                  # append-only; load-time filter (cass pattern)
│   └── promotion-log.jsonl           # append-only; every block_eligible flip
```

M0 should avoid a new native/runtime storage dependency. The current Interlinked CLI runtime dependency surface is intentionally small; the trigram index is a custom binary layout, not SQLite. So the first implementation should use JSONL + sidecar vectors and keep the SQLite schema below as the target once row counts, write concurrency, or query needs justify the packaging cost.

```sql
-- cli/src/harness/memory/schema.sql (post-M0 storage backend, not required for foundation)
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  trigger_kind    TEXT NOT NULL,
  action_capability TEXT NOT NULL,
  signature_kind  TEXT NOT NULL,
  signature       TEXT,
  embedding_offset INTEGER,           -- byte offset into embeddings.bin; NULL = hash-embedded only
  scope_kind      TEXT NOT NULL,
  scope_value     TEXT NOT NULL,
  block_eligible  INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL,
  source_ref      TEXT NOT NULL,
  helpful_count   REAL NOT NULL DEFAULT 0,
  harmful_count   REAL NOT NULL DEFAULT 0,
  injection_count INTEGER NOT NULL DEFAULT 0,
  block_count     INTEGER NOT NULL DEFAULT 0,
  last_event_ts   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_memory_scope ON memories(scope_kind, scope_value);
CREATE INDEX idx_memory_block_eligible ON memories(block_eligible) WHERE block_eligible = 1;
CREATE INDEX idx_memory_trigger ON memories(trigger_kind);
```

**Rationale for not starting with SQLite:** the daemon already holds the hot-path index in memory, accepted memory counts are expected to be small at first, and append-only JSONL avoids full-file playbook rewrites without adding a database dependency. If accepted memories grow toward the 5K soft cap, or if multiple writer processes become real rather than theoretical, move to SQLite behind the same `MemoryStore` interface.

**Embeddings as a sidecar `.bin`**: storing 384-dim f32 vectors inline with row metadata bloats JSON/SQLite reads. A flat `embeddings.bin` indexed by `embedding_offset` is mmap-able, gives O(1) per-row access, and lets the daemon load the whole vector index with one `mmap` call at startup. cass uses an analogous pattern (the FSVI format, `coding_agent_session_search/README.md:261-271`).

### 3.3 In-memory representation (daemon)

On daemon start (existing `cli/src/harness/server.ts` lifecycle, see `free-cli-architecture.md` §5):

```typescript
class MemoryIndex {
  private rows: Memory[];                       // manifest/DB order
  private vectors: Float32Array;                // dim × N, contiguous; mmapped
  private byScope: Map<string, number[]>;       // "path-glob:src/db/**" → row_ids
  private byTriggerKind: Map<string, number[]>; // deterministic candidates before vector search
  private byBlockEligible: number[];            // row_ids where block_eligible = 1
  private dirtyRows: Set<number>;               // accumulated in-memory edits
}
```

Load target: <200 ms for 5K rows including manifest/DB scan + mmap; once loaded, every query is O(N) flat MIPS plus O(1) score combination. We don't need HNSW or FAISS until N > 50K, which is far beyond per-workspace expectations.

---

## 4. The hot path

### 4.1 Where this slots into existing harness

`cli/src/harness/server.ts` already exposes a Unix socket; `cli/src/harness/evaluator/pre-tool.ts` is the current PreToolUse evaluator. The current check registry is file-content oriented (`fn(content, filePath)`) and has phases `pre_block | pre_warn | post`, so M0 should **not** pretend memory can land as a normal registry entry. It needs first-class daemon/evaluator integration first, with a later option to move behind an extended tool-call check registry if/when that interface exists.

M0 integration shape:

```typescript
interface MemoryRuntime {
  evaluatePreToolMemory(event: HarnessEvent, session: SessionTrajectory): MemoryDecisionFragment;
  observePostToolMemory(event: HarnessEvent, session: SessionTrajectory): void;
}

interface MemoryDecisionFragment {
  decision?: "block";
  reason?: string;
  additional_context?: string;
  warnings?: string[];
  receipt_id?: string;
  matched_memory_ids?: string[];
}
```

Order of operations:

1. Existing hard guards run first: destructive-command rules, protected files, repo confinement, content gates, and secret checks keep their current priority.
2. Memory then decorates an already-allowing decision with context, or blocks only when `canEverBlock(memory)` is true and an exact deterministic trigger matched.
3. The generated hook/provider response path must be updated in M1 so `allow + additional_context` on PreToolUse is actually surfaced consistently across supported runners. Today PostToolUse has the strongest model-visible advisory channel; PreToolUse allow-context support is runner-dependent.

### 4.2 Pipeline

```
PreToolUse event arrives at daemon
  │
  ├─ 0. Existing trauma regex scan (evaluator.ts; ~1 ms)        → may hard-block
  │
  ├─ 1. Build a tool-call signature and structured trigger context:
  │        sig = canonicalize(
  │          tool_name +
  │          arg_fingerprint(tool_args, max=512 chars) +
  │          touched_path_basename +
  │          last_user_message_excerpt(max=512 chars)
  │        )
  │
  ├─ 2. Run exact deterministic memory triggers                   <10 ms target
  │      regex / tool-args-shape / AST / graph-query /
  │      git-history-query / check-result
  │      These are the only candidates that may block.
  │
  ├─ 3. Embed sig for inject-only semantic lookup                  ~15 ms (warm)
  │      Default: local FastEmbed MiniLM (sentence-transformers/all-MiniLM-L6-v2)
  │      Fallback: FNV-1a hash embedder (cass pattern)             <1 ms
  │      Optional: remote bge-base via Workers AI                 ~80 ms (cloud users)
  │
  ├─ 4. Top-K cosine over MemoryIndex.vectors                     ~3 ms for 5K
  │      Pre-filter by scope: only rows with scope_kind=global
  │      OR a matching scope_value for the current cwd/path/tool
  │
  ├─ 5. For each top-K hit, compute combined score:
  │        score = relevance(cosine)
  │              × max(0.1, confidence)        # decayed_helpful − 4·decayed_harmful, normalized
  │              × maturity_multiplier         # 0.5/1.0/1.5 from candidate/established/proven
  │              × scope_match                 # 0 or 1
  │
  ├─ 6. Threshold dispatch:
  │      exact deterministic match AND score ≥ T_block AND canEverBlock(memory)
  │         → return { decision: "block", reason: memory.content,
  │                    receipt_id, matched_memory_id, score }
  │      score ≥ T_inject
  │         → return { decision: "allow",
  │                    additional_context: top-N rendered as bullets,
  │                    receipt_id, matched_memory_ids, scores }
  │      else
  │         → silent (decision: "allow", no context)
  │
  └─ 7. Async telemetry:
        - Log injection_count++ for every memory whose id was shown
        - Log block_count++ if blocked
        - Append to feedback-events.jsonl with receipt_id; this is what
          the post-hoc "did the agent listen" comparator reads
```

Total budget on the warm inject path: ~25 ms for embed + lookup + dispatch, well inside the Read tool-class budget of 300 ms (`three-product-architecture.md` §1). Deterministic trigger checks must remain bounded independently; graph/git-history queries need cached summaries or they move out of the hot path.

### 4.3 The signature canonicalizer

Stable embeddings require stable inputs. `canonicalize` collapses common noise:

- Replace absolute paths with `<repo>`-relative paths.
- Strip line/column numbers.
- Replace numeric literals >3 digits with `<NUM>` (timestamps, ports, byte sizes).
- Replace UUIDs / hex hashes >8 chars with `<HASH>`.
- Lowercase the tool_name; preserve arg keys but truncate string values to 256 chars.

Deterministic. No LLM. The same canonicalizer must be used at memory-creation time and at lookup time, so it lives in a shared module (`cli/src/harness/memory/canonicalize.ts`).

### 4.4 Threshold defaults and tuning

```typescript
export const MEMORY_THRESHOLDS = {
  T_inject: 0.45,   // cosine × confidence × maturity × scope
  T_block: 0.80,    // and exact deterministic trigger + canEverBlock(memory) must be true
} as const;
```

These are seed values, not laws. Calibration plan:

1. Phase 1 ships with `T_block = ∞` (i.e., memory never blocks; only injects). Collect data for 2–4 weeks across our internal workspaces.
2. Compute the score distribution of memory matches that *would have* blocked, and sanity-check by replaying against a held-out set of known-good and known-bad PreToolUse events.
3. Set `T_block` to a percentile that gives <1 false-block per 10K events on the held-out set. Document in `.interlinked/memory/thresholds.json` with a regression test pinning the value (same pattern as `DEFAULT_ADVISORY_SKIPS` in `cli/src/commands/verify.ts`, per `CLAUDE.md`).
4. Ship `T_block` rollout behind a config flag (`memory.blocking_enabled`); off by default; documented opt-in.

Semantic, statistical, and personalization memories ignore `T_block` entirely. They can rank highly enough to inject, but `block_eligible` remains false by construction.

---

## 5. The feedback loop (the animal-kingdom bit)

This is what replaces cass-memory's LLM reflector. It's the entire reason the system can be deterministic and fast.

### 5.1 Recording injections

When PreToolUse returns `additional_context` with memory ids, the daemon writes to `feedback-events.jsonl`:

```jsonl
{"schema":"v1","ts":1714435200000,"event":"injected","receipt_id":"r-01H...","session_id":"...","memory_ids":["m-01H...","m-01H..."],"tool_call":{"tool_name":"Edit","arg_fingerprint":"<canonicalized>"}}
```

When PreToolUse returns `decision: "block"`:

```jsonl
{"schema":"v1","ts":...,"event":"blocked","receipt_id":"...","memory_id":"m-...","tool_call":{...}}
```

These rows are **not** counters. They're the audit log. Counters are derived (§5.4).

### 5.2 The behavior-change comparator (PostToolUse)

After an injection, the daemon stores a pending observation in session state keyed by `receipt_id`, memory id, signature, scope, and a short TTL/window. The comparator should look at the next **relevant** tool call, not blindly the next tool call. Relevance means same session plus at least one of: same touched path/scope, same tool class, same check-result family, or same deterministic signature family.

Possible outcomes:

- **Repeated violation** — a relevant next call repeats the memory's deterministic signature. Append:
  ```jsonl
  {"event":"observed_repeated_violation","ts":...,"prior_receipt_id":"r-01H...","memory_id":"m-...","agent_behavior":"repeated_pattern"}
  ```
  This increments `harmful_count` because the memory failed to change behavior.

- **Safe alternative** — a relevant next call avoids the deterministic signature *and* either resolves the check that motivated the warning, selects a known safer tool/input shape, or satisfies the memory's `success_signature`. Append:
  ```jsonl
  {"event":"observed_safe_alternative","ts":...,"prior_receipt_id":"r-01H...","memory_id":"m-...","evidence":"check_resolved"}
  ```
  This increments `helpful_count`.

- **Irrelevant divergence** — the next call is different but unrelated. Append:
  ```jsonl
  {"event":"observed_irrelevant_divergence","ts":...,"prior_receipt_id":"r-01H...","memory_id":"m-..."}
  ```
  This updates neither helpful nor harmful counters. The first version of this design over-credited these cases as compliance; that would inflate confidence incorrectly.

- **Expired / session ended** — no relevant action happens before TTL or the session ends. Append an audit row only if useful for debugging; do not change counters.

The comparator is pure regex/AST/graph/check-result logic. Examples:

- `regex`: does the next canonicalized tool input still match `memory.signature`?
- `ast-pattern`: does the next edit remove the AST smell, or does the smell remain?
- `graph-query`: does the import graph still violate the layer rule?
- `check-result`: did an existing harness check stop firing for the same file/check family?

No LLM runs on the hot path. Implementation lives in `cli/src/harness/memory/comparator.ts` and should reuse existing session-state concepts, `feedback-effectiveness.ts`, and `error-history.ts` rather than creating a parallel truth source where possible.

For ambiguous cases (e.g., `signature_kind = "embedding-only"` rules where there's no exact matcher), we **don't** synthesize local helpful/harmful signals. They earn evidence only via:
- Inline `// [interlinked:helpful m-xyz - reason]` / `// [interlinked:harmful m-xyz - reason]` comments (cass-memory's inline-feedback pattern).
- The optional cloud classifier (§M5), fire-and-forget, batched.
- Human review in `interlinked memory review`.

### 5.3 Promotion to `block_eligible`

A `learned` memory becomes `block_eligible` when **all** of:

1. `injection_count ≥ N_min` (default 10)
2. `helpful_count / max(injection_count, 1) ≥ 0.7` — observed-helpful ratio
3. `harmful_count == 0` (no repeated relevant violations *after* injection — important: this is "the rule changed behavior", not "the original code was buggy")
4. Maturity = `proven` (computed: `helpful_count ≥ 10 AND harmful_ratio < 0.1`)
5. **A separate "second harmful trajectory" trigger fires** — the rule's signature matched a *fresh* harmful trajectory after creation. This is what differentiates "consistently followed" from "hasn't been tested yet." Recorded as a `recurrence_event` in `feedback-events.jsonl`.
6. `trigger_kind` is deterministic (`regex`, `ast-pattern`, `tool-args-shape`, `graph-query`, `git-history-query`, or `check-result`) and `action_capability === "blockable"`.

Promotion is recorded in `promotion-log.jsonl` and the row's `block_eligible` flips to 1. Reversal is a forget-log entry (cass pattern).

This is conservative on purpose. The user-stated requirement was that the higher threshold should cause blocking only with strong justification; the promotion gate is the strong justification, not the cosine value.

### 5.4 Counter recomputation

Daemon idle tick (or every 5 minutes, whichever first):

```typescript
async function recomputeCounters() {
  const events = await readNewFeedbackEvents();   // since last offset
  for (const event of events) {
    const m = memories.get(event.memory_id);
    if (!m) continue;
    if (event.event === "observed_safe_alternative") {
      m.helpful_count = decay(m.helpful_count, m.last_event_ts, event.ts) + 1;
    } else if (event.event === "observed_repeated_violation") {
      m.harmful_count = decay(m.harmful_count, m.last_event_ts, event.ts) + 1;
    }
    m.last_event_ts = event.ts;
    dirtyRows.add(m);
  }
  await flushDirty();
}

function decay(count: number, lastTs: number, nowTs: number) {
  const ageDays = (nowTs - lastTs) / 86_400_000;
  return count * Math.pow(0.5, ageDays / 90);   // cass formula, src/scoring.ts:30-43
}
```

Decay applied at **read time** during recompute, not lazily on every score lookup. Scoring on the hot path is then O(1) — just multiply the precomputed counter by `0.5^((now − last_event_ts)/halfLife)` once per match.

---

## 6. Embedding strategy

The choice of where embeddings come from is the single biggest knob between "free CLI works alone" and "needs cloud." The right answer is a layered fallback that always has a non-trivial floor.

Embedding is a retrieval mechanism, not an enforcement mechanism. A high semantic score can rank an inject-only memory, but blocking requires a deterministic trigger and `canEverBlock(memory)`.

### 6.1 Layer 1 — local ML (default for users who opt in to the download)

FastEmbed with `sentence-transformers/all-MiniLM-L6-v2` (384-dim, ~90 MB, ONNX). Reasoning:

- Same model cass uses (`coding_agent_session_search/README.md:218-225`).
- Already proven to work with the `@xenova/transformers` runtime path that cass-memory uses (`reference-repos/cass_memory_system/src/semantic.ts:14-360`).
- Sub-50 ms per embed on commodity hardware after warmup.
- Pure local inference, zero network.

Acquisition: `interlinked memory install --model minilm`. **Never auto-download** — same opt-in contract cass uses (`coding_agent_session_search/README.md:219`).

### 6.2 Layer 2 — hash embedder (default with no download)

FNV-1a feature hashing into a 384-dim L2-normalized vector. cass's exact algorithm (`coding_agent_session_search/README.md:236-259`):

1. Tokenize: lowercase, split on non-alphanumeric, drop tokens <2 chars.
2. FNV-1a hash each token.
3. Use hash to determine dimension index and sign (+1/−1) in 384-dim space.
4. L2-normalize.

Properties:
- **Not** semantic in the meaning sense; equivalent to weighted lexical overlap.
- Deterministic, instant, 0 bytes of model.
- Useful for "this tool call mentions DROP TABLE and so does memory m-foo."
- Ships in the binary.

Behavior: when `block_eligible` memories were created with the ML embedder, but the user is on hash-only, we **disable blocking** for those memories at lookup time and only inject. This prevents a hash-cosine false-positive from blocking on a rule that was promoted under the ML metric. Safe by construction.

### 6.3 Layer 3 — remote (Workers AI bge-base, cloud users only)

For users who opt into Guardrails (`free-cli-architecture.md` §10), the daemon can route the embed call to a Cloudflare Worker that runs `bge-base-en` via Workers AI. ~80 ms latency, 768-dim. This is opt-in and only used if `cloud.json` declares `memory.embedder = "remote"`. Fallback to layer 1 or 2 on any error.

### 6.4 Cache

Embedding cache keyed by `contentHash(canonicalSignature)`, exactly like cass-memory's pattern (`reference-repos/cass_memory_system/src/semantic.ts:535-700`):

```
.interlinked/memory/cache/embeddings-{model_name}.bin
```

If `model_name` changes, the cache is bypassed. If `content` changes, hash mismatches and we recompute. No manual eviction needed.

---

## 7. Memory creation (where do memories *come from*)

In order of "shippable today" → "needs cloud":

### 7.1 Hand-authored

`.interlinked/memories.json` (committed):

```json
{
  "memories": [
    {
      "id": "m-hand-no-sync-fs-in-handlers",
      "content": "Never use sync fs APIs inside HTTP handlers in this repo. Async-only — see ADR-0042.",
      "trigger_kind": "regex",
      "action_capability": "blockable",
      "signature_kind": "regex",
      "signature": "(?s)server\\.(get|post|put|delete)\\b.*\\bfs\\.(readFileSync|writeFileSync|existsSync)\\b",
      "scope": { "kind": "path-glob", "value": "src/api/**/*.ts" },
      "block_eligible": true,
      "source": "hand",
      "source_ref": "docs/adr/0042.md"
    }
  ]
}
```

This subsumes the existing trauma pattern set (`reference-repos/cass_memory_system/src/trauma.ts:29-64`) — they become hand-authored `block_eligible` memories with `signature_kind = "regex"`. Single mechanism for all hard guardrails.

A semantic memory from the same file looks different:

```json
{
  "id": "m-hand-prefer-data-oriented-design",
  "content": "This repo prefers data-oriented design. Avoid introducing classes unless the class owns meaningful state or polymorphism.",
  "trigger_kind": "semantic",
  "action_capability": "inject_only",
  "signature_kind": "none",
  "signature": null,
  "scope": { "kind": "repo", "value": "." },
  "block_eligible": false,
  "source": "hand",
  "source_ref": "docs/architecture.md"
}
```

It may be highly relevant when the agent edits a new abstraction, but it can never block because "unnecessary class" is a judgment, not a deterministic trigger.

### 7.2 Inline annotations

A PostToolUse parser scans new file content for:

```
// [interlinked:memory] never X here — Y
// [interlinked:helpful m-01H...] - that rule helped
// [interlinked:harmful m-01H... - reason]
```

Each becomes either a new `learned` memory (first form) or a feedback event (second/third forms). Identical to cass-memory's `parseInlineFeedback` (`reference-repos/cass_memory_system/src/orchestrator.ts:200-209`).

### 7.3 Auto-mined from harness signal

A daemon-idle batch job scans `feedback-events.jsonl` plus the existing PostToolUse error stream (`cli/src/harness/quality-checks.ts` results) for patterns like:

- "tsc error E2345 occurs after Edit on path matching X 5+ times this week" → propose memory.
- "destructive-command guard fired N times for command shape Y" → propose memory.

The proposer is **deterministic** (regex + frequency thresholds + signature stability), runs offline, and writes to `.interlinked/memory/proposed.jsonl` — never directly to the accepted memory store. A human or `interlinked memory accept <id>` promotes the proposal. Proposals are not retrievable until accepted.

This is the deterministic-mining alternative to cass-memory's LLM reflector. The cost is that we miss patterns the regex can't characterize; the benefit is no per-batch LLM cost and full reproducibility.

**Contrastive-trajectory mining (M3+).** A second deterministic source: when the canonicalizer (§4.3) produces near-identical signatures from two trajectories whose PostToolUse outcomes diverged — one ended with a `quality-checks` failure or harness `repeated_violation` event, the other resolved cleanly or hit `safe_alternative` — the diff between the two trajectories is a strong memory candidate. Concretely: bucket recent feedback events by `signature_hash` over a 30-day window; for each bucket with both `observed_violation` and `observed_safe_alternative` entries on at least three sessions, emit a proposal whose `signature` is the matched canonical pattern and whose `display.description` summarizes the divergence ("when X, Y diverges from Z by …"). This is the same idea as ReasoningBank's MaTTS contrastive distillation (arXiv 2509.25140), but applied offline to *already-observed* harness signal rather than to compute-allocated parallel rollouts. We do not generate trajectories; we mine the ones we have. Proposals follow the same accept-gate as §7.3's frequency miner — they go to `proposed.jsonl`, never directly into the accepted memory store.

### 7.4 Remote import (Guardrails-tier)

Cloud-side has access to cross-customer aggregates (with appropriate consent/anonymization, per `three-product-architecture.md` §6.4). Curated memories — e.g., "this CVE-laden npm package version" or "this prompt-injection pattern observed across N customers" — can be pushed down through the same signature-DB update channel Guardrails already uses for secret signatures (see Cedar policy + signature DB in `three-product-architecture.md` §3, lines 232-243). Free CLI receives no such pushes; this is paid-tier value.

### 7.5 PR-comment ingestion (Agent CI tier)

Reviewer says "we never use class components here" on a PR; Agent CI's GitHub App (per `three-product-architecture.md` §4.4 reporting surfaces) extracts the imperative, classifies via the deep-scan coordinator, and emits a memory candidate to the workspace's repo-scoped memory file. Human merges as part of the PR. This is the natural Agent-CI feature; not free-CLI.

### 7.6 Personalization ingestion

Human-preference memories ("this user prefers terse follow-ups", "after 9pm avoid proposing architecture work") are useful, but they are not guardrails. They should live in a separate personalization store or a distinct `action_capability: "personalization"` channel that can populate conversational `additional_context` without affecting hook decisions. Do not mix them with `block_eligible` safety memories.

---

## 8. The `additional_context` payload

When `T_inject ≤ score < T_block`, the hook decision returns:

```json
{
  "decision": "allow",
  "additional_context": "## Relevant memories\n\n- (blockable, proven, conf 0.83) **No sync fs in HTTP handlers** — Never use sync fs APIs inside HTTP handlers in src/api/. See ADR-0042.\n- (inject-only, established, conf 0.61) **Run schema check before commit** — When editing migrations, run `npm run check:schema` before commit.",
  "receipt_id": "r-01H...",
  "_internal": {
    "matched_memory_ids": ["m-...", "m-..."],
    "scores": [0.71, 0.52]
  }
}
```

Render rules:

- Top-N (default N=3) by combined score, descending.
- Each line: `(capability, maturity, conf <score>) **<display.title>** — <body>`. Body is `display.description` if present, else falls back to `content`. Confidence is the `confidence` factor in the score formula, surfaced so the agent can weight self-trust.
- Two-pass budgeting under the 1 KB cap: pass 1 emits title-only lines for all top-N matches; pass 2 fills in `description` per match in score-descending order until the budget is exhausted. This guarantees every match gets a title, then high-score matches get the fuller body.
- Hard cap: 1 KB total for `additional_context` to stay inside the existing PreToolUse envelope contract.
- M1 must update generated hook/provider response paths so `allow + additional_context` from PreToolUse is actually model-visible for every supported runner that claims support. Runners without a reliable PreToolUse allow-context surface should receive memory context through the next available advisory channel, never by converting injection into a block.

When `exact deterministic match AND score ≥ T_block AND canEverBlock(memory)`:

```json
{
  "decision": "block",
  "reason": "Memory m-hand-no-sync-fs: Never use sync fs APIs inside HTTP handlers in this repo. Async-only — see ADR-0042.",
  "receipt_id": "r-01H...",
  "_internal": { "matched_memory_id": "m-...", "score": 0.92 }
}
```

The reason is the memory's `content` verbatim. Same shape as the existing destructive-command guard's block reason — the runner already knows how to display this. Semantic, statistical, and personalization memories never reach this branch.

---

## 9. Where this lives in the codebase

```
cli/src/harness/memory/
├── types.ts                # Memory interface, schemas
├── store.ts                # JSONL/manifest M0 store behind MemoryStore
├── schema.sql              # optional post-M0 SQLite DDL
├── canonicalize.ts         # signature canonicalizer (shared)
├── trigger.ts              # deterministic trigger dispatch (regex/AST/graph/git/check)
├── embedder/
│   ├── index.ts            # backend selector
│   ├── fastembed.ts        # ML backend
│   ├── hash.ts             # FNV-1a fallback
│   └── remote.ts           # Workers AI / Guardrails (cloud users only)
├── index.ts                # in-memory MemoryIndex (vectors + scope buckets)
├── search.ts               # top-K lookup + score combination
├── comparator.ts           # behavior-change comparator (post-hoc)
├── feedback.ts             # event log writer + counter recomputer
├── promotion.ts            # block_eligible promotion gate
├── miner.ts                # offline auto-mining from harness signal
├── protocol.ts             # decision fragment + receipt/event types
└── thresholds.ts           # T_inject, T_block + calibration helpers

cli/src/harness/server.ts                  # wires MemoryRuntime around PreToolUse/PostToolUse
cli/src/harness/evaluator/pre-tool.ts      # may expose trigger context helpers
src/lib/hook-template-chunks/provider-responses.ts
src/lib/hooks-template.ts                  # PreToolUse allow + additional_context support

cli/src/commands/
└── memory.ts               # `interlinked memory <list|add|forget|accept|install>`
```

This sits alongside existing harness modules, but it is not purely a check-registry addition in M0. The registry can absorb memory later only after the tool-call `CheckDeclaration` shape from `free-cli-architecture.md` exists in code.

---

## 10. Phasing

Each phase ships independently and is measurable.

### Phase M0 — Foundation (1 week)
- `Memory` schema with `trigger_kind` and `action_capability`.
- JSONL/manifest store, hash embedder, in-memory index.
- First-class `MemoryRuntime` wired in server/evaluator in shadow mode; threshold = ∞ (no blocking, no user-visible injection unless debug flag is on).
- Deterministic trigger dispatcher for regex and tool-args-shape only; AST/graph/git/check-result interfaces stubbed but not enabled.
- `feedback-events.jsonl` writer.
- Hand-authored memories load from `.interlinked/memories.json`.
- **Ship:** internal use; collect data on what would match.
- **Decision gate:** at least one workspace shows ≥10 `memory_match` matches/week with reasonable signature stability (canonicalizer hash same for repeated patterns).

### Phase M1 — Inject (1 week)
- Set `T_inject = 0.45`. `additional_context` rendering live.
- Generated hook/provider response paths support PreToolUse `allow + additional_context` where runners can surface it; unsupported runners degrade to warnings or the next advisory channel.
- Behavior-change comparator runs on PostToolUse / next relevant PreToolUse with `safe_alternative`, `repeated_violation`, and `irrelevant_divergence` outcomes; appends to feedback log.
- Counter recomputer ticks every 5 min.
- `interlinked memory list/add/forget` commands.
- **Ship:** internal + 3–5 design partners.
- **Decision gate:** false-positive rate (irrelevant injection) <15% on a 200-event sample, measured by manual review.

### Phase M2 — Local ML + storage hardening (1 week)
- `interlinked memory install --model minilm` opt-in download.
- Embedder selector falls back hash → ml gracefully.
- Cache invalidation on model swap.
- Decide whether SQLite is worth adding as a runtime dependency. If yes, implement it behind `MemoryStore`; if no, keep JSONL/sidecar vectors until >5K accepted memories becomes real.
- **Ship:** internal + design partners.
- **Decision gate:** ml embedder doesn't blow the 800 ms modify-class budget at p99 (target: ≤80 ms p99 for embed).

### Phase M3 — Auto-mining (2 weeks)
- Deterministic miner reads PostToolUse error stream and `feedback-events.jsonl`.
- Writes proposals to `proposed.jsonl`; never auto-applies.
- `interlinked memory review` walks proposals interactively.
- **Ship:** all CLI users.
- **Decision gate:** ≥30% of proposed memories are accepted by reviewers; measure precision.

### Phase M4 — Promotion + blocking (3 weeks, careful)
- Promotion logic per §5.3; cron-like recurrence-event detector.
- `block_eligible` flag respected; `T_block = 0.80` shipped behind config flag `memory.blocking_enabled = false` by default.
- Blocking path requires deterministic `trigger_kind`, `action_capability: "blockable"`, exact trigger match, and replay evidence. Semantic/statistical/personalization memories remain inject-only forever.
- Backtest: replay last 30 days of internal PreToolUse against the new gate; tune thresholds per §4.4.
- Flip default to `true` only after 2 weeks of internal-only enabled state with zero false-block reports.
- **Ship:** behind flag at first.
- **Decision gate:** false-block rate <0.01% on backtest; no internal user reports a wrong block in 14 days enabled.

### Phase M5 — Cloud assist (Guardrails users only) (2 weeks)
- Remote embedder via Workers AI for cloud-opted users.
- Imported `block_eligible` memories from signature DB (curated, server-side).
- Optional async classifier for ambiguous-band cases (`T_inject ≤ score < T_block`) — fire-and-forget, contributes only to `recurrence_event` triggers.
- **Ship:** Guardrails Hobby+ tier.

---

## 11. Open questions

| Question | Lean | Resolve in |
|---|---|---|
| Does the canonicalizer need to be language-aware (TS-vs-Python AST normalization)? | No for v1 — regex over canonicalized strings is good enough. Revisit if false-positive rate is dominated by language ambiguity. | M3 retro |
| Do we surface `confidence` to the agent in `additional_context`, or strip it? | Surface — it lets the agent weight rules without us picking a binary "shown / hidden." | M1 |
| Can every runner surface PreToolUse `allow + additional_context`? | No assumption. M1 must test each adapter; unsupported runners degrade to warnings or next advisory channel. | M1 |
| What exact evidence qualifies as `safe_alternative`? | Start narrow: check resolved, deterministic signature avoided with same scope, or explicit success signature matched. Do not credit unrelated divergence. | M1 |
| Is SQLite worth adding as a runtime dependency? | Not for M0. Revisit after internal data shows JSONL/sidecar writes are a bottleneck or memory count approaches the 5K soft cap. | M2 |
| What's the storage budget per workspace? | Soft cap 5K memories, hard cap 50K. Mining miner enforces FIFO eviction of unaccepted proposals; accepted memories never auto-evict. | M3 |
| Should `block_eligible` flips require a commit (i.e., live in `memories.json`) rather than just `promotion-log.jsonl`? | Yes for `hand` source; no for `learned` (the promotion log is the audit trail). | M4 |
| How do we prevent an agent from synthesizing inline `[interlinked:helpful m-xyz]` comments to game its own memory? | Inline feedback is parsed only from files where the *user* committed the comment (git blame check), or from the agent's *own* PostToolUse Edit body where the agent is providing real-time inline feedback (acceptable, since the agent has every reason to log harmful, less reason to fake helpful). Mitigation: cap helpful-credit per-session per-memory at 1. | M3 |
| Where do personalization memories live? | Separate store/channel from hook-blocking safety memories. They may inject conversational context but never set `decision`. | M3 |
| What about repo-scoped memories that should be shared across teammates? | `.interlinked/memories.json` is committed (cass-memory has the same global/repo split, `reference-repos/cass_memory_system/src/playbook.ts:344-356`). Auto-mined memories live in the local `.interlinked/memory/` store, which is gitignored unless the user opts in via `interlinked memory share`. | M3 |

---

## 12. Architectural principles (the things to never compromise)

Mirroring `three-product-architecture.md` §Architectural Principles, specialized to this subsystem:

1. **Memory has a single test: did it change behavior.** No persisted artifact that doesn't go through the hook envelope. No `cm context`-style read-only retrieval as a primary product surface.
2. **The hot path stays deterministic.** No LLM, no network, on PreToolUse. Embedding is mathematics, not inference; lookup is flat MIPS, not a model call.
3. **Hash-embedder floor.** The free CLI must be useful with zero downloads. ML is an upgrade, never a precondition.
4. **Blockability requires deterministic triggers.** Regex is not the only enforceable shape — AST, graph, git-history, and check-result triggers can also block — but semantic/statistical/personalization memories are inject-only forever.
5. **`block_eligible` is earned.** Cosine similarity alone never blocks. Promotion is gated by a separate, conservative, evidence-driven path; demotion (forget log) is always available.
6. **Append-only data, derived counters.** `feedback-events.jsonl` and `forget.jsonl` are the source of truth; everything else is a cache that can be rebuilt. (Same shape as cass-memory's blocked.log + load-time filter.)
7. **Provenance is the daemon's responsibility, not the rule author's.** Memory IDs, source refs, and timestamps are stamped by the daemon at insertion time. Same instinct as cass-memory's "always overwrite `sourceSession` with the diary's path" (`reference-repos/cass_memory_system/src/reflect.ts:266`).
8. **Free CLI works fully alone.** Cloud assist is upgrade-only and never on the critical path of any blocking decision. Mirrors `three-product-architecture.md` Principle 1.
9. **Personalization is not a safety gate.** Human preference memories may affect tone and context, but they never block tools and should be isolated from safety memory promotion.
10. **Failures fail open.** Daemon unreachable, model missing, memory store locked → hook returns `decision: "allow"` with no memory context, never a hard fail. Same instinct as `feedback_safety_continuity.md` ("safety continuity over premature agent death").

---

## Appendix A — Source references (external)

- **cass-memory** — `Dicklesworthstone/cass_memory_system`, cloned at `reference-repos/cass_memory_system/`.
  - `src/types.ts:65-100` — PlaybookBullet schema (we collapse this).
  - `src/scoring.ts:30-145` — decay + maturity formulas (we keep, evaluate at recompute time).
  - `src/curate.ts:242-723` — deterministic curator (architectural inspiration; we do less).
  - `src/playbook.ts:344-427` — append-only blocked-log + load-time filter (we mirror as `forget.jsonl`).
  - `src/semantic.ts:14-700` — Xenova MiniLM + Ollama backends + cache pattern (we adopt FastEmbed equivalent + hash fallback).
  - `src/orchestrator.ts:200-209` — inline feedback parsing (we adopt verbatim).
  - `src/trauma.ts:29-64` — DOOM_PATTERNS (we generalize as hand-authored `block_eligible` memories).
  - `src/commands/context.ts:854-1039` — `cm context` text rendering (we *don't* do this; we use the hook envelope).
  - `README.md:1016-1180` — ACE pipeline writeup (rationale for what we drop).
- **cass (coding-agent-search)** — `Dicklesworthstone/coding_agent_session_search`, cloned at `reference-repos/coding_agent_session_search/`.
  - `README.md:236-259` — hash-embedder algorithm (FNV-1a, 384-dim).
  - `README.md:261-271` — FSVI vector index format (architectural reference for our `embeddings.bin`).
  - `README.md:272-298` — three search modes; lexical fail-open semantics (we mirror in our hash-fallback / disable-blocking-on-hash design).
- **ReasoningBank** — Ouyang et al., Google Cloud, April 2026. Paper: <https://arxiv.org/abs/2509.25140>. Code: <https://github.com/google-research/reasoning-bank>. Blog: <https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/>.
  - Memory item shape `{ title, description, content }` — borrowed for our `display.title` / `display.description` fields (§3.1, §8).
  - "Failures as preventative lessons" framing — we already do this via `harmful_count` and anti-pattern inversion, but ReasoningBank's framing is the cleaner externalization for user-facing docs.
  - Contrastive distillation in MaTTS (parallel-trajectory comparison to extract better memories) — adapted for our offline miner as "contrastive-trajectory mining" over already-observed harness signal (§7.3). We do not run parallel trajectories on the hot path; we mine the divergent ones we already have.
  - "LLM-as-judge is robust to judgment noise" finding — calibrates the precision bar for §M5 cloud assist (we don't need a perfect classifier).
  - Architectural divergences from ReasoningBank we keep: enforcement surface (block path), two-tier dispatch, `block_eligible` separation, deterministic comparator instead of LLM-as-judge on the hot path. ReasoningBank has none of these because its only delivery surface is prompt context — same delivery-surface gap as cass-memory (§1.1).

## Appendix B — Source references (internal)

- `docs/design/three-product-architecture.md` — §1 latency budgets, §2 free CLI scope, §3 Guardrails escalation, §6 cross-cutting concerns, §Architectural Principles.
- `docs/design/free-cli-architecture.md` — §5 daemon, §6 directory layout, §7 config schemas, §8 future check declaration format (eventual registry home after the runtime path exists), §9 telemetry wire format (we share `feedback-events.jsonl`'s line shape with `offline-spool.jsonl`), §10 cloud opt-in.
- `docs/plans/free-cli-adoption/01-evaluator-architectural-upgrades.md` — evaluator changes the memory runtime can eventually share once tool-call check declarations exist.
- `docs/plans/free-cli-adoption/05-trajectory-state-machine.md` — supplies the trajectory abstraction the comparator (§5.2) traverses.
- `CLAUDE.md` — harness file inventory; check-registry shape; advisory-vs-default-gate policy (the regression-test pinning pattern we mirror in §4.4).
- Memory notes (this user's persistent memory):
  - `feedback_harness_deterministic_only.md` — hot path stays deterministic; LLM only at narrow escalation points. Directly motivates §4 and §11.
  - `feedback_safety_continuity.md` — fail-open over fail-closed. Directly motivates Principle 8.
  - `project_llm_policy_enforcement.md` — narrow PreToolUse classifier; shadow then enforce. Same shape as the §M5 cloud assist rollout.
  - `feedback_taste_enforcement.md` — checks are taste levers; no diff-aware FP suppression as a built-in. Why §7.3's miner uses frequency thresholds rather than novelty filters.
  - `project_supervisor_pattern.md` — detection/decision separation. We split signature-matching (detection) from threshold dispatch (decision) for the same reason.
