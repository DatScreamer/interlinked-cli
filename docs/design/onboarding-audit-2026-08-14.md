# Fresh-eyes onboarding audit — 2026-08-14

Status: audit report, 2026-08-14. Role: a competent developer who has never
seen this project, found the repo, and wants the harness guarding their own
codebase. All findings below are **verified** — commands were actually run,
against a real throwaway project, and the output quoted is verbatim, except
where explicitly marked **assumed**. Methodology and safety notes are in
§0; skip to §2 for the findings table if you just want the results.

## 0. Methodology

- Read `README.md` and the `docs/` tree top-down first, exactly as a
  stranger would land on the repo, with zero use of the `interlinked-*`
  skills that exist to help people who already know this tool.
- Built a clean, isolated copy of the CLI via `git archive HEAD | tar -x`
  (a read-only export of the committed tree — no clone, no working-tree
  copy, no git state touched, and no interference with other sessions
  actively rebuilding `dist/` in the live checkout during this audit) into
  the scratchpad, symlinked `node_modules` from the live checkout (same
  lockfile — avoids re-running `npm ci`, which was **not independently
  timed**; everything downstream of the build **was**), and ran
  `npm run build` for real.
- In place of `npm link` (which would mutate global npm state on a shared
  dev machine), used a two-line shell shim that `exec node
  <checkout>/dist/index.js "$@"` — architecturally identical to what
  `npm link` produces (a PATH shim to the same file), so the command
  surface tested is the real one.
- Created a throwaway target project (`onboard-test/my-app/`: `package.json`,
  two small `.js` files, a `README.md`) entirely inside the scratchpad, with
  **no git repository** — deliberately, to honor "no git state mutations
  anywhere" literally rather than assuming a scratchpad carve-out.
- All `enable`/hook-install/harness-start commands ran only inside that
  throwaway project. Before and after the first hook install, `~/.claude/settings.json`
  was read (never written) and checked for contamination — confirmed clean
  throughout (§2, Finding row for safety verification). No `src/` file in
  this repo was edited. No git command that mutates state was run anywhere,
  including the throwaway project.
- Zombie daemon processes spawned into the sandbox during testing were
  killed at the end of the session (`pkill -f onboard-test/.../harness/server.js`)
  as a courtesy on a shared, already heavily-loaded machine.
- **Caveat on timings:** this machine had ~6 other node processes from
  unrelated concurrent sessions consuming CPU/RAM throughout (a mutation
  campaign, a Stryker run, two long-lived broker/runner daemons). Absolute
  wall-clock numbers below are likely inflated versus a quiet machine; where
  a finding is about a *contradictory message* rather than raw speed, that
  finding holds regardless of load.

## 1. Walked path, with per-step timing

