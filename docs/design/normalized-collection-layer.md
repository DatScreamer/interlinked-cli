# Normalized Cross-Provider Data Collection Layer

**Status:** Draft for implementation handoff — 2026-05-19.
**v1 scope:** faithful provider capture (Tier 1): capture what each provider's
hooks deliver, normalize it into a provider-agnostic schema, and attach honest
fidelity and privacy metadata. **Not** true-source capture (Tier 2: shell
wrapper / PTY / filesystem snapshot) and **not** cloud upload or model training.
Those are consumers of this layer, not this layer itself.
**Priority order:** Claude Code → Codex → Gemini CLI / Copilot CLI / Cursor.
**Primary output:** `.interlinked/collection.jsonl` containing `collection.v1`
records. `activity.jsonl` remains the mixed local activity/audit log.
**Relationship to `hook-data-expansion.md`:** that doc's capture-widening plan is
partly implemented and partly stale. This doc is the authority for collection
schema and normalization. Reconcile the two when this lands.

---

## 0. Why this document exists

This doc came out of evaluating whether `.interlinked/activity.jsonl` could serve
as an ECHO-style training corpus (`docs/external-pulse/echo-rl.md`). The answer
was: it has valuable raw material, but it is not a clean corpus. It mixes guard
telemetry, pre-tool inputs, lifecycle events, provider-shaped tool responses,
thinking fields, prompts, edit echoes, and some real terminal/file observations.

The investigation also exposed several process failures that this design must
make hard to repeat:

1. **Stale-sample-as-proof.** A single old `Bash` row was cited as proof that
   terminal I/O was comprehensively collected.
2. **Trusting stale docs over code.** `hook-data-expansion.md` said full tool
   output was never collected; current code does persist `tool_input` and
   `tool_response`.
3. **"Field present" conflated with "output captured."** `tool_response` can be
   real terminal output (`Bash`), file contents (`Read`), fetched content
   (`WebFetch`), or a provider edit echo (`Edit`/`Write`). A populated field is
   not enough to know what was captured.
4. **Record-level fidelity was too coarse.** A shell response can have complete
   `stderr`, provider-truncated `stdout`, and an interlinked-capped structured
   payload in the same record.
5. **Provider-specific facts were over-generalized.** Capture coverage differs by
   provider and by installed hook configuration.

**Design consequence:** every observation-bearing field gets explicit
field-level fidelity. A consumer should never infer "complete output" from field
presence. It must read the fidelity metadata.

---

## 1. Current State (Verified 2026-05-19)

`activity.jsonl` is currently a mixed local audit log, not a training-ready
tool-I/O corpus.

Measured facts from the current workspace:

- A 500-record tail was dominated by guard and pre-tool rows: roughly 44%
  `guard_*`, 34% `tool_use_start`, and 11% `tool_use` rows that can carry a
  post-tool observation.
- The full live file still contains historical tool observations: roughly 3.3k
  `tool_use` rows with `tool_response`, including hundreds of `Read` rows and
  more than a thousand `Bash` rows. Those rows prove the hook can store output;
  they do not prove current installed configs are collecting every provider/tool.
- `appendLocal()` writes activity records with `schema_version: 4`; `appendGuardDecision()`
  writes guard records with `schema_version: 3`. The bare integer is effectively
  a record-kind discriminator, which has caused confusion.
- `Edit` / `Write` / `MultiEdit` `tool_response` is usually a provider edit echo:
  `oldString`, `newString`, `structuredPatch`, original file metadata, etc. It is
  useful audit data, but it is not terminal output.
- `Bash` `tool_response` is real environment observation when present, but it is
  provider-mediated and then interlinked-capped.
- `Read` `tool_response` is file content when present. Current installed Claude
  Code matcher drift can prevent new `Read` PostToolUse rows from arriving.
- Successful Bash output usually lives under `tool_response.stdout` or in a
  string `tool_response`, not top-level `stdout`. Top-level `stdout`/`stderr`
  are canonical error/outcome fields and are intentionally sparse.

### 1.1 Matcher Drift Is The Immediate Capture Bug

Source code intends broad PostToolUse capture:

