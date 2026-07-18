# Edit-contract hardening — full gap inventory + implementation from the oh-my-pi intake

Status: **LG-1…LG-6 shipped 2026-07-17** (CG-1's row shape shipped inside LG-5;
CG-2/CG-3 remain RFC seeds, CG-4 awaits CG-1 data). Shipped deviations from the
sketches below, chosen during implementation: (a) LG-6 needs **no git-show /
line-map remap** — the retained `anchor_context` makes unique re-location the
remap, and ambiguity conservatively reads `drifted` (cleaner per re-derive
doctrine); (b) LG-5's best-effort **model dimension is deferred** (no clean
source on the hook path today — rows carry `agent_source` only); (c) the
reconciliation **touch-producer still overlaps raw line numbers** — refining it
to remapped-line overlap is the natural follow-up now `findings verify --write`
keeps anchors true; (d) the LG-5 formatter lives in `edit-mechanics-stop.ts`
wired via `lifecycle-events.ts`, whose line-cap forced extracting
`lifecycle-persist.ts` (source-text security pins moved with it).
Provenance: `docs/external-pulse/oh-my-pi.md`
(intake, 2026-07-17). That doc's §7 named only the ≤1-day spike per INTAKE discipline;
this memo is the complete inventory the intake compressed, with implementation
sketches. Companion reading: `docs/design/spec-audit-runtime-checks.md` (LG-6 extends
its reconciliation layer), `docs/external-pulse/cursor-harness.md` (claims 3–4
corroborate CG-1).

The organizing idea, in one line: omp owns both sides of its edit contract and can
therefore *enforce* "edit only what you were shown, as of when you were shown it";
interlinked owns neither side, so each contract clause degrades to the strongest
hook-layer form — deterministic doom-detection with one-round-trip rescue, drift
*warnings* with the divergence inlined, provenance *telemetry* — and only regains
full strength on surfaces we own (Agent CI).

## 1. Gap inventory

Local (Free CLI, P1):

| # | Gap | Today | Tier | Effort |
|---|-----|-------|------|--------|
| LG-1 | Edit rescue is two-round-trip (snippet + "re-read") | `evaluateEditOldStringGuard` (`pre-tool-guards.ts:269`) + `edit-diagnostics.ts` near-miss spans | block (already) | 0.5 d |
| LG-2 | Doom-detection covers `Edit` only — MultiEdit entries, multi-match-without-`replace_all`, and Codex `apply_patch` context mismatches are unchecked | `toolName === "Edit"` guard; `apply-patch-content.ts` parser exists but unused here | block (Edit/MultiEdit), warn (apply_patch, measure first) | 0.5–1 d |
| LG-3 | No content-based staleness: a file changed by formatter/git/human/untracked agent since this session's read is edited blind | `stale_read_then_write` is identity-based (fires only for tracked cross-agent writes); `session-state` keeps a `files_read` path set, no hashes | warn | 1 d |
| LG-4 | No read provenance: an edit targeting lines the session never displayed is indistinguishable from a grounded one | nothing (omp `seenLines`) | measure → warn | 0.5 d after LG-3 |
| LG-5 | Edit mechanics invisible to recurrence/Stop reflection | `[interlinked:edit-near-miss]` fires but is not recorded as recurrence; no Stop nudge | telemetry | 0.5 d |
| LG-6 | Findings anchors go stale as the tree moves — `file:line` from a 5 h audit round decays with every edit above it; reconciliation span-overlap can false-touch (edit shifted the finding) and false-miss (finding line stale) | `findings/corpus.ts` anchors `file:line` (+`commit_sha`, tier `anchored_sha`); `recent_line_edits` overlap marks "touched"; no span content-hash, no remap | deterministic CLI-side | 1–2 d |

Cloud / remote (P2–5):

