# Durable sub-agent I/O capture (`.interlinked/agent-io.jsonl`)

**Status:** design, not built. **Date:** 2026-08-14.
**Companion:** `docs/design/luna-gate-audit-2026-08-14.md` (§1.4 is corrected below).

Everything in the "verified" tables was measured this session against the live
`.interlinked/` logs and the source at the cited `file:line`. Numbers come from
bounded tails, and each row says which window it was measured over. Nothing here
was inferred from prose.

---

## 1. Problem

`activity.jsonl` is the model for durable capture: every hook event is appended
synchronously, the file survives daemon restarts, `readLocalActivity`
(`src/lib/local-activity.ts:207`) merges it with `collection.jsonl` so no event
is lost, and `interlinked query` reads it.

A spawned sub-agent gets no equivalent. Its two most valuable artifacts — **what
it was told to do** and **what it returned** — are either absent, incidental, or
low-fidelity:

- **Input.** Measured over 1020 `agent_event` records (300 MB tail of
  `collection.jsonl`): **0 of 209 `subagent_start` records carry any input text,
  and 0 of 209 carry `agent_transcript_path`.** The spawn prompt does survive —
  but only as a side effect of the transcript drain, in a different file, under a
  different key, and only when the agent's transcript happens to exist at stop
  time.
- **Output.** `last_assistant_message` is captured, but it is the last *text*
  block, so an agent that returns through `StructuredOutput` has its real return
  value dropped. Measured since 2026-08-08 (n=187 stops): final-message length
  **p50 = 56 chars, p90 = 235**. The actual returns are ~3 KB and live in a
  third file.
- **No join, no query.** `interlinked query agents` renders `agent_name` and
  `action` — neither field exists on an `AgentEventRecord`. Run today it prints
  `null ·` for every row (verified).

This is not a missing feature so much as three half-captures in three stores with
no key between them.

---

## 2. Verified current state

### 2.1 What each store holds today

| Artifact | Store | Written by | Verified |
|---|---|---|---|
| Spawn prompt (Claude sub-agent) | `timeline.jsonl`, `category:"user_prompt"`, `is_sidechain:true`, `agent_id` | `captureAgentTranscript` (`timeline-capture.ts:147`) → `parseTranscriptText` (`transcript-record.ts:191,200`) | 135/135 distinct `agent_id`s in a 140 MB tail have one. Sample: `agent_id a7f28101f229ab906`, 1491 chars, `scrubbed:true` |
| Spawn prompt (Claude, via the `Agent` tool) | `activity.jsonl` `tool_use_start`, `tool_input.prompt` | hook PreToolUse, whole `tool_input` retained | 48 `Agent` rows in a 200 MB tail; keys `description,prompt,subagent_type`; prompt 1981 chars |
| Spawn prompt (workflow `agent()`) | `activity.jsonl` `Workflow` `tool_input.script` — the prompt is embedded in a JS source string | hook PreToolUse | 87 `Workflow` rows; per-agent `agent()` calls fire **no** hook of their own |
| Spawn assignment (Codex) | `activity.jsonl` `collaborationspawn_agent`, `tool_input.{task_name,model,reasoning_effort,message}` | hook PreToolUse/PostToolUse | 142 pre / 136 post rows; **137 distinct plaintext `task_name`s**; `message` is a Fernet token (`gAAAAAB…`) |
| Sub-agent lifecycle + label + cost | `collection.jsonl` `kind:"agent_event"` (`collection/types.ts:298`) | `captureAgentEvent` (`agent-event-capture.ts:251`), wired `lifecycle-events.ts:148-164` | 1020 records: 209 start / 791 stop / 20 task_completed |
| Sub-agent final prose | same record, `last_assistant_message` | `resolveFinalMessage` (`agent-event-capture.ts:145`) | 783/791 non-null; `message_source` payload 698 / transcript 85 / null 8 |
| Sub-agent **structured** return | `timeline.jsonl` `category:"tool_use"`, `tool_name:"StructuredOutput"`, full `tool_input` | same transcript drain (`transcript-record.ts:229`) | 91 agents in a 140 MB tail; sample serialized length 2995 bytes — **not referenced by the `agent_event` record at all** |
| Sub-agent tokens / tool ids | `agent_event.metrics` (`agent-metrics.ts:124`) | `readAgentMetrics` (`agent-event-context.ts:85`) | present; `tool_use_ids` is the documented join key back to `activity.jsonl` |
| Background-agent roster | `.interlinked/background-tasks.jsonl` | `recordBackgroundTasks` (`background-task-log.ts:138`) | live; carries `description` (a task label, not a prompt) |