- `src/lib/hook-installers.ts` sets `POST_TOOL_USE_MATCHER = ""`.
- Its comment explicitly says `""` is required so Bash stdout/stderr, Read file
  contents, Grep results, and WebFetch responses are not lost.

Installed configs in this workspace are stale:

- `.claude/settings.json` has `PostToolUse matcher: "Edit|Write|MultiEdit"`.
- `/Users/quentincody/.claude/settings.json` has duplicated scoped PostToolUse
  entries with the same matcher.
- `.codex/hooks.json` has `PostToolUse matcher: "Edit|Write|MultiEdit|apply_patch"`.

For Claude Code, scoped matchers mean non-edit tools (`Read`, `Bash`, `Grep`,
`WebFetch`, MCP calls) may never reach interlinked at PostToolUse. The first v1
implementation task is to make hook installation reconcile existing matchers to
the source-of-truth value and test that reconciliation.

### 1.2 Provider Shape Divergence

Examples observed or encoded in the normalizers:

- Claude Code `Bash`: structured object, typically `stdout`, `stderr`,
  `exitCode` / `exit_code`, `interrupted`, and related flags.
- Codex `Bash`: often plain string `tool_response`.
- `Read`: structured file payload when the provider emits it.
- `WebFetch`: structured response with status and result text.
- `Edit` / `Write`: provider-specific edit echo.
- Copilot/Cursor/Gemini need per-provider audit before claims become binding.

The normalized layer must preserve provider-native raw shape where useful, but
all consumers should read canonical `action`, `observation`, and `fidelity`
fields first.

---

## 2. Goals And Non-Goals

### Goals (v1)

- Emit one canonical provider-agnostic tool activity schema.
- Keep collection separate from local audit noise by writing a dedicated
  `.interlinked/collection.jsonl`.
- Faithfully capture provider-reported inputs and observations.
- Normalize provider divergences in shell output, file reads, edits/writes,
  search, fetch, and MCP calls.
- Attach field-level fidelity so truncation, absence, and source are explicit.
- Attach privacy/export metadata so later training/cloud consumers can filter
  safely.
- Fix installed matcher drift so Claude Code and Codex actually deliver
  non-edit PostToolUse observations.
- Provide deterministic tests that prove all canonical tool classes round-trip
  for each supported provider phase.

### Non-Goals (v1)

- True-source capture before provider truncation.
- Transcript ingestion.
- Cloud upload.
- Training, RL, or ECHO implementation.
- Normalizing `guard_*` telemetry records.
- Hook over-registration deduplication, except where it directly affects
  collection correctness.
- Perfect multimodal capture.

---

## 3. What Hooks Can And Cannot Collect

The hook is an observer downstream of the coding client. It does not execute the
tool. It receives a post-hoc notification and can only persist what the provider
puts in the payload.

| Data | Via hooks? | v1 handling |
|---|---|---|
| Tool name + full tool input | Yes | Canonical `action` plus provider raw input hash/ref. |
| Bash stdout / stderr / exit code | Provider-mediated | Canonical `shell_exec.observation`; mark provider truncation as `unknown` unless detected. |
| File read content | Matcher/provider-mediated | Canonical `file_read.observation`; fix matcher drift first. |
| File edit/write result | Yes, as provider echo | Normalize edit action; treat provider echo as application metadata, not terminal output. |
| Search results | Provider-mediated | Canonical `search.observation`; mark fidelity per result text. |
| MCP calls + responses | Provider-mediated | Canonical `mcp_call`; preserve server/tool/params. |
| WebFetch/WebSearch | Provider-mediated | Canonical `fetch`; redaction/export caution. |
| Timing, status, error text | Yes | Canonical metadata and observation fields. |
| User prompts | Yes | Existing activity path; collection may reference prompt id, but tool collection is not prompt collection. |
| Thinking/reasoning | Provider-dependent | Not part of `collection.v1` tool records; may be a separate transcript/turn stream later. |
| Token usage | Yes on lifecycle events | Not a tool observation; keep out of `collection.v1` or reference by turn/session. |
| Tool names available at session start | Usually yes | Capture as session metadata if needed; current activity keeps only count. |
| Full tool schemas | No | Not in hook payload. |
| Assistant narration between tools | No | Requires transcript ingestion if provider transcript exposes it. |
| Compaction summary content | No by hook payload | Provider-dependent transcript ingestion may recover it; not v1. |
| System/developer/provider prompts | No reliable hook source | Provider-dependent; do not claim complete capture. |
| Raw shell bytes before provider truncation | No | Tier 2 only: shell wrapper / PTY / tee. |
| Neutral filesystem state | No by hook alone | Tier 2 only: interlinked reads before/after snapshots. |
| Multimodal payloads | Effectively no | Large base64 is not useful after caps; needs a different path. |