| # | Command | Wall time | Result |
|---|---|---|---|
| 1 | Read `README.md` | — | Clear value prop, install steps present, quick start present |
| 2 | Read `package.json` | — | Fully npm-publish-shaped; **not actually published** (npm registry 404) |
| 3 | `npm run build` (clean `git archive` snapshot) | **15.7s** | Succeeds; produces `dist/index.js`, `dist/hook-entry.js` as documented |
| 4 | `interlinked --version` (via shim) | instant | `0.1.0` |
| 5 | Bare `interlinked` (no config, non-TTY) | **0.71s** | Full silent bootstrap (config + hooks + skills + gitignore + harness auto-start). Harness auto-start **failed** in 1s (`EADDRINUSE` against itself) |
| 6 | `interlinked harness status` (post-failure) | 0.13s | Correctly reports "not running", gives exact fix command |
| 7 | `interlinked doctor` (harness down) | 0.31s | 10 pass / 9 warn; correctly flags harness down |
| 8 | `interlinked enable --dry-run` (re-run) | 0.08s | Clean preview, but omits skills + harness-start side effects |
| 9 | `interlinked enable` (real, 2nd/idempotent run) | **60.4s** | Prints red **"Failed to start harness after 60s"** immediately followed by green **"Hooks are active"** |
| 10 | `interlinked harness status` (mid-run, concurrent) | 0.12s | Daemon actually alive (PID confirmed) |
| 11 | `interlinked doctor` (2nd) | 0.15s | 11 pass / **1 FAIL** (low free memory — machine-load artifact) / 7 warn; false-negative on hooks (see §2) |
| 12 | `interlinked harness test "rm -rf /"` | fast | **Blocked** correctly (cold-fallback pattern match) |
| 13 | `interlinked harness test --write ... --from-file` (secret) | 0.09s | Honest `"Harness not running"` — declines rather than silently allowing |
| 14 | Real `hook-entry.js` PreToolUse Write w/ secret (direct stdin, as Claude Code would invoke it) | 0.035s | **Correctly denied**, fail-closed, clear reason text |
| 15 | `interlinked harness start` (explicit) | 0.13s | Reports "already running" — a **second** zombie daemon, still not listening |
| 16 | Foreground `node server.js --verbose` (tool's own suggested debug step) | ~1s to repro | Reproduces the same self-collision every time, deterministically |
| 17 | `interlinked index build` | 0.12s | Builds successfully but **leaks raw `fatal: not a git repository` text twice** |
| 18 | `interlinked --help` | instant | 83 top-level commands, flat alphabetical list, no grouping |
| 19 | `interlinked status` | instant | Clean, honest empty state; guidance line is checkout-specific (see §2) |

**Time-to-first-value estimate:** see the structured-output field; short
version — the documented happy path (clone → `npm ci` → build → link →
`enable` → `harness start` → `harness test`) should be roughly 2–3 minutes
if nothing goes wrong. This audit's own repro of the harness-start bug (row
5, 9, 15 above) turned that into a much longer, confusing detour chasing a
red "Failed" message before `harness status`/the live hook test showed the
guard was, in fact, protecting the project the whole time via fail-closed
behavior — just not via the daemon the messages were talking about.

## 2. Findings, ranked by severity

### Critical

**F1 — The harness daemon can start in a "zombie" state (process alive,
no listening socket) that both diagnostic commands report as healthy.**

Reproduced 3 times independently (bootstrap auto-start, `enable`'s internal
start, explicit `harness start`), and once more via the tool's own suggested
debug command. Root cause, read directly from `.interlinked/logs/daemon.log`:

```
[interlinked-harness] Harness started (dual) on raw .../harness.sock, framed .../harness-default.sock (PID 6180, 120 rules)
[interlinked-harness] [interlinked] Raw socket listen failed (EADDRINUSE) — exiting so auto-revive can spawn a working daemon.
[interlinked-harness] uncaughtException — kept the daemon alive (guard continuity): Error: listen EADDRINUSE: address already in use .../harness-default.sock
    at Server.setupListenHandle [as _listen2] (node:net:1918:21)
    ...
    at startSessionDaemon (.../dist/harness/server.js:30656:11)
```

The log line says "exiting so auto-revive can spawn a working daemon," but
the actual behavior — confirmed by an `uncaughtException` handler one line
later — is the opposite: it **catches its own startup bind failure and
keeps the process alive** instead of retrying the bind or actually exiting.
Verified with `lsof -p <pid>` and `find .interlinked -type s`: the resulting
process holds **zero** filesystem-bound unix sockets (raw or framed) on
either of two independently-spawned zombie PIDs, yet:

- `interlinked harness status` reports `Status: running (PID ...)` — with
  `Socket: not found` printed two lines below it, unexplained.
- `interlinked doctor` reports `[pass] Harness server -- Running (PID ...)`.
- `interlinked harness start`, run again, reports `Harness already running`
  and does nothing to fix it — it spawns nothing, and the process it's
  pointing at cannot serve any hook.

