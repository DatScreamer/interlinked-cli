# G1 — Exact model-input capture (inference-boundary logger)

**Status:** Design. **Effort:** 1–2 days for the local proxy; +0.5 day for the assembler join.
**Scope:** new `scripts/inference-proxy.mjs` (standalone) OR a managed AI Gateway; new `src/harness/replay/inference-store.ts` (envelope schema + reader); assembler join in Tier 1.
**Depends on:** [G3](./g3-event-ordinal.md) (for `seq`). **Consumed by:** [Tier 1](./tier1-teacher-forced-eval.md), [Tier 2](./tier2-onpolicy-env.md).
**Related:** `scripts/replay-run.mjs` (currently *reconstructs* system+tools — this replaces the reconstruction with the real thing).

## Problem

The single hard gap. Verified against source: every capture surface is a **hook**,
and hooks fire *after* the model emitted its call — downstream of context
assembly. `HarnessEvent` (`src/harness/types/events.ts:76`) carries only
`tool_name`/`tool_input`/`tool_response`. `timeline.jsonl` re-derives conversation
*turns* from the runner transcript (`src/harness/transcript-record.ts:180`) but
never the **system prompt, tool schemas, injected context** (CLAUDE.md, expanded
@-mentions, system-reminders), or the exact assembled message array. A repo-wide
grep for `system_prompt`/`messages[]`/`request_body` finds no such capture.

**Consequence:** you cannot reconstruct what the model actually saw. `replay-run.mjs`
papers over this with a hand-written `DEFAULT_SYSTEM` + 6 minimal `TOOLS`
(`replay-run.mjs:32-45`) and says so (`:12-20`). Directionally useful; not 100%.

The only place the exact input exists is **on the wire between the runner and the
API**. Capture must move to the inference boundary.

## Goal

Record, for every model invocation, the exact `{request, response}` envelope —
system, tools, full messages, sampling params, and the response's content blocks
(text, thinking, tool_use) + usage — keyed so it joins the hook trace by
`tool_use_id`.

## Non-goals

- Not a gate. Fail-open, never blocks or delays a request (transparent proxy).
- No re-hosting of the reference model. We log its I/O; we don't reproduce it.
- No scrubbing on the fidelity path (see *Sensitivity* — the raw prompt is the point). Storage is gitignored + never synced.

## Design

### Two implementations, same envelope

1. **Local pass-through proxy (default, no infra).** Point the runner's API base
   URL at a local listener that forwards to the real API and tees the envelope to
   disk. `ANTHROPIC_BASE_URL` is the SDK-standard base-URL override (standard
   client config across the official SDKs), and Claude Code rides the SDK —
   still verify empirically that ALL its calls route through it, including
   subagent processes; Codex/Gemini have their own base-URL env. ~100 lines,
   `node:http` + `fetch`. Must reassemble SSE streaming responses into the final
   message (anatomy below).
2. **Cloudflare AI Gateway (managed).** Purpose-built: sits on the request path,
   logs full request/response across providers, no local process. Use when you
   want capture off-machine or across many runners. Same envelope, exported via
   Logpush → `inference/`.

### Envelope schema

```jsonc
// .interlinked/replay/inference/<session_id>.jsonl  — schema "inference-envelope.v1"
// (proxy writes to inference/pending.jsonl first; the assembler rewrites into
//  per-session files once tool_use_id → session_id is known — see Correlation)
{
  "schema": "inference-envelope.v1",
  "request_index": 128,            // monotonic per proxy process (proxy-local ordering)
  "ts_request": "2026-07-23T...Z",
  "ts_response": "2026-07-23T...Z",
  "latency_ms": 4120,
  "provider": "anthropic",
  "request_headers": { "anthropic-version": "...", "anthropic-beta": ["..."] },  // auth headers NEVER persisted — see Sensitivity
  "request": {
    "model": "claude-opus-4-8",
    "system": "...",               // EXACT system prompt as sent
    "tools": [ /* EXACT tool schemas as sent */ ],
    "messages": [ /* EXACT assembled message array */ ],
    "params": { "max_tokens": 16000, "temperature": 1, "thinking": { /* ... */ } }
  },
  "response": {
    "id": "msg_...",
    "stop_reason": "tool_use",
    "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0 },
    "content": [ /* text / thinking / tool_use blocks, verbatim */ ]
  },
  "tool_use_ids": ["toolu_..."],   // extracted from response.content for the join
  "request_sha256": "...",         // dedup / integrity
  // stamped by the assembler after the join, not the proxy:
  "session_id": null,
  "seq": null
}
```

### Correlation (the fiddly bit — keep the proxy dumb)

The proxy sees HTTP, not the harness `session_id`/`seq`. **Do not teach it about
the harness.** Instead:

- Each response's `tool_use` blocks carry ids that are **identical** to the
  `tool_use_id` on the hook events (`activity`/`collection`/`timeline`) and the
  G2 snapshot. Join on that.
- The Tier-1 **assembler** (`src/harness/replay/trace-assembler.ts`) reads
  `inference/pending.jsonl`, looks up each `tool_use_id` in the hook logs to
  recover `(session_id, seq)`, stamps them, and appends to
  `inference/<session_id>.jsonl`. This is the same join that builds the
  `replay-trace.v1` spine (see README §Trace spine).