| # | Gap | Surface | Effort |
|---|-----|---------|--------|
| CG-1 | Cross-client edit-reliability telemetry (doomed/rescued/stale/format-failure per client × model) — the error taxonomy Cursor calls its leading regression signal; nobody has it cross-client | Guardrails (P2–3); local rows now, transport later (sync is deliberately deferred — design the row, not the POST) | 0.25 d now (row shape) |
| CG-2 | Agent CI loops we own lack omp's contract: reviewer agents get no tagged/elided reads, no schema-validated outputs | Agent CI (P4–5) | RFC |
| CG-3 | No controlled harness-as-variable eval: we measure sessions observationally (`fable-corpus-extraction.md`) but can't A/B "does gate X help" | Agent CI / internal (metaharness shape) | RFC |
| CG-4 | Per-model edit-format routing knowledge (omp ships `HASHLINE_EXCLUDED_MODEL_MODES`; Cursor provisions per model) — we could *measure* instead of benchmark | productized output of CG-1 (`interlinked doctor` advice + published fit report) | falls out of CG-1 |

Non-gaps, for completeness (things the intake checked and closed): destructive-command
guards and approval tiers (ours are broader — 119 rules vs their ~15-pattern denylist);
post-edit re-grounding (Claude Code echoes the edited region natively); repair-with-warning
(policy-rejected — `feedback_no_autofix_detection_first`; our lawful analog is rescue
messages carrying exact material); TTSR mid-stream abort (requires owning the stream;
its portable residue is repeat-gating, absorbed into LG-3); snapcompact/mnemopi
(different products); per-line hashes and tree-sitter block ops (superseded /
wrong-cost respectively — see intake §9 carve-outs).

## 2. Local implementations

### LG-1 — One-round-trip rescue

The block already fires only when the client itself would fail (absent `old_string`) —
zero-FP by construction. The upgrade is the payload:

- `edit-diagnostics.ts`: `NearMiss` gains `lines: string[]` (the span verbatim,
  exact whitespace) and `endLine`. `findClosestSpans` already has the window; return it
  instead of `windowLines[0].trim().slice(0,120)`.
- New `formatRescue(misses, filePath)`: best span rendered as

  ```
  src/foo.ts lines 42–48 (93% match) — current content, copy exactly:
  ```
  ```ts
  <verbatim lines>
  ```

  Line numbers stay **outside** the fence (omp issue #1492: models echo displayed
  prefixes into payloads; Claude Code's `Edit` would treat an echoed `42:` as
  literal content). Runner-up spans stay one-line references. Caps: 40 lines /
  3 KB per span; when `old_string` exceeds the cap, show head+tail with the first
  divergent line marked (`first line that differs: N`) — computed by common
  prefix/suffix trim, no diff dependency.
- Same rendering reused by the PostToolUse `[interlinked:edit-near-miss]` path
  (`post-tool.ts:367`) so cold-daemon sessions that only see the post hook get parity.
- Message discipline (omp house style, keep ours): name the wrong thing, then the
  exact right form inline. "Re-read the file first" is deleted — the point is that
  the retry needs no read.

Tests (extend `pre-tool-guards.test.ts` + `edit-diagnostics` tests): whitespace-exact
span survives formatting into the reason string; cap behavior; CRLF file; ≥3 negatives
(unique match passes; near-miss below `MIN_SIMILARITY` yields no fence; unreadable file
fails open).

### LG-2 — Doom parity: MultiEdit, multi-match, apply_patch

Three deterministic doom cases the guard currently misses, all mirroring the client's
own failure semantics:

1. **MultiEdit**: simulate sequentially (entry *i* applies to the output of entries
   `< i` — the machinery exists in `pre-tool-helpers-guard-blocks.ts`); first doomed
   entry blocks with omp-style accounting: "entry 3 of 5 will not apply (`old_string`
   not found after entries 1–2); MultiEdit is atomic, so nothing was applied" + LG-1
   rescue for that entry. Negative test that matters: entry 3's `old_string` created
   by entry 2 must NOT block.
2. **Multi-match**: `old_string` occurring >1× with `replace_all !== true` fails in
   Claude Code. Block with the match count and each site's line + one context line,
   plus the two exits: `replace_all: true` or a longer anchor (suggest the shortest
   uniquifying extension by scanning forward/back from each site until unique —
   cheap and concrete).