**This is a diagnostics bug, not (as far as this audit could establish) a
security hole:** a direct test of the real agent-facing path — piping a
synthetic `PreToolUse` Write event containing a fake AWS secret straight
into `hook-entry.js`, exactly as Claude Code would invoke it, against the
confirmed-zombied daemon — was **correctly denied** in 35ms:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
"permissionDecisionReason":"BLOCKED: the interlinked harness should be guarding
this project but is unreachable (harness pid present, no live daemon). ...
tool calls are blocked to avoid running unguarded. It is being auto-restarted
— retry your call in a moment, or run `interlinked harness start`. ..."}}
```

So the hook path does its own independent liveness check and correctly
distinguishes "pid present, not actually listening" from healthy — the two
diagnostic commands do not perform the same check, which is the actual bug.
A user who trusts the green `doctor` line (the natural thing to do) has no
reason to suspect the daemon isn't really running, and each failed start
leaves a fresh ~110 MB zombie process behind (two accumulated during this
audit alone), on a check that separately warns about low free memory.

**Caveat:** this audit could not fully rule out that the shared, heavily-
loaded test machine (multiple concurrent unrelated node processes, per §0)
contributed to triggering the initial race. The underlying code smell —
catching a fatal startup-listen error and silently continuing instead of
retrying-then-failing loudly — is real regardless of what triggers it, and
"transient contention during startup" is exactly the situation a
resource-constrained laptop or CI cold-start hits in practice.

### High

**F2 — `interlinked enable`, run a second time, took 60.4 seconds wall-clock
and printed a red failure immediately followed by a green success.**

Full captured tail of the run (verbatim):

```
Installed Interlinked skills for claude
  Load /enforce plus the interlinked-* skills on demand from your agent
Failed to start harness after 60s.
Process is running but socket not created. Try foreground:
  node .../dist/harness/server.js --cwd .../my-app --verbose

Not detected: copilot, gemini, codex, cursor (add with --clients)
...
Hooks are active. Agent activity is logged to .interlinked/activity.jsonl.
interlinked enable  0.15s user 0.08s system 0% cpu 1:00.40 total
```

Independent of F1's root cause, this is a UX problem on its own: the
health-check waits a full 60 seconds, then reports failure in red, then
immediately reports overall success in green in the same breath, with no
explanation of what "Hooks are active" means given the harness line right
above it. A first-time user re-running `enable` (an extremely ordinary
action — e.g. after adding a client) gets a worst-of-both-worlds result: a
full minute of silence, a scary message, and a reassuring message, with
nothing to say which one to believe.

**F3 — `doctor`'s hook-detection check has a confirmed false-negative.**

Both the initial bootstrap and the subsequent `enable` re-run printed
`Installed hooks: + claude — 13 event(s): ...`, and the project's own
`.claude/settings.json` was independently read and confirmed to contain 13
correctly-formed hook entries calling `hook-entry.js`. Yet `doctor` reports:

```
[warn] Claude Code hooks -- Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'
```

Root cause (`src/commands/doctor-checks.ts:258-267`):

```ts
function clientHookResult(clientName: string, content: string): CheckResult {
	if (content.includes("interlinked-activity")) {
		return { name: `${clientName} hooks`, status: "pass", message: "Hooks installed" };
	}
	return { name: `${clientName} hooks`, status: "warn",
		message: "Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'" };
}
```

`grep -c "interlinked-activity" .claude/settings.json` on the real,
freshly-written file returns **0** — the hook commands `enable` writes
reference `hook-entry.js` directly by absolute path (exactly as the README
describes: *"records an absolute path to `dist/hook-entry.js`"*) and never
contain the literal substring the check looks for. This matches a risk
already named in this project's own working notes about two separate hook-
generation code paths ("some hand-mirrored") having drifted apart — this is
that drift, caught live, on the very first project a new user points the
tool at. The fix telling a user to re-run a command that will not change
the outcome is worse than no check at all: it burns a retry loop on a
correct install.

**F4 — Four overlapping "one-command onboarding" entry points exist, with
no doc that reconciles them.**

- Bare `interlinked` (non-interactive bootstrap when unconfigured)
- `interlinked enable` — "Install hooks + create `.interlinked/` config" —
  the one README's Quick Start actually shows
- `interlinked setup` — "One-command setup: install hooks, configure
  server, authenticate" — the one `docs/command-reference.md` and
  `docs/how-to-use.md` both feature instead
- `interlinked init` — "One-command onboarding: detect clients, configure,
  login, verify" — **not mentioned in any prose doc**, only discoverable
  via `--help`

All four do materially different subsets of {write config, install hooks,
install skills, start harness, log in, verify}. Nothing — not the README,
not `docs/command-reference.md`, not `--help` — tells a stranger which one
is "the" onboarding command versus a specialized variant.

**F5 — `docs/how-to-use.md` is stale and contradicts the current project
model a stranger would just have read in the README.**

```
### In this repository
cd cli
npm install
npm run build
npx ./dist/index.js setup --server http://localhost:8787
```

There is no `cli/` directory anywhere in this repository (verified:
`ls cli` → "No such file or directory") — this doc is a leftover from when
the CLI lived as a subdirectory of a different, sibling monorepo. Its
"Mental Model" section states *"Interlinked MCP Server: Source of truth for
workspaces, tasks, messages, reservations, agents"* and frames the CLI as a
thin client to that server — the opposite of the README's and this
project's own current framing (server is optional/dormant, the local
harness is the product). A stranger who clicks into `docs/` after the
README — the natural next step — lands on a page that actively misdirects.

### Medium

**F6 — The CLI's own `--help` text contradicts the README's explicit
guidance, on every single command.** Every `--help` invocation (verified on
both `interlinked --help` and `interlinked harness test --help`) ends with:

```
Quick start:
  interlinked install-hooks --runner claude-code    install local agent hooks
  ...