### 2.2 Where it breaks

| # | Failure | Evidence |
|---|---|---|
| F1 | **Input is never captured at spawn time.** `SubagentStart` carries no prompt and no transcript path. | 0/209 starts have either. The payload census (`payload-key-census.ts:29`) has **no** `claude-code/SubagentStart` entry at all — i.e. that payload has zero keys outside the consumed whitelist, so there is nothing unconsumed left to wire. |
| F2 | **Input capture rides on the stop-time transcript drain**, which frequently finds nothing. `readAgentMetrics` returns null when the transcript is missing (`agent-event-context.ts:87`). | `metrics:null` on **123/187 (65.8%)** of stops since 2026-08-08, and 2/14 (14.3%) since 2026-08-12. Two stops sampled by id had `rows=0` in the timeline and no transcript on disk. |
| F3 | **The drain tail-reads, so a long agent loses its prompt first.** `captureAgentTranscript` reads only the last `MAX_ONESHOT_TRANSCRIPT_BYTES` = 8 MB (`timeline-capture.ts:133,151`) and drops the partial first line (`:158`). The spawn prompt is the transcript's **first** entry. | Structural; follows from the tail read. |
| F4 | **The captured "final message" is the last text block, not the return value.** `lastAssistantText` walks back for `type:"text"` only (`agent-event-capture.ts:116-131`); a `StructuredOutput` / `ReportFindings` terminal tool call is invisible to it. | p50 = 56 chars. Agent `a7f28101f229ab906` recorded `"All green: 67/67 tests pass… Let me also re-confirm typecheck"` (262 chars) while its actual 2995-byte return sat in `timeline.jsonl`. |
| F5 | **The agent-spawn tool is not classified**, so the prompt lands in an untyped bag. `classifyTool` (`collection/builder.ts:24-41`) has no `Agent`, no `Task`, no `spawn_agent` — all fall to `other`, whose action builder stores `provider_input` whole (`:224`). Zero `"tool":"Task"` rows exist in the entire 731 MB `activity.jsonl`. | `rg -c '"tool":"Task"' .interlinked/activity.jsonl` → exit 1 (no match). |
| F6 | **No key links the three halves.** The `Agent` PreToolUse row has a `tool_use_id`; `SubagentStart` has an unrelated `subagent_id`; the timeline row has `agent_id`. Only the last two agree. | `subagent_id a7f28101f229ab906` == timeline `agent_id`; the spawn tool call carries neither. |
| F7 | **The one query surface is broken.** `QUERY_SOURCES` `agents` displays `["agent_name","action"]` (`query/sources.ts:68-74`); `AgentEventRecord` has neither. | `node dist/index.js query agents --limit 3` → three rows of `null ·`. |
| F8 | **No recovery path covers sub-agents.** `timeline-backfill.ts:28-31` lists `readdirSync(dir).filter(endsWith('.jsonl'))` — flat, no recursion — while sub-agent transcripts live at `<session>/subagents/**/agent-*.jsonl`. | Verified by reading the function; the sampled paths are two directories deep. |
| F9 | **Capture ignores `dry_run`.** `captureAgentEvent` and `captureAgentTranscript` append unconditionally; only `background-task-log.ts:140` honors it. This violates the standing rule in CLAUDE.md ("A dry run must not move the gate"). | `rg -n 'dry_run'` over `agent-event-capture.ts`, `timeline-capture.ts`, `collection/writer.ts` → no matches. |
| F10 | **Start/stop counts do not reconcile**, so the remembered-label path (`rememberAgentType`, `agent-event-context.ts:40`) misses. | Since 2026-08-08: 130 starts vs 187 stops. Since 2026-08-12: 54 starts vs 14 stops. |

### 2.3 Correction to the Luna audit