- **Turns with no tool_use** (pure text/thinking) have no `tool_use_id`. Attach
  them to the `seq` of the *next* tool-producing turn in the same session by
  request-order + timestamp window. Documented approximation; these steps have no
  action to score anyway.

### Cost & retention

Each turn re-sends the full conversation, so raw envelopes grow O(turns²) per
session (a long session reaches hundreds of MB uncompressed). Ship per-envelope
compression from v1 (`node:zlib` gzip is fine — the shared prefixes make
envelopes extremely compressible). A later optimization, only if compressed
sizes still hurt: prefix-dedup (store `messages` as a delta against the previous
envelope keyed by a prefix sha). The spike writes plain JSONL.

### Minimal proxy (first-spike version)

`scripts/inference-proxy.mjs`, self-contained (no CLI imports, like the other
`scripts/*.mjs`):

```
PORT=8787 node scripts/inference-proxy.mjs         # then: ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude ...
```

- `http.createServer` → for each request, buffer the body, `fetch` the real
  upstream (`https://api.anthropic.com` or `ANTHROPIC_REAL_BASE_URL`), stream the
  response back to the client **unbuffered** (don't add latency), while teeing a
  clone to reassemble + append the envelope.
- SSE reassembly (verified against the current Messages streaming contract):
  `message_start` carries the message shell + input-side usage;
  `content_block_start/delta/stop` are keyed by block index — accumulate
  `text_delta` and `thinking_delta` (+ `signature_delta`) as strings, and
  `input_json_delta` as **partial-JSON fragments concatenated per index and
  parsed at `content_block_stop`**; `message_delta` carries `stop_reason` and
  the output-side usage (merge with `message_start`'s usage — `message_stop`
  is only the terminator, it carries neither).
- Fail-open: any tee/append error is swallowed; the proxy always forwards.

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `scripts/inference-proxy.mjs` | new | Standalone pass-through logger. |
| `src/harness/replay/inference-store.ts` | new | `InferenceEnvelope` type, `appendEnvelope`, `loadEnvelopes(session)`, `envelopeForToolUseId(id)`. |
| `src/harness/replay/trace-assembler.ts` | new (shared with T1) | The `tool_use_id → (session, seq)` join + per-session rewrite. |
| `src/commands/replay.ts` | edit (or new) | `interlinked replay capture --start` prints the `ANTHROPIC_BASE_URL` to export; `... --status` shows envelope counts. |
| `.interlinked/.gitignore` | verify | `replay/inference/` must be gitignored (it is, under `.interlinked/*`; confirm no carve-out re-includes it). |
| `src/harness/replay/__tests__/inference-store.test.ts` | new | envelope round-trip; SSE reassembly fixture; tool_use_id extraction. |

## Sensitivity

Envelopes contain the **entire prompt** — may include secrets/PII the scrubber
would normally strip from `timeline.jsonl`. Fidelity requires the raw. Two rules:

1. **Never persist credentials.** The proxy forwards auth material live —
   `x-api-key`, or OAuth `Authorization: Bearer` plus its `anthropic-beta:
   oauth-…` flag (how Claude Code authenticates after `/login`) — but strips
   every auth-bearing header before writing the envelope. Persist only
   `anthropic-version` and non-auth beta flags (those are part of the exact
   input; the credential is not).
2. **Keep raw prompts local-only.** Store only under
   `.interlinked/replay/inference/` (gitignored), **never** include in
   `interlinked sync` / server batch / `interlinked backup`, and gate the whole
   feature behind `replay.inference_capture` (default off). Document in the
   command help that enabling it records full prompts locally.

## Test plan

- Round-trip: append 3 envelopes, load by session, assert byte-equal `request`.
- SSE reassembly: feed a recorded streaming fixture, assert reassembled `content` equals the non-streamed equivalent.
- `tool_use_id` extraction: response with 0 / 1 / 2 tool_use blocks → correct id list.
- Join: given hook logs + pending envelopes, assembler recovers `(session, seq)` for every tool-producing turn; text-only turns attach to the next seq.
- Proxy latency: a mocked upstream returns in T ms; client sees response in ≤ T + 5 ms (tee does not block).
- Fail-open: tee target unwritable → request still forwarded, response still returned.

## Validation

- [ ] With the proxy running, a real `claude` edit session produces one envelope per model turn with a non-empty `system` and `tools`.
- [ ] Every `tool_use_id` in `activity.jsonl` for the session resolves to exactly one envelope.
- [ ] Replaying that envelope's `request` (system+tools+messages) into `replay-run.mjs` reproduces the recorded action for the reference model (fidelity self-check — see Tier 1).

## Open questions

1. Does the target runner reliably route through `ANTHROPIC_BASE_URL` for *all* calls (including subagent/parallel-tool turns)? Verify empirically per runner.
2. Prompt-cache headers: the request includes `cache_control` breakpoints — preserve them verbatim (they affect nothing on replay but are part of "exact input").
3. Multi-runner sessions (Codex/Gemini) use different wire formats — the envelope is Anthropic-shaped; add a `provider` discriminant if/when a second provider is captured.