```

The README says, in bold: *"**Use `enable`, not `install-hooks`**, unless
you know you want the adapter path."* The CLI disagrees with its own
top-level pitch every time `--help` is printed — a one-string fix.

**F7 — `interlinked status`'s guidance for an unreachable server assumes
you're standing inside the interlinked-cli source checkout.**

```
Server
──────
  URL            http://localhost:8787
  Status         unreachable
  Error          server unreachable

Guidance
────────
  Local server is not reachable.
  Start it with: npm run dev
```

Run from `my-app` (a normal target project with no `npm run dev` script for
any Interlinked server), this advice cannot be followed. It also presents
the (per README, fully optional) MCP Server as an unresolved problem rather
than noting local-only use needs no server at all — undercutting the
README's own "local-first... no required cloud" pitch at the exact moment a
new user checks whether their install is healthy.

**F8 — `interlinked index build` leaks raw git error text outside a git
repo**, twice, before still succeeding:

```
Building trigram index for .../my-app...
fatal: not a git repository (or any of the parent directories): .git
  Indexing... 1/4 filesfatal: not a git repository (or any of the parent directories): .git
Index built in 0.0s
```

No doc mentions git is expected. The index still builds (`Base commit:
unknown`), so this is a display bug, not a functional one — but it's the
kind of raw stderr leak that reads as "broken" to a first-time user.

**F9 — Top-level `--help` lists 83 commands as one flat alphabetical list**,
with no grouping by "you need this on day one" vs. advanced/niche
(`replay`, `spec`, `sponsor`, `cloud`, `reminder`, `guard`, `ci-status`, …
all sit at the same visual weight as `enable`/`doctor`/`status`). The
README's curated 14-row "Day-to-day commands" table is a far better front
door, but nothing routes a `--help`-first stranger to it.

**F10 — `enable --dry-run`'s preview is incomplete.** It reports the config
write, the hook script write, and the `.gitignore` update, but never
mentions that real `enable` also installs 20 skill files and attempts to
auto-start the harness (the two side effects most relevant to "is this
safe to run" and, per F1/F2, the most likely to misbehave).

### Low

**F11 — `package.json` is fully shaped for npm publish** (`bin`, `files`,
`publishConfig.access: public`, `prepublishOnly`) but the package has never
actually been published — confirmed via a direct registry query
(`registry.npmjs.org/interlinked-cli` → `404 Not Found`). Not a bug; README
is accurate and explicit about source-only install. Worth noting only
because a reader who checks `package.json` before finishing the README
could reasonably expect `npm install -g interlinked-cli` to work.

**F12 — `harness status`'s field layout self-contradicts at a glance.**
`Status: running (PID …)` prints directly above `Socket: not found` with no
connecting explanation. Technically each line is independently accurate
(raw socket specifically absent), but the juxtaposition reads as a
contradiction to a reader with zero context — which every first-time reader
has.

### Positive findings (for balance / do-not-regress)

- The real hook-enforcement path (F1's mitigation) is genuinely well built:
  it independently detects "pid present, no live daemon," fails closed, and
  returns a clear, actionable reason string in ~35ms — even in the one
  broken daemon state this audit could produce.
- `interlinked harness test "rm -rf /"` (the README's own example command)
  works exactly as documented on the first try.
- `interlinked doctor` and `interlinked harness status`, despite F1/F3,
  are otherwise information-dense and mostly accurate — free memory, CPU
  cores, orphan daemon detection, auth state, and adoption-baseline gaps
  are all genuinely useful, well-labeled signals a stranger can act on.
- `interlinked status` on an empty project is honest (no fabricated
  "activity" to look busy) and gives a concrete next step.
- The build (`npm run build`) worked cleanly first try from a truly clean
  checkout in 15.7s and produced exactly the two binaries `package.json`
  promises.
- Hook installation was correctly project-scoped — `~/.claude/settings.json`
  was verified untouched throughout (mtime and content both confirmed
  before and after every `enable` run in this audit).
- Agent-facing onboarding (the `skills/` tree — 10 skill folders, 864 words
  in the router skill alone, auto-installed by `enable`) is materially more
  thorough and more current than the human-facing docs in `docs/`. The
  asymmetry is itself worth naming: this project has invested far more in
  teaching *agents* how to use it than in keeping the *human* docs
  consistent with each other.

## 3. Doc gaps

1. No doc anywhere reconciles the four onboarding entry points (F4).
2. `docs/how-to-use.md` is stale to the point of actively misleading (F5)
   — needs a rewrite or deletion, not a patch.
3. README has **zero links into `docs/`** (`grep -c docs/ README.md` → 0)
   — the entire 21-file `docs/` tree, including the one genuinely useful
   `docs/harness.md` and `docs/command-reference.md`, is undiscoverable
   from the front door.
4. No doc states that a git repository is expected/recommended for full
   functionality (trigram index base-commit tracking at minimum).
5. No troubleshooting doc for "the harness won't start" covers the exact
   failure this audit reproduced three times, or names `interlinked
   harness reap --force` (doctor's own suggested remedy for orphans) as
   something to reach for.
6. No stated minimum machine resources (doctor checks free memory *after*
   the fact; nothing up front sets expectations).
7. `docs/command-reference.md`'s "Setup Commands" section leads with
   `setup`, not `enable` — inconsistent with the README's explicit
   emphasis, compounding F4.
8. No changelog/maturity signal in the README itself (version 0.1.0, no
   "how stable is this" framing) — a minor gap, not scored above because
   it's a judgment call rather than a verified inconsistency.

## Notes on severity calibration

F1 is rated Critical primarily because it defeats trust in the tool's own
health signals, not because it defeats the guard itself — the fail-closed
path held in the one adversarial test this audit ran against it. Treat F1
as "fix the lie the diagnostics tell," not "the security model is broken."
Everything in Medium/Low is pure documentation or messaging work with no
code risk, which is why the top-5 list below front-loads the doc fixes as
the quick wins they are.
