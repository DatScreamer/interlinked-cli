# Cowork Compatibility Probe — automating "does the interlinked harness work on Claude Cowork?"

**Status:** Design — not built. The buildable, Cowork-independent core (the spy-hook
template, the log analyzer, and the `report` mode) can land now and is unit-testable
without Cowork; the macOS UI driver needs a Mac with Cowork installed to validate.

**Origin:** 2026-05-18 design conversation. Follows the 2026-05-17 Cowork-adaptation
discussion; companion to `browser-testing-layer.md`.

---

The interlinked harness works on Claude Code because Claude Code gives it three
things: a local agent, local file access, and a **hook surface it can block on**.
Enterprises increasingly run **Claude Cowork** instead. The question — *does the
harness work on Cowork* — has one load-bearing unknown, and that unknown can only
be answered by **measurement on a real Cowork install**, not by reading docs. This
memo specifies how to automate that measurement, and how the harness plugs into
Cowork once the answer is known.

## 1. The core constraint: you cannot test what you cannot run headlessly

Claude Code is scriptable — `claude -p`, `--bare`, the Agent SDK — so its hook
behaviour is trivially testable in CI. **Cowork is not.** It is a desktop GUI
application inside the consumer Claude Desktop app. A web search for "Cowork
automation / CLI / headless" returns *only* Claude Code's headless mode — there is
no documented Cowork CLI, URL scheme, or automation API (checked 2026-05-18). So:

- The harness's compatibility with Cowork **cannot be assumed** from the Claude Code
  docs — Cowork is absent from the [hooks reference](https://code.claude.com/docs/en/hooks).
- It **cannot be reasoned out** — it is a property of the shipped Cowork build.
- It **must be measured**, and the measurement automated *around* a GUI app.

That is the problem this probe solves: a repeatable, mostly-automated evaluation
that a Cowork seat-holder runs in ~2 minutes and that emits a deterministic verdict.

## 2. What is actually known about Cowork (2026-05, web-sourced)

| Fact | Source | Implication for the harness |
|---|---|---|
| Cowork is a **local desktop agent** in the Claude Desktop app, working on local files | [Anthropic product page](https://www.anthropic.com/product/claude-cowork) | The Unix-socket daemon, PostToolUse file inspection, and local check library are **not** invalidated — no server-side rebuild needed |
| Cowork shares the `.claude/`-lineage config; hooks in `.claude/settings.json` are a **real, retained surface** | [CVE-2025-59536](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/) (RCE via planted hooks) | The harness's install target *exists*; hooks were hardened (§8), not removed |
| **No** Cowork CLI / headless / automation API | web search, 2026-05-18 | The probe's "drive" step cannot be a subprocess call — it needs UI automation (§4.2) |
| Admin controls are GUI toggles + `managed-settings.json` pushed via MDM (non-overridable) | [Repello security guide](https://repello.ai/blog/claude-cowork-security) | MDM `managed-settings.json` is the enterprise-policy layer the harness could ride if hooks fail |
| Observability is **OpenTelemetry only**; prompts / tool names excluded by default; Cowork is **excluded from the Compliance API, Audit Logs, and Data Exports** | [Repello](https://repello.ai/blog/claude-cowork-security), [Cowork enterprise help](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans) | The async-audit fallback rail (§7) is weak — verbose logging must be explicitly enabled |

**The load-bearing unknown:** post-CVE-2025-59536, does Cowork *specifically* (a)
execute the `hooks` block in `.claude/settings.json` / `~/.claude/settings.json`,
(b) honour a hook's `block` decision as a veto, and (c) fire hooks for Cowork-native
actions (connector calls — Gmail / Drive — not only file edits)? Everything the
harness does on Cowork forks on those three answers.

## 3. The five-layer question (L0–L4)

"Does Cowork support hooks" is really five separable questions, and they can have
different answers:

- **L0** — Does Cowork shell out to a hook-honouring runtime, or run its own?
- **L1** — Does it read and *execute* the `hooks` block in `.claude/settings.json` at all?
- **L2** — Which events fire (`PreToolUse` / `PostToolUse` / `SessionStart` / `Stop` / …),
  and what is the stdin payload shape of each?
- **L3** — Is the **block contract** honoured — does a `deny` actually veto the action,
  or is the hook merely observed?
- **L4** — Does it fire for *Cowork's* action types — file edits **and** connector
  calls — or only some?

L2's captured payload shapes are not just a yes/no — they are the **fixtures** the
`cowork` runner adapter is later built and tested against (§7).

## 4. Architecture — three separable layers

The probe is three layers that fail independently. Two of them are pure code,
buildable and unit-testable here with **no Cowork install**; only the middle layer
touches the real app.

### 4.1 Capture — the spy hook *(100% automatable; Cowork-independent to build)*

An instrumented hook script registered in every config location Cowork might read —
`.claude/settings.json` (project) and `~/.claude/settings.json` (user), for **every**
lifecycle event. On each fire it appends one structured record to an append-only
JSONL and exits. Sketch:

```js
#!/usr/bin/env node
// cowork-probe spy hook — records every fire; vetoes the canary (§5).
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let evt = {};
  try { evt = JSON.parse(input); } catch { /* non-JSON stdin — record anyway */ }
  const eventName = evt.hook_event_name ?? process.env.PROBE_EVENT ?? "unknown";
  const toolInput = JSON.stringify(evt.tool_input ?? {});
  const canaryHit =
    eventName === "PreToolUse" && toolInput.includes(CANARY_SENTINEL);
  fs.appendFileSync(PROBE_LOG, `${JSON.stringify({
    ts: new Date().toISOString(),
    event: eventName,
    payload_keys: Object.keys(evt).sort(),
    tool_name: evt.tool_name ?? null,
    session_id: evt.session_id ?? null,
    cwd: evt.cwd ?? null,
    pid: process.pid,
    ppid: process.ppid,
    parent_cmd: readParentCmd(process.ppid), // ps -o command= -p <ppid>
    canary_attempted_block: canaryHit,
  })}\n`);
  if (canaryHit) {
    // The L3 test: emit a block and see whether Cowork honours it (§5).
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: "cowork-probe canary veto",
    }));
  }
  process.exit(0);
});
```

The spy hook is **self-contained** (zero imports from the CLI package) — the same
constraint the real generated hook obeys, so it runs even where the CLI is absent.

### 4.2 Drive — make Cowork perform actions *(the hard layer; three fallbacks, ranked)*

The capture and verdict layers are identical regardless of how Cowork is driven;
only this layer differs. Ranked by how automated each is:

1. **Programmatic** — *not available.* No Cowork CLI / API exists (2026-05-18). If
   Anthropic ships one, this becomes a subprocess call and the whole probe is CI-able.
2. **macOS Accessibility automation** — *the real automation answer.* Cowork is the
   Claude Desktop app on macOS; macOS exposes every app through the Accessibility
   API. The driver (`osascript` / AppleScript, or `cliclick`) focuses the app, opens
   a new Cowork task, pastes a **deterministic prompt** that forces specific tool
   calls, accepts the post-CVE **trust dialog** (§8), and waits. This runs unattended
   on a Mac with Cowork installed and Accessibility permission granted to the
   terminal. It is brittle against Cowork UI changes — hence §8's "re-run on update".
3. **Human-in-the-loop checklist** — *the floor.* If (2) is unavailable, the probe
   prints a tight, deterministic 4-step checklist a person runs in ~2 minutes
   (open task → paste prompt → accept trust → observe). Capture + verdict are
   unchanged; only the human substitutes for the AppleScript driver.

The **deterministic prompt** is fixed text engineered to force, in order: a file
*read*, a file *edit*, a *bash* command, and — for L4 — a *connector* call
(e.g. "list my 3 most recent Drive files"). One prompt exercises every layer.

### 4.3 Verdict — the analyzer *(100% automatable; Cowork-independent to build)*

A pure function: `analyzeProbeLog(records, sentinelFileExists) → ProbeVerdict`.
Deterministic, no LLM (per `feedback_harness_deterministic_only`). It answers:

- **L0** — any record whose `parent_cmd` contains `claude` → Cowork shells to a
  Claude runtime (hooks inherited like Claude Code Desktop); else its own runtime.
- **L1** — any record at all → Cowork executes the `hooks` block. *Zero records →
  the harness's hook mechanism does not work on Cowork; go to §7's fallback rails.*
- **L2** — the set of distinct `event` values + each one's `payload_keys` → event
  coverage and payload shapes (→ adapter fixtures).
- **L3** — **the canary, §5.** Grounded in a filesystem fact, not a log claim.
- **L4** — any record whose `tool_name` is a connector tool → hooks fire for
  Cowork-native actions, not only file edits.

Output:

```jsonc
{
  "hooks_fire": true,            // L1
  "block_honored": false,        // L3 — the make-or-break field
  "shells_to_claude_runtime": true,   // L0
  "events_seen": ["SessionStart", "PreToolUse", "PostToolUse", "Stop"],
  "connector_events_seen": ["PreToolUse"],          // L4
  "payload_shapes": { "PreToolUse": ["cwd", "hook_event_name", "session_id", "tool_input", "tool_name"] },
  "harness_compat": "observe-only",  // adapter | observe-only | fallback-rails
  "cowork_build": "<version string captured at drive time>"
}
```

## 5. The block-contract canary — the decisive, filesystem-grounded test

L3 — *is a `block` decision a veto?* — is the make-or-break question, and a hook
self-reporting "I returned block" proves nothing. The canary makes the verdict a
**filesystem fact**:

1. The deterministic prompt instructs the agent to create a sentinel file named
   `COWORK-CANARY-SHOULD-NOT-EXIST.txt`.
2. The spy hook returns `{ "decision": "block" }` on the `PreToolUse` for that
   write (and *only* that one — every other action passes through).
3. After the run, the analyzer checks the filesystem:
   - sentinel **absent** + a `canary_attempted_block` record present → **block honoured**;
     the harness can gate on Cowork (`harness_compat: "adapter"`).
   - sentinel **present** → Cowork ran the hook but ignored its veto →
     **observe-only** (`harness_compat: "observe-only"`).
   - no spy record at all → **L1 failed** (`harness_compat: "fallback-rails"`).

No trust is placed in the hook's self-report; the verdict is `existsSync(sentinel)`.

## 6. `interlinked cowork-probe` — the command

| Mode | What it does | Needs Cowork? |
|---|---|---|
| `cowork-probe install` | Writes the spy hook + registers it for every event in `.claude/settings.json` + `~/.claude/settings.json`; resets the probe log | No (pure file writes) |
| `cowork-probe drive [--manual]` | Runs the macOS Accessibility driver; `--manual` prints the human checklist instead | Yes (or `--manual`) |
| `cowork-probe report [--json]` | Runs the analyzer over the probe log + sentinel check → prints the L0–L4 verdict | No |
| `cowork-probe clean` | Removes the spy hook from every settings file; deletes the probe log | No |

File layout:

- `src/commands/cowork-probe.ts` — the four sub-modes.
- `src/lib/cowork-probe/spy-hook.ts` — the instrumented-hook template + the JSONL
  record schema (one shared type).
- `src/lib/cowork-probe/analyzer.ts` — `analyzeProbeLog()`. **Pure function — fully
  unit-testable now with synthetic logs, no Cowork.**
- `src/lib/cowork-probe/driver-macos.ts` — the AppleScript / Accessibility driver
  + the `--manual` checklist text.
- `src/lib/cowork-probe/__tests__/analyzer.test.ts` — synthetic logs covering each
  L0–L4 outcome and each `harness_compat` verdict.

The spy hook reuses the established self-contained-hook discipline
(`docs/...`/`hooks.ts`), and the install path reuses the same merge-safe write
machinery the B refactor hardened (`src/harness/installer.ts` — purge-then-insert,
so a re-run of the probe never stacks duplicate spy hooks).

## 7. How the harness works with Cowork — the fork the verdict drives

`report`'s `harness_compat` field selects the integration path:

- **`adapter`** (L1 + L3 pass — hooks fire, block honoured): Cowork becomes the
  **sixth `RunnerAdapter`** (`cowork`), alongside the five in `src/harness/adapters/`.
  The adapter's `parseHookInput` is built directly against the **L2-captured payload
  shapes** — the probe's output *is* the adapter's test corpus, so the adapter is
  test-driven by real data. `interlinked enable` adds `cowork` to its client list;
  real-time PreToolUse gating works exactly as on Claude Code.
- **`observe-only`** (L1 passes, L3 fails — hooks fire but `block` is not a veto):
  the harness runs in **observe mode** on Cowork. PostToolUse feedback, activity
  logging, and the quality/structural checks all work; PreToolUse cannot veto. The
  `cowork` adapter's `encodeDecision` maps a `block` to a loud, model-visible
  warning rather than a denial. This is still most of the harness's value.
- **`fallback-rails`** (L1 fails — Cowork does not execute the hook): the harness
  rides three weaker rails, none of which can hard-block:
  1. a **Skill** that injects the `/enforce` Tier-1/2/3 policy artifacts as
     model-visible context (soft, advisory);
  2. **MCP-connector gating** — the harness gates the MCP tools Interlinked owns;
     it cannot veto Cowork-native connector calls (this is the "Standalone
     Guardrails" path in `docs/design/three-product-architecture.md`);
  3. the **OpenTelemetry stream** consumed as an *async* audit — note its fields
     (prompts, tool names) are excluded by default and need verbose logging, so
     this rail is post-hoc, not preventive.

## 8. The CVE framing — the harness is hook-shaped, and that is load-bearing

CVE-2025-59536 was remote code execution achieved by **planting hooks in a project's
`.claude/settings.json`** that Claude Code executed before the trust dialog. It was
patched (Claude Code v1.0.111, Aug 2025) by **trust-gating** hook execution — not by
removing hooks. The interlinked harness's PreToolUse hook is, structurally, *exactly
the shape of that exploit*: a program the agent runs on every tool call, declared in
`.claude/settings.json`.

Two consequences:

1. **The probe's drive step must accept a trust dialog.** Post-CVE, a freshly
   installed spy hook will not fire until the Cowork user accepts trust for that
   workspace. The macOS driver and the manual checklist both account for this.
2. **The verdict is perishable.** Cowork auto-updates, and a build that executes
   `.claude/settings.json` hooks today can be hardened to sandbox or disable them
   tomorrow — the harness is precisely the surface such hardening targets. So the
   probe is not a one-shot: it is a **repeatable, versioned check**. `report`
   stamps the verdict with the captured `cowork_build`; the probe should be re-run
   on every Cowork update, and — wherever a Cowork test machine exists — scheduled.

## 9. Build plan + what is verifiable without a Cowork machine

Buildable and fully testable **now, with no Cowork install**:

- `spy-hook.ts` — the template + JSONL schema; tested by asserting the generated
  script's output shape against synthetic stdin.
- `analyzer.ts` — `analyzeProbeLog()`; tested with synthetic logs covering every
  L0–L4 outcome and all three `harness_compat` verdicts.
- `cowork-probe install` / `report` / `clean` — pure file operations.

Needs a Mac with Cowork to validate (write now, verify later):

- `driver-macos.ts` — the AppleScript / Accessibility automation. The `--manual`
  checklist path is the always-available fallback and needs no validation.

Sequencing: land §9's Cowork-independent core first (it is a self-contained,
test-covered feature and immediately useful — a Cowork seat-holder runs `install` →
`drive --manual` → `report` and gets the verdict). The macOS driver and the `cowork`
runner adapter (§7) follow once the probe has produced a real verdict and real
payload fixtures.