3. **apply_patch (Codex)**: reuse `parseApplyPatchSections` / `reconstructAfterContent`
   (`apply-patch-content.ts`) to validate each Update hunk's context+deletion lines
   against the live file. **Warn-tier first, not block**: Codex's matcher has leniency
   we don't fully model (trailing-whitespace fuzz), and the `pre_block` contract
   (`check-registry/types.ts`) reserves blocks for zero-FP determinism. Emit
   `[interlinked:apply-patch-doom][heuristic]` + rescue payload; record via LG-5; promote
   to block only if measured FP ≈ 0. This also closes the client-asymmetry noted in
   `bun-in-rust.md` (Codex sessions currently get zero rescue).

### LG-3 — Read-view snapshots (SnapshotStore-lite) + stale-read warning

omp's `SnapshotStore`, reduced to what a hook layer can know:

- `types/session.ts`: trajectory gains
  `file_views?: Map<string, { hash: string; at_step: number; at: string;
  ranges: Array<[number, number]> | null; size: number }>`
  — one entry per path, latest view only (no version ring: we can't recover old
  content anyway, so history buys nothing; `recent_line_edits` at `session.ts:215`
  already holds the edit-side spans).
- Capture (in `session-state.ts::recordEvent`, same best-effort contract as
  `recent_line_edits`): on PostToolUse **Read** — hash the on-disk file (not the
  tool_response, which is line-number-decorated), `ranges` from `offset`/`limit`
  (`null` = whole file); on grep-accelerator answers — record displayed ranges;
  on PostToolUse **Edit/Write** — refresh the hash (the session saw the result);
  size guard: skip > 2 MB. Bash reads (`cat`/`sed`) are not resolved → no view →
  every downstream check fails open, exactly omp's `seenLines === undefined` rule.