`docs/design/luna-gate-audit-2026-08-14.md:95-104` states that Codex's
`spawn_agent` / `wait_agent` / `send_message` "are Codex-internal collaboration-tool
calls — they are never a shell exec or a file edit, so they never cross the
Interlinked hook boundary at all", and that "Interlinked has no record that 142
distinct sub-agents exist, let alone their task names".

**They do cross the boundary, and the task names are already stored.**
`activity.jsonl` holds 142 `collaborationspawn_agent` PreToolUse rows and 136
PostToolUse rows for session `019ffaa5-f290-7963-9b41-7d47cd40b281` — the exact
142 the audit counted — with **137 distinct plaintext `task_name` values**
(`kill_auth_mutants`, `sweep_contract_test`, `fix_hook_entry_mutation_hermeticity`,
…), plus `model` (`gpt-5.6-luna`) and `reasoning_effort`. Also captured:
`collaborationwait_agent` (346), `collaborationfollowup_task` (53),
`collaborationsend_message` (20), `collaborationlist_agents` (112).

What the audit got right is narrower and still decisive: the `message` field —
the actual task text — is a Fernet token, so **the instruction** is unreadable.
The audit's conclusion ("reconstructing what Luna was told is possible only by
inference") stands; its premise ("no hook, no record, no names") does not. The
practical difference is large: sub-agent *identity, count, model, effort tier and
task label* are recoverable for Codex today and merely unqueried.

---

## 3. Per-runner capturability

| Runner | Spawn fires a hook? | Input observable | Output observable | Verified by |
|---|---|---|---|---|
| **Claude Code — `Agent` tool** | Yes, PreToolUse | **Full prompt** in `tool_input.prompt` | **No** — the `Agent` PostToolUse row carries no `tool_response` (keys end at `event_id`); the result arrives only via `SubagentStop` | 48 rows; post-row key dump |
| **Claude Code — workflow `agent()`** | Only the enclosing `Workflow` PreToolUse | Prompt array embedded in `tool_input.script`; no per-agent event | Per-agent `SubagentStop` + transcript | 87 `Workflow` rows; 97 `workflow-subagent` stops |
| **Claude Code — `SubagentStart` / `SubagentStop`** | Yes | **Nothing** (F1) | `last_assistant_message` (payload or transcript tail) | normalizers `event-normalizers-claude.ts:471-488` |
| **Claude Code — background agent** | `SubagentStop` may not fire; result is delivered by queue notification | Nothing | Roster row only (`background-tasks.jsonl`), `description` not prompt | `background-task-log.ts:1-18` |
| **Codex — `spawn_agent`** | **Yes**, PreToolUse + PostToolUse | `task_name` / `model` / `reasoning_effort` **plaintext**; `message` **Fernet-encrypted** | `wait_agent` post-event `observation.provider_output` — but every sampled value was `{"message":"Wait interrupted by new input.","timed_out":false}`; no sub-agent result observed | 142/136 rows; `coll_tail` wait_agent dump |
| **Codex — subagent lifecycle** | **No** — census has only `codex/{UserPromptSubmit,PreToolUse,PostToolUse,Stop}` | — | — | `payload-keys.json` |
| **Cursor** | Yes — normalizer exists | `subagentStart.task` is delivered but **truncated to 200 chars** into `tool_input_summary`; full text discarded | `subagentStop.summary` → `last_assistant_message` | `event-normalizers-cursor.ts:225-251` |
| **Gemini CLI** | **No subagent normalizer exists** | Nothing | Nothing | `event-normalizers-gemini.ts` has zero `subagent` matches |
| **Copilot CLI** | **No subagent normalizer exists** | Nothing | Nothing | `event-normalizers-copilot.ts` has zero `subagent` matches |

Timeline provider split over a 140 MB tail: `claude-code` 40971, untagged (read as
claude-code) 35603, **`codex` 0**. `interlinked collect --provider codex` can fold
`~/.codex/sessions/` rollouts in (`src/commands/collect.ts:34-48`) but has not
been run against this window.

---

## 4. Decision: a new `.interlinked/agent-io.jsonl`

**Recommendation: new store.** Not an extension of `collection.jsonl` or
`timeline.jsonl`.

