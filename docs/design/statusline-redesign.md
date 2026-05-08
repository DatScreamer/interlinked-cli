# Status line redesign — surface what's toggled, prove the harness is working

## Problem

The current status line answers exactly one question: *is the harness daemon
alive?* It throws away the JSON Anthropic pipes to it (`cat > /dev/null` in
`src/lib/hook-installers.ts:159`) and reads four small status files. Users
cannot see, at a glance, **which interlinked modes/toggles are active** —
the most-asked-about question — and the line gives no kinetic feedback that
the harness is actually doing anything per edit.

There are at least three orthogonal mode axes, plus a stack of binary
toggles, none of which are surfaced today:

| Axis | Values | Default | Source of truth |
|---|---|---|---|
| Harness mode | `budget` / `quality` / `ci` | `quality` | `.interlinked/config.json` `mode` field |
| Enforcement mode | `balanced` / `strict` / `lenient` / `custom` | `balanced` | `.interlinked/check-policy.json` `mode` field |
| Sync mode | `realtime` / `local` / `manual` | `realtime` | `.interlinked/config.local.json` `sync_mode` |

Plus: classifier on/off, content-scanner on/off, auto-coordination on/off,
trigram index health, server-bridge connectivity, reservation count,
loaded rule count.

## Scope (interlinked-domain only)

The status line must NOT duplicate Anthropic's defaults — model name,
context %, cost, rate limits, effort, thinking. Those come from the JSON
on stdin and belong to the platform. We render interlinked state only.

## Goals

1. **Screenshot-demoable** — a single screenshot of a running Claude Code
   session must instantly communicate what interlinked is, what it's
   doing, and why it's valuable. A cold reader (someone who has never
   used the tool) should be able to read intent from the line alone.
2. **Glanceable mode posture** — answer "what's on?" without typing a command.
3. **Per-edit kinetic feedback** — show that the harness *just did something*
   on the most recent file edit, so users see the value in motion. When a
   block just fired, that becomes the headline.
4. **Clickable jump-offs** — every counter is OSC 8-wrapped so Cmd+click
   opens the relevant file or directory.
5. **Stay fast** — script runs after each assistant message, debounced 300ms,
   cancelled mid-flight on a new event. Pre-compute everything in the
   harness; the bash script does pure I/O + formatting.

### Demo-readability rules

These follow from goal (1) and override earlier draft choices:

- **Brand first**: `◆ interlinked` is the leftmost segment, always present.
  A screenshot must be self-attributing.
- **Words for things, glyphs for state**: `classifier ✓ · PII filter ✓ ·
  index 12k files` beats `cls✓ PII✓ idx✓`. ✓/✗/⚠ are universal; abbreviations
  are not.
- **Verbs for activity**: `✓ guarded src/foo.ts (240ms)` instead of just
  `✓ src/foo.ts`. The verb tells a cold reader what the tool *did*.
- **Blocks are the headline**: when a block fired in the last 60s, it owns
  the second row in red with a relative timestamp. Nothing else competes.
- **Concrete numbers beat presence flags**: `81 rules`, `index 12k files`,
  `3 reserved` — quantification reads as scale and conveys investment.

## Non-goals