- Check (new `evaluator/read-provenance.ts`, wired beside the old-string guard so
  the file read is shared): at PreToolUse Edit/MultiEdit/Write/apply_patch, if a
  view exists and live hash ≠ view hash →
  `[interlinked:stale-read][heuristic] src/foo.ts changed since this session read it
  (step 41). Divergence begins at line 87: <±2 lines current content>` — divergence
  located by common prefix/suffix trim (O(n), no diff dep). Warning, never block:
  the edit may still be perfectly valid (Claude Code's own read-before-edit tracker
  handles its hard case; we cover what it can't see and *show the drift*).
- **Repeat-gate** (TTSR's portable residue): emit once per `(path, liveHash)` per
  session — a `warned_views` set on the trajectory. Without this, a formatter sweep
  would spam every subsequent edit.
- Interaction: when LG-1 fires AND a stale view exists, one combined message —
  staleness is the *explanation*, rescue is the *exit*.
- Config: new `edit_contract` section (`stale_read: "warn" | "off"`, defaults warn),
  classified in `rules/merge.ts` + pinned in `merge-parity.test.ts` per house pattern.

### LG-4 — Blind-edit provenance (measure first)

With LG-3's `ranges` populated: locate the Edit's `old_string` span in the live file;
if the session has views for the file but the span was never inside any displayed
range (and no whole-file view exists), that's an edit anchored on unseen lines.
FP sources are known (Bash reads absent from provenance; content carried across
compaction/summary from a prior session), so ship it **silent**: recurrence row only
(`edit-blind-lines`, LG-5 machinery), no agent-visible warning until a few sessions of
counts say the FP rate is tolerable. `edit_contract.blind_edit: "measure" | "warn" |
"off"`, default `measure`. This is the one omp clause where their block-tier
conviction (15.13.1, default-on by 17.0.0) doesn't transfer — they have total read
coverage; we never will.

### LG-5 — Edit-mechanics recurrence + Stop reflection

- `recordHarnessCaught` signatures at each LG-1–LG-4 site: `edit-doomed-missing-anchor`,
  `edit-doomed-multi-match`, `edit-doomed-multiedit-entry`, `edit-applypatch-context`,
  `edit-stale-read`, `edit-blind-lines`. Payload gains `client` (from `agent_source`)
  and best-effort `model` (statusline payload cache when available; else omitted) —
  the two dimensions CG-1 needs. Deterministic counting only, per
  `feedback_harness_deterministic_only`.
- Rescue efficacy without seeing tool results: a doomed-edit block followed within
  2 events by a *successful* Edit to the same file (visible at its PostToolUse)
  counts as `edit-rescued` — sequence detection in `session-state`, same shape as
  existing sequence checks.
- Stop formatter `edit-mechanics-stop.ts` (`string | null`, wired in the `server.ts`
  Stop branch beside `commit-cadence.ts`): fires at ≥3 doomed edits per session —
  "9 edits this session were dead on arrival (7 rescued in one round trip). Doomed
  edits usually mean editing from memory — anchor on current file content." Never
  blocks; stderr only.

### LG-6 — Findings anchor liveness (the spec-audit tie-in)

The direct transplant of omp's `recovery.ts` line-map onto
`docs/design/spec-audit-runtime-checks.md` §4 reconciliation. Today a Finding
anchors `file` + `line` (+ provenance `commit_sha`, completeness tier `anchored_sha`,
`findings/corpus.ts:130`), and closure detection overlaps `recent_line_edits`
against that line. Both directions decay as the tree moves: an insertion above the
finding shifts its true location (overlap false-miss), and an edit overlapping the
*stale* number false-touches a finding it never addressed.

- **At ingest** (`ingestReviewReport`): for anchored findings, record
  `anchor_span_sha256` = hash of the anchored line ±1 (normalized: trimmed EOL) from
  the live tree, plus `anchor_context` (the lines themselves, ≤3, for display and
  re-location) and `anchor_tree` = `git rev-parse HEAD` when clean / `"dirty"`.
  New optional fields on `Finding`; absent on legacy rows (all consumers fail open).
- **`interlinked findings verify`** (new subcommand; also folded into `findings list`
  as a freshness column): per anchored finding —
  1. hash the current span at the recorded line → match ⇒ `live`;
  2. else search the file for `anchor_context` (exact, then whitespace-normalized)
     → unique hit ⇒ `moved` (report the new line; `--write` re-anchors, appending a
     reconciliation txn — the ledger is append-only, so this is a new txn kind
     `reanchor`, one more arm of the edge-defined-once union in
     `spec/reconciliation.ts`);
  3. else, when `commit_sha`/`anchor_tree` is usable: `git show <sha>:<file>` and
     omp-style remap — diff old↔current into a line map over unchanged lines,
     map the anchor through it, require the mapped line's content to still match ⇒
     `moved`; ambiguous/deleted ⇒ fall through;
  4. else ⇒ `drifted` (content at and around the anchor changed — the finding needs
     re-review, not silent survival) or `gone` (file deleted).
  All deterministic; git subprocess is fine here (CLI command, not the hook path).
- **Reconciliation correctness fix**: "touched by an edit" should require overlap
  with the *remapped* line, and distinguish `touched` (span content changed) from
  `shifted` (content identical at new location — NOT addressed). This is the piece
  that stops a morning of unrelated refactors from "closing" half an audit round.
- Payoff is directly the wall-clock pain in `project_external_audit_workflow`: the
  next 5 h Sol/Codex round is briefed with `live` + `moved` findings only, and
  `drifted` ones are re-queued explicitly instead of re-discovered at full cost.

Note the deliberate asymmetry with omp: they remap in order to *apply the edit
anyway*; we remap only to *keep the ledger true*. No finding is auto-closed by
remap — closure still requires an edit or an explicit ack (`no-autofix` discipline).

## 3. Cloud / remote implementations

### CG-1 — Edit-reliability telemetry → per-model fit reports

Local half ships with LG-5 (rows carry `client` + best-effort `model`). Cloud half
waits for sync by design (`project_sync_not_implemented`): when batch sync exists,
recurrence rows are already the transport shape — signatures + counts, no file
content, so nothing sensitive crosses the wire. Worker side: a DO aggregating
`(check, client, model) → count, sessions` with a dashboard card; the productized
output is CG-4 — `interlinked doctor` noting e.g. "this model's Edit doom rate here is
4× baseline; prefer smaller anchored edits", and a publishable cross-client
reliability table (the data omp/Cursor each only have for their own harness).
Decision now: only the row shape (part of LG-5). No transport work.

### CG-2 — Agent CI: own-the-loop contract

Where we run agents (Tier-3 review, future sandboxed fan-outs), we own tools, so
omp transfers whole:
- **Reads**: tagged (`[path#tag]`), numbered, elision-marked with recovery
  selectors; reviewer *citations must carry the tag*, giving Tier-3 findings the
  same liveness LG-6 gives ingested ones, for free at creation time.
- **Outputs**: `yield`-style — findings submitted against a JSON Schema, validated
  server-side, ≤3 bounded retries then accept-with-flag (omp's
  `MAX_SCHEMA_RETRIES` shape). Kills the report-parsing layer LG-6 ingest needs for
  external reviewers.
- **Edit tool**: only if an Agent CI product ever *authors* changes (today Tier 3 is
  warn-only). Then vendor `@oh-my-pi/hashline` (MIT; shim `Bun.hash.xxHash32` →
  `node:crypto`/`xxhash` impl and `Bun.file` → `node:fs` — the package's only Bun
  seams) rather than reimplement: the value is the two months of repair/leniency
  hardening in its changelog, which we should not re-earn bug by bug.
RFC before build; this memo is its seed.

### CG-3 — Metaharness-shape eval: harness-as-variable A/B

The missing complement to `fable-corpus-extraction.md` (observational → controlled):
- **Fixtures**: mutation-inverse generator over *this* repo — Stryker's mutators
  (`stryker.conf.json` exists) supply the mutation set; templated task descriptions
  with difficulty-scaled location hints (omp's exact recipe; theirs is the reference
  implementation, trivially reimplementable, no dep).
- **Runner**: temp worktree per run, drive a real client headlessly (`claude -p`,
  `codex exec` under subscription auth per `feedback_codex_subscription_only`),
  variable = harness config (gate on/off, wording A/B), fresh session per run.
- **Judge**: formatter-normalized restoration compare (their `verify.ts` recipe:
  normalize, format, string-compare) *plus* affected-test run — we have tests, so we
  can score semantics, which their bench explicitly cannot.
- **Store**: `experiment → run → trace` JSONL under `.interlinked/bench/` + a report
  command; SQLite/dashboards only if it earns them.
- Honest omp lessons to inherit up front: report first-try rate separately from
  best-of-N; keep any assist rates (our nudges) separated out the way they report
  `Autocorrect-Free Success Rate`; never let the two conditions differ anywhere
  except the declared variable (their read-output asymmetry is the cautionary tale).
This is multi-day → RFC, but it is the instrument that turns "the harness gates
help" from corpus inference into a measured claim.

## 4. Sequencing

1. **PR 1 — LG-1 + LG-2** (rescue payload + doom parity). Pure upgrades to a shipped
   block; every piece deterministic; immediate per-session value.
2. **PR 2 — LG-3 + LG-5** (read-view snapshots, stale-read warning, recurrence rows,
   Stop formatter). LG-4 rides along silent (`measure`).
3. **PR 3 — LG-6** (findings anchor liveness). Highest current-workflow value given
   the audit cadence; independent of PRs 1–2.
4. **CG-1 row shape** lands inside PR 2's recurrence payload. Nothing else cloud-side
   is built now; CG-2/CG-3 get RFCs when their surfaces are scheduled.
5. Promotions later, evidence-driven: apply_patch warn→block, blind-edit
   measure→warn — both gated on LG-5 counts, the same ratchet path
   `interlinked recurrence propose` already models.

Per-check house rules apply throughout: ≥3 positive + ≥3 negative tests each; new
config classified in `rules/merge.ts` + `merge-parity.test.ts`; new warnings carry
`[proven]`/`[heuristic]` per `classifyDeterminism`; nothing new on the hook path
does network or exceeds the per-edit compute budget (hashing + prefix/suffix trim
are micro; the LG-1 span render reuses the file the guard already read).

## 5. Non-goals

Restated from the intake so this memo is self-contained: no MCP hashline sidecar
for foreign clients; no per-line hashes; no tree-sitter dependency in the CLI; no
mid-stream abort (TTSR) — we don't own the stream; no auto-repair of edit payloads
in flight — rescue supplies material, the agent authors the correction.