Why not `collection.jsonl` `agent_event`: it is a *lifecycle* record — one row per
hook event, three event kinds, already carrying a metrics blob. Sub-agent I/O is a
different cardinality (one row per direction, sometimes several output rows per
agent) and a different size class (multi-KB content, sometimes blob-referenced).
Widening `AgentEventRecord` makes every start row pay for the stop row's payload,
and there is no natural place for a spawn-tool row that exists *before* any
`subagent_id` does.

Why not `timeline.jsonl`: it is transcript-derived and keyed `uuid#seq`
(`timeline-writer.ts:37`). It genuinely holds the best copy of Claude input and
structured output today — but it can only ever hold what a Claude-shaped
transcript contains. Codex spawn rows, Cursor `task` text, and background-agent
rosters have no transcript and therefore no `uuid`, so they cannot be represented.
A store that structurally excludes three of five runners cannot be the canonical
cross-runner store.

`agent-io.jsonl` is therefore a **projection store**, exactly as
`collection.jsonl` is for tool events: it does not replace the sources, it is the
one place a reader goes for "what did agent X get, and what did it return", with
provenance back to whichever source supplied each row.

### 4.1 Schema (`agent-io.v1`)

```jsonc
{
  "schema": "agent-io.v1",
  "ts": "2026-08-14T21:30:56.461Z",
  "seq": 4821,                      // per-session ordinal, same convention as collection.v1
  "session": "c28e9a81-…",          // the session the hook was delivered under
  "parent_session": null,           // set when the runner distinguishes it; null on Claude
                                    // (sidechain entries reuse the parent session id)
  "agent_id": "a7f28101f229ab906",  // subagent_id / agent_id / timeline agent_id — one id space
  "spawn_tool_use_id": "toolu_…",   // the spawn CALL's id; the F6 bridge. null when unknown
  "agent_label": "workflow-subagent",
  "agent_label_source": "payload",  // payload | start_event | spawn_tool  (see AgentTypeSource)
  "runner": "claude-code",          // claude-code | codex | cursor | copilot | gemini-cli
  "direction": "output",            // input | output
  "role": "user",                   // user for input, assistant for output
  "kind": "structured_result",      // spawn_prompt | task_label | interim_message |
                                    // final_message | structured_result
  "source": "transcript",           // spawn_tool | payload | transcript | structured_output
  "content": "…",                   // inline when <= INLINE_MAX_BYTES
  "content_ref": null,              // else "blobs/<sha256>" under .interlinked/agent-io/
  "content_sha256": "9f2c…",        // ALWAYS set, inline or not — the dedup + integrity key
  "content_bytes": 2995,            // pre-truncation size
  "truncated": false,
  "content_status": "captured",     // captured | encrypted_by_runner | unavailable
  "scrubbed": true,
  "redaction_passes": ["secrets", "pii"],
  "tokens": { "input": 868, "output": 536043, "cache_read": 168371210, "cache_creation": 2048579 },
  "tool_use_ids": ["toolu_…"],      // output rows only; capped at MAX_TOOL_USE_IDS (2000)
  "tool_use_ids_truncated": false,
  "cwd": "/Users/quentincody/interlinked-cli",
  "dry_run": false
}
```

Notes on the fields that carry weight:

- **`content_status`** is what makes Codex representable. A `spawn_agent` row is
  written with `kind:"task_label"`, `content: "kill_auth_mutants"`, and a second
  row with `kind:"spawn_prompt"`, `content: null`,
  `content_status:"encrypted_by_runner"`. Absence is then recorded as a *fact*
  rather than as a missing row — the same discipline `metrics: null` already uses
  ("not measured" ≠ "did nothing", `agent-event-context.ts:80-84`).
- **`content_sha256` is always present.** It makes rows idempotent under re-drain
  and under backfill, which is the property `timeline-writer.ts` gets from
  `uuid#seq` and which a projection store otherwise lacks.
- **`spawn_tool_use_id`** is the F6 bridge and the only genuinely new correlation.
  See §5.1 for how it is resolved.
- **Bounding.** `INLINE_MAX_BYTES` = 64 KB, matching `FINAL_MESSAGE_MAX_CHARS`
  (`agent-event-capture.ts:58`). Beyond it, write a content-addressed blob under
  `.interlinked/agent-io/blobs/<sha256>` — reuse the pattern already proven in
  `scratchpad-archive.ts:223-228` (hash, skip write when the blob exists).