- Rendering model/cost/context/rate-limit data (Anthropic's domain).
- Two-way interactivity beyond OSC 8 hyperlinks (platform doesn't support it).
- Replacing `interlinked status` (that's the deep-dive view).
- A Node rewrite of the script — bash is sufficient given the input is
  status files we own, not the JSON on stdin.

## Layout

**Healthy, just guarded an edit** (the most common screenshot):
```
◆ interlinked  ·  105 rules  ·  16 tools / 86 inline  ·  classifier ✓  ·  PII filter ✓  ·  index 12k files
✓ guarded src/foo.ts (240ms)
```

**Just blocked something** (the killer screenshot):
```
◆ interlinked  ·  105 rules  ·  16 tools / 86 inline  ·  classifier ✓  ·  PII filter ✓  ·  index 12k files
✗ blocked rm -rf  ·  2s ago
```

**Action needed** (review or sync queue):
```
◆ interlinked  ·  105 rules  ·  16 tools / 86 inline  ·  classifier ✓  ·  PII filter ✓  ·  index 12k files
⚠ 1 file awaiting review — interlinked review
```

**Daemon down**:
```
◆ interlinked  ·  ▼ harness offline  ·  Claude is bypassing guardrails
↻ interlinked harness start
```

The `N tools / M inline` split was added after the original draft — a single
"N checks" number didn't grow when contributors added inline detectors via
`src/harness/check-registry/entries-*.ts` (the dominant authoring path). The
split makes each authoring surface visible:
- **tools** ← `quality_checks` entries with a `command` field (subprocess
  wrappers). Toggleable per-repo through `guard-rules.local.json`.
- **inline** ← `CHECK_REGISTRY` (`agent_safety` pipeline) + `quality_checks`
  entries without a `command` + the `structural_checks` bundle. Mostly
  built-in; growing the inline count means landing a new detector.

Both segments link to the same `loaded-checks.md` — the markdown breaks them
out under separate headings so a click answers "which surface grew?".

**Not enabled in this project**:
```
◆ interlinked  ·  not running here  ·  ↻ interlinked enable
```

### Segment inventory

Left → right on the main row:

| Segment | Source | OSC 8 target | Notes |
|---|---|---|---|
| `▲/▼/○` glyph | `harness.pid` + `harness.sock` walk | (none) | Up / stale / not-installed |
| `quality/strict` | snapshot `harness_mode` + `enforcement_mode` | `file://.interlinked/check-policy.json` | Two modes joined; advertises the lever users most want |
| `realtime → quentin/dev` | snapshot `sync_mode` + `active_server` | `file://.interlinked/config.local.json` | Drops the arrow + workspace when server isn't multi-server |
| `81 rules` | snapshot `rules_total` | `file://.interlinked/loaded-rules.md` | The MD file is harness-generated; clicking opens the effective merged ruleset |
| `cls✓` `PII✓` `idx✓` | existing status files + snapshot `index_status` | respective `.status` / index manifest paths | ✓/✗/●/… per current scheme |
| `· 3 reserved` | snapshot `reservations_count` | `file://.interlinked/reservations/` | Suppressed when zero |
| `✓ src/foo.ts 240ms` | `last-check.txt` content + mtime | `file://<edited file>` | Kinetic — see below |

Action row, mutually exclusive, in priority order:

1. `⚠ N files awaiting review — interlinked review` (`scanner/review-pending` > 0)
2. `↗ N events pending sync — interlinked sync` (snapshot `unsynced_events` > 0)
3. `▼ harness offline — interlinked harness start` (no pid)
4. `index N files dirty — interlinked index build` (snapshot `index_status` = stale)

If none fires, the second row is omitted. We considered an "idle tip"
rotation but rejected it: the calmness of a one-row line when nothing
needs the user is more important than pedagogy.

### Kinetic last-edit segment

The hook already writes `.interlinked/last-check.txt` on every PostToolUse
(`src/lib/hooks-template.ts:782, 806, 818`); nothing reads it today. The
status line consumes it directly:

| Stored content | Rendered as | Color |
|---|---|---|
| `[interlinked:Edit] all clean (240ms)` | `✓ src/foo.ts 240ms` | green, fades to dim after 10s |
| `✗ N issue(s) on Edit (240ms)` | `⚠ src/foo.ts N issues` | yellow |
| `✗ blocked: rm -rf` (NEW — added on PreToolUse block path) | `✗ blocked: rm -rf` | red, persists 30s |
| `[interlinked:Edit] no harness (240ms)` | `· no harness` | dim |
| mtime > 5min | (segment omitted) | — |

Age-based fade requires `refreshInterval: 5` so the line keeps re-rendering
during idle periods. We add this to the `statusLine` config alongside the
existing `type` and `command` fields.

## Snapshot file format

Single file at `.interlinked/statusline.snapshot`, written atomically by
the harness. Format is `key=value`, one per line, for cheap bash parsing:

```
harness_mode=quality
enforcement_mode=balanced
sync_mode=realtime
active_server=production
workspace_id=quentin-dev
rules_total=105
rules_disabled=3
rules_custom=4
tool_checks_enabled=16
inline_checks_enabled=86
checks_enabled=102
reservations_count=3
index_status=ready
index_files=12450
classifier_status=ok
scanner_status=ready
scanner_review_pending=1
auto_coordination=on
server_bridge=connected
unsynced_events=0
generated_at=2026-04-29T14:32:18Z
```

The bash script reads the file once, splits on `=`, and uses each value.
Missing keys are treated as "unknown" and that segment is omitted. The
generated_at timestamp lets the script detect a stale snapshot (harness
crashed without writing) and fall back to the existing per-file
`*.status` reads.

### When the harness writes the snapshot

Cheap path — recompute and write whenever any input changes:

| Trigger | File touched | Existing hook |
|---|---|---|
| Startup | `server.ts` after `loadRules()` line 177 | new |
| Rules hot-reload | `server.ts:2304` `watchRulesFiles` callback | extend existing |
| Classifier state change | next to `writeClassifierStatus` calls | extend existing |
| Scanner state change | next to `writeScannerStatus` calls | extend existing |
| Periodic | every 10s for `reservations_count`, `unsynced_events`, `index_status` | new `setInterval` |

The 10s tick is the only new background work; everything else piggybacks
on existing state-change paths. The tick is idle-cheap (a few in-memory
reads + ~500-byte file write), well under any latency budget.

## Loaded rules markdown

Companion file `.interlinked/loaded-rules.md` written at the same time as
the snapshot when rules change. Deterministic content for diffability:

```markdown
# Interlinked harness — loaded rules

_Auto-generated by the harness. Mode: **quality / balanced**. Generated 2026-04-29T14:32:18Z._

## Process & filesystem (12 rules)
- `block_rm_rf` — block — built-in
- `block_dd_to_device` — block — built-in
- ...

## Database (8 rules)
- ...

## Disabled by `disabled_rules` (3)
- ~~`block_force_push`~~ — built-in (disabled in `guard-rules.local.json`)
- ...

## Custom rules from `guard-rules.json` (4)
- `team_no_console_log` — warn — custom
```

Click target for the `81 rules` segment. The user gets a real artifact
they can read, share, or commit-link to.

## Implementation plan

Six discrete changes, ordered for incremental review:

1. **Plan doc** (this file).
2. **Snapshot writer** (`src/harness/statusline-snapshot.ts`, new). Pure
   function: gather state, format, atomic write. Plus `writeLoadedRulesMd()`
   that renders the merged rule set. Deterministic output (sorted by
   category then id) for tests.
3. **Wire into harness lifecycle**: call from `server.ts` startup,
   from the `watchRulesFiles` callback, and from a 10s `setInterval`.
   Hook reservation manager so add/remove paths trigger a snapshot
   refresh too.
4. **Rewrite bash status-line script** (`writeStatuslineScript` in
   `src/lib/hook-installers.ts`). Reads snapshot + last-check.txt + the
   existing `*.status` files. Renders the new layout. Wraps each segment
   in OSC 8. Adds `refreshInterval: 5` to the settings JSON write.
5. **`writeLastCheck` on block path** (`src/lib/hooks-template.ts:691`).
   One extra line so the kinetic segment shows blocked actions, which is
   the highest-value moment to demonstrate the harness.
6. **Tests + verify**:
   - Unit: snapshot writer produces deterministic output for a fixed
     input; `loaded-rules.md` is byte-stable.
   - Smoke: bash script with mock state files produces expected line.
   - Existing tests (`hook-installers.test.ts`, evaluator suite) stay green.
   - `npm run typecheck && npm run test`.

## Rollout

The script is regenerated on `interlinked enable`, so existing users pick
up the new layout the next time they run that command. New installs get
it immediately. No flag, no config opt-in — the new line is strictly
additive in information density. If it turns out to be too dense in
practice we'll add a `statusline.compact` toggle in `config.local.json`
in a follow-up.

## Risks and mitigations

- **OSC 8 in unsupported terminals** (Terminal.app, some tmux configs).
  The escape sequences are stripped harmlessly — the visible text still
  renders. We document `FORCE_HYPERLINK=1` in the troubleshooting section
  of `docs/harness.md`.
- **Snapshot drift** if the harness crashes mid-write. We write to a
  `.tmp` sibling and rename — atomic on POSIX. Bash script falls back to
  the per-subsystem `.status` files when the snapshot is missing or older
  than 60s.
- **Bash portability** — current script is bash-only; we keep that
  constraint. macOS/Linux are the supported platforms; Windows uses the
  PowerShell path covered by Anthropic's docs (separate concern).

## Update history

The line shape has iterated several times during the redesign — pipeline
narrative dropped, off-state badges removed and restored with real click
targets, mode segment removed. See git log for the timeline.