**Net:** v1 creates a faithful normalized record of what providers reported. It
does not claim full context-window capture or true computer-output capture.

---

## 4. Canonical Records

v1 writes two related artifacts:

1. **Event records** in `.interlinked/collection.jsonl`: one record per pre/post
   tool hook event.
2. **Derived transition records** in a later export or view: one joined
   action→observation row for training/eval consumers. The transition view is
   derived from post rows and their pre rows by `tool_use_id`, `turn_id`, and
   provider-specific fallbacks. v1 should design for it, but it does not need a
   separate writer on day one.

### 4.1 Event Record Shape

```jsonc
{
  "schema": "collection.v1",
  "kind": "tool_event",
  "ts": "2026-05-19T12:00:00.000Z",
  "session_id": "...",
  "turn_id": "...",
  "tool_use_id": "...",
  "provider": "claude-code",
  "phase": "post",
  "tool_class": "shell_exec",
  "provider_tool": "Bash",
  "cwd": "/repo",
  "git": {
    "head": "...",
    "branch": "main"
  },
  "action": {
    "command": "npm test",
    "cwd": "/repo"
  },
  "observation": {
    "stdout": "...",
    "stderr": "",
    "exit_code": 0,
    "duration_ms": 1234
  },
  "fidelity": {
    "record": {
      "source": "provider_hook",
      "completeness": "complete"
    },
    "fields": {
      "observation.stdout": {
        "source": "provider_hook",
        "provider_truncated": "unknown",
        "interlinked_capped": false,
        "provider_payload_bytes": 1840,
        "captured_bytes": 1840,
        "completeness": "complete"
      },
      "observation.stderr": {
        "source": "provider_hook",
        "provider_truncated": false,
        "interlinked_capped": false,
        "provider_payload_bytes": 0,
        "captured_bytes": 0,
        "completeness": "complete"
      }
    }
  },
  "privacy": {
    "redaction_status": "unscanned",
    "redaction_passes": [],
    "sensitivity": "unknown",
    "contains_sensitive": "unknown",
    "allowed_for_training": false,
    "allowed_for_cloud_upload": false
  },
  "provider_raw": {
    "tool_input_ref": null,
    "tool_response_ref": null,
    "tool_input_sha256": "...",
    "tool_response_sha256": "..."
  }
}
```

### 4.2 Fidelity Semantics

Use these names precisely:

- `provider_payload_bytes`: bytes visible to interlinked before interlinked caps
  or redaction. This is **not** raw shell output size.
- `captured_bytes`: bytes stored in this record after interlinked caps/redaction.
- `provider_truncated`: `true`, `false`, or `"unknown"`. Default to `"unknown"`
  unless the provider exposes a flag or a recognized truncation marker.
- `interlinked_capped`: whether `capToolResponse` or a collection-stream cap
  shortened this field.
- `completeness`: one of `complete`, `provider_truncated`,
  `interlinked_capped`, `absent`, `redacted`, `unknown`.

Record-level fidelity is only a summary. Field-level fidelity is authoritative.

### 4.3 Privacy Semantics

Raw collection is local by default. Nothing in `collection.v1` is uploadable or
trainable until privacy metadata says so.

`privacy.redaction_status` values:

- `unscanned`: captured but not passed through the privacy scanner.
- `regex_scrubbed`: only deterministic secret/high-entropy scrub ran.
- `pii_scanned`: ML or configured PII scanner completed.
- `redacted`: sensitive spans were replaced.
- `quarantined`: raw record must not be exposed to agents or uploaded.
- `not_required`: record contains no observation payload that needs scanning.

Export defaults:

- `allowed_for_training: false`
- `allowed_for_cloud_upload: false`

An exporter may flip those only after policy checks, tenant consent, retention
rules, and redaction/scanner requirements pass.

### 4.4 Tool Classes

`tool_class` values:

- `shell_exec`
- `file_read`
- `file_edit`
- `file_write`
- `file_delete`
- `search`
- `mcp_call`
- `fetch`
- `task`
- `notebook_edit`
- `other`

Per-class shape:

| `tool_class` | `action` | `observation` |
|---|---|---|
| `shell_exec` | `{ command, cwd }` | `{ stdout, stderr, exit_code, duration_ms }` |
| `file_read` | `{ path, offset?, limit? }` | `{ content_ref? | content, line_count, byte_count }` |
| `file_edit` | `{ path, diff }` | `{ applied, result_message, provider_echo_ref? }` |
| `file_write` | `{ path, content_ref? | content, is_new_file }` | `{ applied, result_message, provider_echo_ref? }` |
| `file_delete` | `{ path }` | `{ deleted, result_message }` |
| `search` | `{ pattern, path?, flags? }` | `{ matches, match_count, result_text? }` |
| `mcp_call` | `{ server?, tool, params_ref? | params }` | `{ result_ref? | result }` |
| `fetch` | `{ url, prompt? }` | `{ status?, result_ref? | result, bytes? }` |
| `task` | `{ task, params? }` | `{ result? }` |
| `notebook_edit` | `{ path, cell?, diff? }` | `{ applied, result_message }` |
| `other` | `{ provider_input_ref? | provider_input }` | `{ provider_output_ref? | provider_output }` |

Large or sensitive fields should be stored by content-addressed reference once
blob storage exists. Inline fields are acceptable for v1 only under caps and
privacy metadata.

### 4.5 Derived Transition Shape

For ECHO/RL and analysis, consumers should use a derived transition view, not raw
event records:

```jsonc
{
  "schema": "collection-transition.v1",
  "session_id": "...",
  "turn_id": "...",
  "tool_use_id": "...",
  "provider": "claude-code",
  "tool_class": "shell_exec",
  "state_refs": {
    "git_head": "...",
    "previous_events": ["..."]
  },
  "action": { "command": "npm test", "cwd": "/repo" },
  "observation": { "stdout": "...", "stderr": "...", "exit_code": 1 },
  "labels": {
    "tool_outcome": "error",
    "post_tool_checks": ["vitest_failed"],
    "graph_reconciliation_id": null,
    "eventual_resolution": "unknown"
  },
  "fidelity": { "...": "field-level summary copied from event records" },
  "privacy": { "...": "export eligibility copied from event records" }
}
```

This distinction matters:

- Pre rows are audit events: action observed before execution.
- Post rows are provider observations: action plus result after execution.
- Transitions are training/eval records: normalized state + action + observation
  + labels.

---

## 5. Provider Normalization

interlinked already has the skeleton in
`src/lib/hook-template-chunks/event-normalizers.ts`. Those normalizers currently
produce a common activity envelope. v1 adds a second normalization layer that maps
each normalized event into `collection.v1`.

### 5.1 Edit/Diff Normalization

Canonical `file_edit.action.diff`:

```jsonc
{
  "hunks": [{ "old": "...", "new": "..." }],
  "unified": "optional unified diff when available"
}
```

Provider mappings:

| Provider | Native edit shape | Canonical mapping |
|---|---|---|
| Claude Code `Edit` | `old_string` / `new_string` | one hunk |
| Claude Code `MultiEdit` | `edits[]` | one hunk per edit |
| Claude Code `Write` | full `content` | `file_write`, not `file_edit` |
| Codex `apply_patch` | `*** Begin Patch` patch body | parse patch hunks |
| Cursor `afterFileEdit` | `edits[]` | one hunk per edit |
| Copilot patch tools | patch string in args | parse patch hunks |
| Gemini | provider payload audit required | map after fixture capture |