- **Scrub.** Every natural-language field goes through
  `redactPii(scrubSecrets(text).text).text`, identical to `scrubFinalMessage`
  (`agent-event-capture.ts:135`). Blob content is scrubbed **before** hashing, so
  the hash identifies the stored bytes.
- **`dry_run`** is threaded and honored, closing F9. A `harness test --write`
  probe must append nothing.

### 4.2 Constants

| Constant | Value | Rationale |
|---|---|---|
| `INLINE_MAX_BYTES` | 65 536 | parity with `FINAL_MESSAGE_MAX_CHARS` |
| `PROMPT_HEAD_BYTES` | 256 × 1024 | **head** read of an agent transcript for the first user message — the mirror of `FINAL_MESSAGE_TAIL_BYTES`, and the fix for F3 |
| `MAX_TOOL_USE_IDS` | 2 000 | reuse `agent-metrics.ts:32` |
| `MAX_BLOB_BYTES` | 8 × 1024 × 1024 | one agent's return must not become a second transcript |

---

## 5. Capture surfaces to wire

Each surface is fail-open and best-effort, per `feedback_safety_continuity`.

### 5.1 PreToolUse on an agent-spawn tool → `direction:"input"`

New evaluator seam, called from the PreToolUse path. Recognize the spawn verbs by
name: `Agent`, `Task`, `collaborationspawn_agent`, `collaborationfollowup_task`,
plus the Cursor equivalent. Write one row per spawn with
`source:"spawn_tool"`, `agent_id: null`, and `spawn_tool_use_id` set.

Resolving `agent_id` (F6): the spawn call and the `SubagentStart` that follows it
carry no shared id. Bind them the way `rememberAgentType`
(`agent-event-context.ts:40-49`) already binds labels — a bounded, insertion-ordered
per-session map of *pending spawns*, drained FIFO by the next `SubagentStart` in
the same session whose `agent_type` matches the spawn's `subagent_type`. When the
match is ambiguous, leave `agent_id` null and set
`agent_label_source:"spawn_tool"` — a row with a prompt and no id is still
strictly better than no row, and the ambiguity is recorded rather than guessed.

Codex needs no such binding: `task_name` is unique per spawn (137 distinct of 142)
and serves as the correlation key on its own.

### 5.2 `SubagentStart` → open the agent

Write the identity row (`agent_id`, `agent_label`, `runner`, `cwd`). No content —
F1 says there is none, and the census will report it the moment that changes.
This is also where a pending spawn row from §5.1 is back-filled with its
`agent_id`.

### 5.3 `SubagentStop` → `direction:"output"`, up to three rows

1. `kind:"final_message"` — today's `resolveFinalMessage` result, unchanged.
2. `kind:"structured_result"` — **new.** Walk the transcript tail for the last
   `tool_use` block whose name is a return verb (`StructuredOutput`,
   `ReportFindings`) and store its `tool_input`. This is the fix for F4 and it
   costs nothing extra: the tail is already read by `resolveFinalMessage`, and
   `lastAssistantText` (`agent-event-capture.ts:116`) already walks it backwards.
   Generalize that walk to return the last *terminal block* — text or return-verb
   tool_use — instead of the last text block.
3. `kind:"spawn_prompt"` — **new.** A `PROMPT_HEAD_BYTES` **head** read of
   `agent_transcript_path` for the first `type:"user"` entry. This is the durable
   input capture and it must not reuse the 8 MB tail (F3).

`tokens` and `tool_use_ids` come from the existing `readAgentMetrics` result — no
second transcript read.

### 5.4 Cursor — keep the full task text

`event-normalizers-cursor.ts:227` truncates `input.task` to 200 chars into
`tool_input_summary`. Carry the untruncated value through as a distinct field so
§5.2 can write it as a `spawn_prompt` row. This is the single cheapest capacity
gain in the matrix: the data is already on the wire and is being discarded.

### 5.5 Codex — record the label, record the absence

