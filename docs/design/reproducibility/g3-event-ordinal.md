# G3 — Global event ordinal

**Status:** Design. **Effort:** 0.5–1 day. **Smallest of the gaps; do it first.**
**Scope:** mint a `seq` at the daemon event-loop entry; stamp it on every log record, the live snapshot, and the trace spine; persist `event_id`; reconcile the `_replay` directory name.
**Depends on:** —. **Blocks:** [G1](./g1-inference-capture.md), [G2](./g2-tree-snapshots.md) (both key on `seq`).

## Problem

Cross-log correlation works (`tool_use_id`), but you cannot **totally order** a
session's events:

- `ts` is ISO ms-precision and **not unique** — `src/lib/local-activity.ts:170-187`
  explicitly notes two parallel calls can share ms/session/type/tool.
- `event_id` exists only on the in-memory `UnifiedHookEvent`
  (`src/harness/unified-event.ts:119`, `makeEventId` `:155`) and is **not
  persisted** — falsifier-confirmed it is dropped at the `toHarnessEvent`
  conversion in `evaluator-unified.ts`, so it never even reaches the writers.
- `turn_id` buckets everything between two user prompts (a minted time-based
  string, `session-state.ts:1082-1098`) — too coarse to order within a turn.

For replay you need a deterministic order over *observed* events, including
parallel tool calls.

## Goal

A monotonic, persisted `seq` per session that totally-orders observed events, is
stamped on every capture surface, and survives a daemon restart.

## Design

### Mint at the daemon event loop (not the hook)

The harness server is a **single Node event loop** processing socket events
serially (`src/harness/server-event-loop.ts`). That serialization *is* the
canonical order — even for parallel tool calls, the daemon observes them one at a
time. So mint `seq` there:

- Per-session counter held in `session-state` (already serialized to
  `<id>.live.json`, so it persists and hydrates on restart). Increment on
  **every observed event** (Pre, Post, lifecycle) — a total order over the
  session's event stream; the trace-spine `StepKey.seq` is the PreToolUse
  event's seq, and the Post event (own seq) joins the step via `tool_use_id`.
  Persist `last_seq` in `serialize()` (`session-state.ts:233`); hydrate it on
  the lazy first-event path (`server-event-loop.ts:112-115`).
- Expose `seq` on the event object so every downstream writer stamps it.
- Optionally also mint a **daemon-global** `gseq` (single counter across all
  sessions) for multi-agent-on-one-tree ordering. Lead with per-session; add
  `gseq` only if a consumer needs cross-session interleave order.

**Cold path caveat:** the runner-hook write path (daemon down — the inline
fallback's `appendLocal`, `src/lib/hook-template-chunks/session-state.ts:581`)
can't see the counter. Those records carry `seq: null`. Acceptable — replay capture (G1 proxy,
G2 snapshots) requires the daemon anyway, so replay-grade sessions always have
`seq`.

### Persist `event_id` too

Stamp the existing `makeEventId` value onto the persisted records (stable
per-delivery id, complements the ordinal). One-line addition where each writer
builds its record.

### Directory reconciliation (do it here)

Consolidate the two replay dirs (README §Storage): move plan-17's
`.interlinked/_replay/` → `.interlinked/replay/decisions/`. Update
`docs/plans/free-cli-adoption/17-...md` §17.1 path and any writer. Single
`replay/` root with subdirs from here on.

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `src/harness/session-state.ts` | edit | `seq` counter in the serialized snapshot; increment + expose; hydrate max on restart. |
| `src/harness/server-event-loop.ts` | edit | Assign `event.seq` at observe time, before dispatch. |
| `src/harness/server/activity-writer.ts` | edit | Stamp `seq` + `event_id` on the activity record. |
| `src/harness/server/collection-writer.ts` | edit | Stamp `seq` + `event_id` on the collection record. |
| `src/harness/timeline-writer.ts` | edit | Stamp `seq` where a transcript record maps to an observed event. |
| `src/harness/server.ts` + `src/harness/reservations-state-machine.ts` | edit | Stamp `seq` on `reservation-events.jsonl` records (writer `server.ts:342,:350`; add optional `seq` to `ReservationLogEvent` `:75-87`) so Tier 2 can replay reservations to an exact cutoff. |
| `src/lib/local-activity-types.ts`, `src/lib/collection/types.ts` | edit | Add optional `seq`/`event_id` to the record types. |
| `src/harness/__tests__/event-ordinal.test.ts` | new | See test plan. |

## Test plan

- Monotonic: N events for one session get strictly increasing `seq` starting at the hydrated max.
- Restart: hydrate from a `.live.json` with `seq=17`; next event is `18`.
- Parallel calls: two events with equal `ts` get distinct, ordered `seq`.
- Stamped everywhere: one tool call's `seq` is identical across activity/collection/timeline records for that `tool_use_id`.
- Cold path: a hook-only write (no daemon) yields `seq: null` without error.

## Validation

- [ ] Every `tool_use` record in a daemon-up session is orderable by `seq` with no ties.
- [ ] `activity`/`collection`/`timeline` agree on `seq` per `tool_use_id`.
- [ ] `.interlinked/_replay/` no longer written; `replay/decisions/` used instead.

## Open questions

1. Do any existing consumers sort by `ts` and assume uniqueness? Grep for readers of the three logs; switch them to `seq` where they rely on order.
2. `gseq` (daemon-global) — ship now or defer until a multi-agent consumer needs it? Recommend defer.