Do not treat provider edit echo as neutral truth. For Tier 1 it is a provider
report. Tier 2 may add filesystem before/after snapshots later.

### 5.2 Shell Output Normalization

Accept both common forms:

- structured object: `{ stdout, stderr, exitCode | exit_code | returncode, interrupted }`
- string: provider-rendered combined output

Mapping rules:

- If structured, preserve separate `stdout` and `stderr`.
- If string and no exit code is available, store it in `stdout` by default with
  `observation.combined_output = true`, unless the provider marks the call as
  failed and no better channel exists.
- Extract exit code from known fields when present.
- If interrupted is true, set `labels.tool_outcome = "interrupted"` in the
  transition view.
- Set `provider_truncated` to `"unknown"` unless a provider marker is recognized.

### 5.3 File Read Normalization

Accepted shapes include:

- `{ type: "text", file: { filePath, content } }`
- string file content
- provider-specific list/object forms to be audited per provider

Mapping rules:

- `action.path` comes from `tool_input.file_path`, `path`, or provider-specific
  equivalents.
- `observation.content` or `content_ref` contains returned text.
- `line_count` and `byte_count` are computed from the captured payload, not from
  on-disk file size.
- If no post event arrives because a matcher filtered it, emit no fake
  observation. The absence is measured by install/config tests, not by a dummy
  row.

### 5.4 Search, Fetch, MCP, And Task Normalization

Keep these intentionally conservative in v1:

- Preserve provider result text or structured result under `observation`.
- Preserve raw result refs/hashes so future normalizers can be improved without
  losing provenance.
- Do not over-parse before provider payload audits are complete.

---

## 6. Implementation Plan

### Step 1 — Fix Hook Matcher Drift

Update installed hook reconciliation so existing PostToolUse entries are rewritten
to source-of-truth matchers:

- Claude Code: `PostToolUse matcher = ""`.
- Codex: `PostToolUse matcher = ""` unless Codex semantics prove a narrower
  matcher is required. Current source expects `""`.
- User-scope duplicate Claude hooks must be detected and either updated or
  reported clearly; duplicate scoped hooks can still mask collection coverage.

Regression tests:

- Existing `.claude/settings.json` with `matcher: "Edit|Write|MultiEdit"` is
  updated to `""` by install/enable.
- Existing `.codex/hooks.json` with `matcher: "Edit|Write|MultiEdit|apply_patch"`
  is updated to `""`.
- PostToolUse matcher does not regress back to mutation-only.

Exit check:

- A Claude Code session that runs `Read`, `Bash`, `Grep`, and `WebFetch` produces
  `collection.v1` post records for all four.

### Step 2 — Add Canonical Builder

Add a pure builder in or near `event-normalizers.ts`:

```ts
function buildCollectionRecord(normalizedEvent: NormalizedEvent): CollectionRecord | null
```

Rules:

- Return records only for tool events in v1 (`PreToolUse`, `PostToolUse`, provider
  equivalents).
- Use namespaced `schema: "collection.v1"`.
- Fill `action` for pre and post events.
- Fill `observation` only when the provider supplied one.
- Fill field-level fidelity for every observation field.
- Fill privacy metadata with safe defaults.

### Step 3 — Write Dedicated Stream

`appendLocal()` should keep writing `activity.jsonl`. It should also append any
`collection.v1` record to `.interlinked/collection.jsonl`.

Do not put guard records in `collection.jsonl`.

### Step 4 — Fidelity Plumbing

Refactor `capToolResponse` so callers receive both payload and cap metadata, e.g.:

```ts
{
  value,
  providerPayloadBytes,
  capturedBytes,
  interlinkedCapped,
  cappedFields
}
```

Avoid the name `original_bytes`; it incorrectly implies true raw output size.

### Step 5 — Privacy Metadata And Export Gating

Initial writer sets conservative defaults. A later scanner/exporter can update or
emit a redacted derivative stream.

Required before any cloud/training exporter:

- deterministic secret/high-entropy scrub status
- optional PII scanner status
- tenant/repo consent
- retention policy
- right-to-delete story
- redacted blob references instead of raw sensitive inline content where needed