From the existing `collaborationspawn_agent` PreToolUse row, write a
`kind:"task_label"` row (plaintext `task_name`, `model`, `reasoning_effort`) and a
`kind:"spawn_prompt"` row with `content_status:"encrypted_by_runner"`. Detect the
Fernet shape (`gAAAAA` prefix) rather than assuming it, so a future plaintext
payload is captured instead of being written off.

### 5.6 Census

Add `agent-io.jsonl`'s new readers to `CONSUMED_PAYLOAD_KEYS`
(`payload-key-census.ts:29`) in the same change — the standing rule in CLAUDE.md.
`task`, `summary`, `subagent_type`, `task_name`, `reasoning_effort` are the keys
this work starts reading.

---

## 6. Recovery, query, index

**Recovery.** Add `backfillAgentIo(cwd, homeDir)` beside `backfillTimeline`.
`transcriptFiles` (`timeline-backfill.ts:28`) is flat; sub-agent transcripts sit
at `<slug>/<session>/subagents/**/agent-*.jsonl`, so the backfill needs one
recursive walk. Every record is idempotent by `content_sha256` + `agent_id` +
`kind`, so a re-run converges — the same guarantee `writeTimeline` gets from
`uuid#seq`. This is the *only* way to recover the 65.8% of stops whose transcript
was unreadable at stop time but exists now (F2), and it should run from
`interlinked collect` alongside the Codex path.

**Query.** Add an `agent-io` source to `QUERY_SOURCES`
(`query/sources.ts:25`):

```ts
{ name: "agent-io", file: "agent-io.jsonl", where: [],
  fields: ["agent_id", "runner", "direction", "kind", "content_bytes"],
  hint: "sub-agent prompts + returns (try --where direction=input)" }
```

and **fix the existing `agents` source in the same change** (F7): replace
`["agent_name", "action"]` with `["event", "agent_type", "subagent_id"]`, which
are fields `AgentEventRecord` actually has. A pinning test should assert every
`QUERY_SOURCES` field list is a subset of its record type's keys — this class of
bug is silent today.

**Index.** `.interlinked/INDEX.md` is hand-maintained and already stale (it
reports `collection.jsonl` at 402 M; it is 634 M today). Add one row for
`agent-io.jsonl` and one bounded recipe:

```bash
interlinked query agent-io --where direction=input --limit 20
```

---

## 7. What stays structurally unreachable

| Lost | Why | Best available substitute |
|---|---|---|
| Codex sub-agent **task text** | Fernet-encrypted at rest by the runner, in both directions; never plaintext at the hook boundary | `task_name` (137 distinct, plaintext), model, effort tier, plus the sub-agent's diffs |
| Gemini / Copilot sub-agent I/O | Those runners fire no subagent hook, and no normalizer exists to receive one | none — this is a runner capability gap, not a capture bug |
| Background-agent **result** when no `SubagentStop` fires | Delivered to the parent over a queue notification, which fires no hook | `background-tasks.jsonl` roster row (`id`, `status`, `description`) |
| Per-agent input for workflow `agent()` calls, at spawn time | The runner fires one `Workflow` PreToolUse for the whole script; individual `agent()` calls fire nothing | the prompt array inside `tool_input.script`, plus the per-agent `spawn_prompt` row recovered at stop from the transcript head (§5.3) |
| Agents whose transcript never materializes **and** whose payload carries no message | Nothing was ever written anywhere | nothing; 8/791 stops measured in this state |
| True `parent_session` on Claude sidechains | Sidechain transcript entries reuse the parent's `sessionId` (`transcript-record.ts:52-56`); the runner does not mint a child session id | `agent_id` + `is_sidechain` |

---

## 8. Suggested order

1. **Fix F7 + F9 first** — a one-line field-list correction and a `dry_run`
   thread. Both are small, both are currently wrong, and F7 makes every later
   step observable.
2. **§5.3 rows 2 and 3** (structured result + transcript-head prompt). Highest
   value per line: they reuse a read that already happens and they close F3/F4.
3. **`backfillAgentIo`** — recovers the existing corpus, and is the only step that
   can validate the schema against ~1000 historical agents before anything new
   depends on it.
4. **§5.1 spawn-tool capture + §5.4 Cursor** — new wiring, needs the pending-spawn
   binding.
5. **§5.5 Codex** — cheap, and it converts the Luna audit's "no record" into a
   queryable roster of 142 agents.