### Step 6 — Provider Parity Tests

For each provider phase, add fixtures for:

- shell success
- shell failure
- file read
- file edit
- file write
- search result
- fetch result
- MCP call if supported
- provider-truncated output fixture, if discoverable
- interlinked-capped output fixture

Every fixture should assert:

- canonical `tool_class`
- typed `action`
- typed `observation`
- field-level fidelity
- privacy defaults
- no guard telemetry in `collection.jsonl`

---

## 7. Deferred Work

### 7.1 Tier 2 True-Source Capture

Needed for real ECHO-style environment-token targets:

- shell wrapper or PTY to tee stdout/stderr/exit before the provider truncates
- filesystem before/after snapshots for file edits and reads
- content-addressed blob storage for large outputs
- opt-in policy because this is more invasive than provider hook observation

### 7.2 Transcript Ingestion

Provider transcripts may contain assistant narration, richer tool result context,
thinking, compaction-related context, and other material not present in hook
payloads. They should not be described as guaranteed complete context windows
until each provider is audited.

Transcript ingestion is a separate stream with separate privacy risks. It should:

- be opt-in
- record provider/version/source
- include redaction status
- preserve linkage to collection event ids
- mark unknown/missing sections rather than inventing completeness

### 7.3 Multimodal Capture

Do not attempt to preserve images/screenshots/PDFs as base64 inside JSONL. Use a
blob store with MIME type, dimensions/pages, hash, redaction status, and explicit
caps once a real multimodal use case exists.

### 7.4 Training And RL

`collection.v1` is a substrate. Training consumers should use derived transition
records, not raw activity logs. ECHO-style work needs:

- action→observation transitions
- masks separating real environment output from harness narration
- held-out evals
- privacy-filtered/export-eligible records
- online rollout environment if doing actual ECHO RL rather than supervised
  interaction-prior training

---

## 8. Rollout

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 | Claude Code: matcher reconciliation, canonical builder, `collection.v1`, field-level fidelity, privacy defaults | `Read`/`Bash`/`Grep`/`WebFetch`/edit/write fixtures and live probe produce valid records |
| 2 | Codex: same schema, `apply_patch` parser, shell string normalization | Codex shell + apply_patch records conform; matcher behavior audited |
| 3 | Gemini CLI, Copilot CLI, Cursor | Provider payload audits complete; fixtures conform |
| 4 | Exporter/view: `collection-transition.v1` | Joined action→observation records with labels, fidelity, privacy gates |
| 5 | Optional Tier 2 capture spike | PTY/shell wrapper and filesystem snapshot viability measured |

---

## 9. Open Questions

- Does `interlinked enable` currently update existing scoped matchers in all install
  paths, or only new entries?
- Should collection caps be higher than activity caps? If yes, what is the default
  and where is it configured?
- Where should large payload blobs live, and how are they garbage-collected?
- Which provider exposes explicit truncation metadata, if any?
- Should `collection.jsonl` store raw provider payload inline, by ref, or both under
  a size threshold?
- What exact privacy policy flips `allowed_for_training` or
  `allowed_for_cloud_upload`?
- Should user prompts be a separate normalized stream (`prompt.v1`) so tool
  collection stays narrowly scoped?
- Which fields are required for the first useful `collection-transition.v1` eval:
  tool outcome only, PostToolUse check ids, graph reconciliation ids, eventual
  resolution, or all of the above?

---

## 10. Handoff Checklist

- [ ] Add/update hook installer tests for matcher reconciliation.
- [ ] Add `CollectionRecord` TypeScript types.
- [ ] Add canonical builder with unit tests.
- [ ] Add field-level fidelity helper around `capToolResponse`.
- [ ] Add privacy metadata defaults.
- [ ] Write `.interlinked/collection.jsonl` from `appendLocal()`.
- [ ] Add Claude Code live probe for `Read`/`Bash`/`Grep`/`WebFetch`.
- [ ] Add Codex fixture tests for `apply_patch` and shell string output.
- [ ] Document exporter policy before any cloud/training use.
