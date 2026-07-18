# Interlinked — GTM feature & benefit inventory (X/Twitter)

Status: Living doc / marketing source material — 2026-07-17 (rev 2: mini-story pass).
Compiled from a full-codebase sweep (6 research passes over `src/`, `docs/`, generated docs,
and design docs), with every number verified against source at write time.

**How to use this.** Each card is one postable unit: the problem (feel), what we built (the
fix), and the payoff (found). The `Post:` line is a ready-to-edit draft written as a
**mini story** — a concrete scene, a turn, a payoff — in a builder voice. Cards are grouped
into 13 pillars that double as thread outlines, numbered 1–97 straight through so you can
track what's been posted.

**Story discipline:** every specific in a draft (the 28 orphan daemons, the 3GB log, the 65
redirect blocks, the 2 NaN bugs, the 3-repo build handover) is verified from source, receipts,
or design docs. When you punch up a draft, add color, not events — an invented "day 12" or a
fake log excerpt will eventually be checked against the repo you're pointing people at.

**Status legend** (every card carries one — never post a claim above the feature's status):

| Tag | Meaning |
|---|---|
| `[on]` | Shipped, on by default |
| `[opt-in]` | Shipped, requires a command/config to activate |
| `[off]` | Shipped but config-default-off (frame as "flip it on") |
| `[designed]` | Design complete, not built — roadmap framing only |
| `[internal]` | Real, but an engineering-process story rather than a product feature |

**Claim-safety ground rules** (from the sweep — violating these makes a post false):
- The CLI has exactly **one runtime dependency** (`commander@12.1.0`, exact-pinned, itself
  zero-dependency — the entire tree is one package). It is *not* "zero-dependency" — say "one
  runtime dependency" or "a one-package dependency tree."
- **Server-backed commands** (login, workspace, tasks, inbox, sync) need *your own* server —
  the public build ships none and defaults to localhost. Never market them as working out of the box.
- The dogfooding "receipts" are **one developer's machine over 38 days** — always frame as
  dogfooding, never as fleet telemetry.
- Check counts drift upward by design. Say "**360 checks today** (the count is test-pinned —
  `interlinked harness checks` prints yours)" rather than pinning 360 forever.
- **Do not cite "500ms socket timeout" or "3s POST timeout"** — those figures in older docs are
  stale. Verified: PreToolUse socket wait 5s; PostToolUse budget 30–60s by mode; the
  fire-and-forget server POST budget is 500ms. Safest public phrasing: "capture is local-first
  and the agent never waits on a network."
- The generated hook script is **"no third-party deps, no imports from the CLI package"** —
  not "zero-import" (it uses Node built-ins).
- Third-party incident references baked into rule text (a PaaS data-wipe, a hijacked npm
  package) must be **independently verified against the public record** before you name names
  in a post. See Appendix B.

---

## Positioning spine

**The one-liner (from the README, safe to reuse):** a local guard layer for AI coding agents.
It hooks into Claude Code, Codex, Cursor, Copilot CLI, and Gemini CLI; evaluates every tool
call against deterministic rules; blocks the dangerous ones in milliseconds; and keeps a local
activity log you can grep.

**Alternate one-liners to A/B:**
- "The harness for your harness."
- "Guardrails at the only layer an agent can't skip: where intent becomes a real-world action."
- "No model in the decision path. Every verdict explainable, reproducible, and fast."
- "Your agents got better. Your blast radius got bigger. Interlinked is the part that says no."

**Category discipline:** position as **coding-agent runtime enforcement** — not "AI governance
platform" (deliberate ICP-doc stance). The platforms nativized policy *distribution*
(managed settings, always-on hooks); none ship a deterministic per-tool-call policy engine,
quality ratchets, or a fail-closed supply-chain gate. They built the rail; this is the train.

**The numbers bank** (safe to cite, with framing):

| Number | What it is | Framing rule |
|---|---|---|
| 119 built-in guard rules, 25 categories | PreToolUse rule corpus | Test-pinned; docs fail CI if it drifts |
| 360 checks across 7 families | 235 inline + 33 tool + 29 suggestion + 25 structural + 23 sequence + 11 behavioral + 5 spec-ledger | "today's count"; catalog ≠ what fires per edit |
| 5 agent runtimes | Claude Code, Cursor, Copilot CLI, Gemini CLI, Codex CLI | — |
| 12 language profiles | TS/JS, Python, Rust, Go, C/C++, Java, Swift, CUDA, OpenCL, Metal, HLSL, WGSL | depth varies; TS/Py/Rust richest |
| 1 runtime dependency | `commander@12.1.0`, itself zero-dep; carries 148 command registrations + ~391 flags here | defended design stance |
| 865 / 1,081 / 38 days | audit-verified vs logged block events, dogfooding window | one machine, one dev |
| p50 1ms, p99 177ms | daemon latency over a 10,000-event stress burst | author's machine, dated verification run |
| ~10–50µs | trigram index query (measured) | index is opt-in; engages on big repos |
| ~20k tests | vitest suite | approximate; never pin exactly |
| 500 / 25 / 30 / 60% | line cap / cyclomatic cap / CRAP cap / untested-file floor | per-repo configurable defaults |
| 9 ecosystems | supply-chain manifest coverage (npm, PyPI, cargo, RubyGems, Go, Composer, Maven, Gradle, NuGet) | install verbs + manifest edits |

---

## Pillar 1 — "It blocked WHAT?" (disaster prevention)

The emotional core of the product: concrete catastrophes that deterministic rules stop before
they execute. Best material for demos, screenshots, and quote-tweets of agent-horror stories.

### 1. The 119-rule guard corpus `[on]`
- Problem: an agent mid-trajectory "decides" to run something irreversible — and it executes before any human sees it.
- Fix: every tool call passes a PreToolUse evaluation against 119 built-in deterministic rules across 25 categories (~80 block, 23 ask, 16 warn) before the tool runs. First match wins. No model in the loop.
- Benefit: the dangerous class of actions physically can't execute, and every verdict is explainable and reproducible.
- Post: "Six hours into a refactor, an agent hits a push rejection it doesn't understand and reaches for `git push --force` to 'make main match.' Not hypothetical — our 38-day dogfood log shows 13 destructive git commands blocked. 119 deterministic rules sit between 'the model decided' and 'the shell executed.' No LLM in the verdict. Milliseconds."

### 2. The live demo command `[on]`
- Problem: "trust me, it has guardrails" is unfalsifiable marketing.
- Fix: `interlinked harness test "rm -rf /"` fires a synthetic event at the live daemon and prints the actual verdict + reason. Also tests Write/Edit payloads.
- Benefit: anyone can watch a block happen in their own terminal in 10 seconds — perfect screenshot/GIF fodder.
- Post: "Every guardrails pitch ends with 'trust me.' Here's ours instead:\n\n$ interlinked harness test \"rm -rf /\"\nBLOCKED: Recursive deletion of filesystem root…\n\nRun it against your own daemon, your own merged rules. It exits 1 on block — so your CI can prove the protection is live on every build."

### 3. Force-push protection with a memory `[on]`
- Problem: `git push --force` on a shared branch erases teammates' work; agents reach for it when confused.
- Fix: force push is blocked outright (steered to `--force-with-lease`), and a temporal companion rule asks for confirmation if no `git log`/`diff`/`status` ran in the last 10 commands — i.e., pushing without looking.
- Benefit: the rule understands *trajectory*, not just the command string.
- Post: "Here's how an agent force-pushes: a push gets rejected, it panics politely, and reaches for the big hammer — without having run git log, git diff, or git status once in its last 10 commands. Pushing blind. That exact shape is what our temporal rule intercepts: 'inspect first.' The bare force-push is blocked outright either way, steered to --force-with-lease."

### 4. SQL catastrophe rules `[on]`
- Problem: `DROP TABLE`, `TRUNCATE`, and the classic `DELETE FROM users;` with no WHERE clause.
- Fix: 30 database-category rules block destructive SQL shapes — including the no-WHERE delete, plus local-dev traps like `rm -rf .wrangler` (which deletes the local SQLite dev database; the rule suggests `rm -rf .wrangler/cache` instead).
- Benefit: the most expensive one-line mistakes in software get intercepted at the shell/tool boundary.
- Post: "`DELETE FROM users;` — 19 characters, perfectly valid SQL, every row gone. A missing WHERE doesn't throw an error; it throws a company. It's one of 30 database shapes we block at the tool boundary — along with the local-dev classic `rm -rf .wrangler`, which agents run to 'clean caches' and which actually deletes your entire local dev database. (The rule tells them the safe subfolder.)"

### 5. Fork bombs and resource bombs `[on]`
- Problem: `:(){ :|:& };:` freezes a workstation instantly; agents occasionally emit cursed one-liners from training data.
- Fix: a resource-bomb category (10 rules) blocks fork bombs, infinite spin loops (`while true; do :; done`), and friends — always-evaluated, ~1µs per command.
- Benefit: the machine the agent runs on stays usable no matter what it hallucinates.
- Post: "Somewhere in your agent's training data is a 2009 forum post containing `:(){ :|:& };:`. The day it resurfaces, your laptop freezes mid-demo. Our fork-bomb rule pattern-matches it in about a microsecond — one of 10 resource-bomb rules, alongside the infinite spin loop `while true; do :; done`. Always evaluated, on every command. Cheap insurance."

### 6. Compound-command decomposition `[on]`
- Problem: `npm publish --dry-run && npm publish` — the harmless first half masks the live second half.
- Fix: shell lines are split on `;`, `&&`, `||`, `|`, and newlines, and *every segment* is evaluated independently.
- Benefit: no hiding a destructive command behind a benign prefix.
- Post: "Watch an agent probe a filter: `npm publish --dry-run && npm publish`. The first half is harmless, the second half ships to the registry, and a guard that judges whole lines sees only the harmless opening. Ours splits every command on ; && || | and newlines and judges each segment alone. The dry-run doesn't launder the publish."

### 7. Shell-redirect write bypass, closed `[on]`
- Problem: an agent that can't get an edit past the quality gate just runs `echo '…' > src/file.ts` instead — same write, zero review.
- Fix: Bash commands that write to tracked source files via redirect or `tee` are blocked (`bash-code-file-write-bypass`), with targets resolved through `VAR=` assignments and `cd` hops.
- Benefit: there is one door for code writes, and the gate is on it. (65 real catches in the 38-day receipts.)
- Post: "There's a category in our 38-day dogfood log I find genuinely funny: 65 blocked attempts to write source files through `cat > file.ts` and `tee` — the shell side-door around edit review. The gate resolves the real target through `TARGET=src/x.ts` assignments and `cd` hops, so disguising the path doesn't help either. Agents probe. Gates learn. 65–0."

### 8. Protected files — including blocking *reads* of private keys `[on]`
- Problem: exfiltration starts with a read. Most tools only guard writes.
- Fix: glob-driven policy blocks writes to secret-bearing files, blocks *reads* of `*.pem`/`*.key`, and blocks deletion of CI configs (`.github/workflows/**`, Jenkinsfile, …), DB migrations, CODEOWNERS, .gitignore.
- Benefit: the harness guards the leak direction too, not just corruption.
- Post: "An exfil chain doesn't start with a write. It starts with a read: open the `.pem`, then find somewhere to send it. So beyond write-protecting secrets, our harness blocks *reading* private-key files at the tool layer — and blocks deleting the files that keep you shippable: CI workflows, DB migrations, CODEOWNERS. 'The agent just wanted to look at it' is how it starts."

### 9. MCP tools judged by their name `[on]`
- Problem: MCP tools execute with a valid token and no built-in confirmation — `mcp__prod__delete_database` just… runs.
- Fix: any MCP tool call whose name contains delete/destroy/drop/truncate/wipe/purge/terminate/… triggers an ask-before-run.
- Benefit: a confirmation layer for an ecosystem that shipped without one.
- Post: "A tool named `mcp__prod__delete_database` will run with a valid token and zero confirmation — MCP shipped without a confirm dialog. Our fix is deliberately unglamorous: if the tool's *name* contains delete, destroy, drop, wipe, or purge, the call pauses for a human. Crude? Very. Also live today on every MCP server you connect, which is more than elegance has shipped."

### 10. Cloud-API destructive mutations `[on]`
- Problem: infrastructure now dies via HTTPS — a `curl` POST carrying a GraphQL `volumeDelete` mutation can wipe a production volume with no confirmation, no scoped token, no recovery SLA.
- Fix: destructive-HTTP rules inspect outbound `curl` bodies for known destructive API shapes (PaaS GraphQL mutations among them) and block.
- Benefit: guardrails that understand the *payload*, not just the binary being run. ⚠️ Verify the public incident record before naming any vendor in a post.
- Post: "2026 lesson: `rm -rf` has an HTTP equivalent. One curl POST carrying a GraphQL `volumeDelete` mutation can erase a production volume — no confirmation step, no undo, and on some platforms no scoped token that could have stopped it. A guard that only looks at the binary sees 'curl, harmless.' Ours reads the request *body* and blocks the known-destructive shapes before the network gets them."

### 11. RAT-pattern and exfil tripwires `[on]`
- Problem: compromised packages drop persistence: detached background processes with network access, data piped to clipboards, secrets curled to pastebins.
- Fix: security-category rules block `nohup`-style detached network processes and warn on clipboard-exfil patterns; a separate rule blocks *reading* the PII quarantine directory so scrubbed values can't re-enter the model's context.
- Benefit: post-compromise moves are caught even when the initial install looked clean. ⚠️ Verify supply-chain incident details before citing specific package names publicly.
- Post: "The strangest rule in our corpus blocks a READ. Nothing — no tool, no grep, no cat — may open `.interlinked/scanner/pending/`, the PII quarantine. The privacy filter scrubbed those values out of the model's context once; one innocent-looking read would smuggle every one of them back in. Redaction you can un-redact isn't redaction."

### 12. Repo confinement + self-preservation `[on]`
- Problem: agents scribbling into `$HOME`, sibling repos, or system paths; agents killing their own harness (or their own session's process tree).
- Fix: writes outside the project root are blocked (local-only allowlist for exceptions — deliberately *not* settable via committed team config); `kill <pid>` of the harness/agent ancestor chain is blocked up to 10 ancestor hops.
- Benefit: the blast radius is the repo, and the safety layer can't be terminated by the thing it supervises.
- Post: "Picture an agent 'cleaning up stray processes' — and one of the PIDs on its list is the guard daemon supervising it. Not malice; housekeeping. Our kill-protection walks the process ancestry up to 10 hops and refuses any kill aimed at its own chain. (Orphaned daemons from dead sessions? Fair game — there's a reaper for those.) A safety layer should be harder to remove than it was to install."

### 13. Edit sanity + WebFetch file:// block `[on]`
- Problem: small-but-constant failure modes — an Edit whose `old_string` doesn't exist in the file; `file://` URLs turning a web fetcher into a local file reader.
- Fix: bad Edits are blocked with near-miss line hints instead of failing downstream; `file://` fetches are blocked outright.
- Benefit: fewer wasted agent turns, one less local-read loophole.
- Post: "Least glamorous rule, most minutes saved: when an agent's Edit targets a string that isn't in the file, we block it immediately and point at the nearest match — instead of letting the edit fail downstream and watching the agent burn three turns re-reading the file in confusion. Also banned: `file://` in the web-fetch tool, which quietly turns 'browse the docs' into 'read /etc/passwd.'"

---

## Pillar 2 — Fail-closed engineering (what happens when the safety layer itself fails)

The trust-nerd pillar. Most "guardrails" evaporate exactly when things get weird. This is
the strongest differentiation story for a technical audience.

### 14. The daemon-down cold path still blocks `[on]`
- Problem: hook can't reach the guard daemon → most systems shrug and allow. The guard vanishes exactly when unguarded execution is most likely.
- Fix: the hook script runs 6 deterministic gates inline when the socket is unreachable: destructive commands, supply-chain installs, merge-conflict markers, the line cap, and more — each block stamped "fail-closed gate engaged." Everything else fails open with a loud notice (degraded, not wedged).
- Benefit: `rm -rf /` is blocked even with the daemon dead.
- Post: "Failure drill: kill -9 the guard daemon, then have the agent try `rm -rf /`. In most hook setups the answer is: it executes — the guard died with the daemon. Here, the hook script itself carries six inline fail-closed gates: destructive commands, unapproved package installs, merge-conflict garbage, the file-size cap. Each block is stamped 'fail-closed gate engaged.' The daemon is an optimization, not the last line."

### 15. Daemon cutout detection + self-heal `[on]`
- Problem: a crashed or stomped daemon silently downgrades a guarded repo to an unguarded one.
- Fix: the hook distinguishes crash/stomp/clean-stop (block + auto-respawn, throttled) from alive-but-slow (allow, for continuity). Intentional stand-down is a separate, *recorded* act.
- Benefit: "the guard is off" can only be true as an explicit, logged decision — never as an accident.
- Post: "Our hook can tell HOW the daemon died, and it matters. Crashed PID → block risky calls and respawn it, throttled. Socket stomped by another process → same. Deliberately stood down by a human → allow, because that decision is on the record with a reason. Alive but slow → let work continue. Draw the state machine and one state is unreachable: silently unguarded."

### 16. `disable` is a recorded stand-down, not an off switch `[on]`
- Problem: every safety tool gets disabled eventually; the question is whether anyone can tell afterwards.
- Fix: bare `interlinked disable` writes an audited marker — who, why (`--reason`), until when (`--until 2h` auto-expiry), personal or `--team` (which lands in PR diffs by design) — then stops the daemon and *verifies* it stopped, exiting non-zero if not.
- Benefit: consent with a paper trail; re-running `enable` re-arms symmetrically.
- Post: "`interlinked disable --reason 'perf bisect' --until 2h`\n\nOur off switch writes down who turned it off, why, and when it re-arms itself. A --team stand-down lands in the PR diff on purpose — your reviewers see the guard was down. And if the daemon doesn't verifiably stop, the command exits non-zero instead of pretending. Every safety tool gets disabled eventually; build for the afterwards."

### 17. The statusline tells you when you're unprotected `[on]`
- Problem: the scariest failure of a safety layer is silence.
- Fix: the installed statusline re-renders every few seconds from live daemon state; if the daemon disappears it shows a brief "restarting…" grace, then a red "harness offline / Claude is bypassing guardrails" alarm. Row 2 narrates the last verdict ("✗ blocked …", "⚠ caught 2 new issues before they landed (140ms)", "✓ last edit verified clean").
- Benefit: protection state is ambient — you never discover after the fact that the guard was down all afternoon.
- Post: "We gave the failure state a face. Kill the guard daemon and the statusline turns red and says the quiet part out loud: 'harness offline — Claude is bypassing guardrails.' The rest of the time it narrates: '⚠ caught 2 new issues before they landed (140ms)' → '✓ last edit verified clean.' You should never *discover* your protection was down all afternoon. You should have watched it happen."

### 18. Hot-reload rules; a security-split config model `[on]`
- Problem: policy changes shouldn't need a daemon restart — but a *committed* config that can execute arbitrary commands is a supply-chain hole in itself.
- Fix: rule files hot-reload within ~2s (built-ins → team config → local overrides). Committed team config is restricted to safe fields and *cannot* inject executable commands; only the gitignored local file can. Same reason linked-workspace roots are local-only.
- Benefit: teams tune policy in version control without the config file becoming an attack vector.
- Post: "Threat-model your own config file. If the *committed* guard config could define an executable command, then any approved PR could run code on every teammate's machine — your safety layer becomes the supply-chain hole. So ours splits: the committed tier can tune and tighten rules but can never define a command; only the gitignored local file can. A PR can raise your guard. It can't hijack it."

---

## Pillar 3 — Supply-chain defense (fail-closed installs)

### 19. Installs are deny-by-default `[on]`
- Problem: one hallucinated `npm install` is all it takes; malicious lookalike packages are surging.
- Fix: install commands across npm/pnpm/yarn/bun, pip/pipx/poetry/uv, cargo, gem/bundle, and go are blocked unless the package is on a committed allowlist or matches a lockfile snapshot. URL/git/tarball specs and custom registries are blocked unconditionally. Runs on the daemon path *and* the daemon-down cold path.
- Benefit: the default posture flips from "any dep, silently" to "approved deps only, with receipts."
- Post: "An agent is one confident typo away from `npm install expresss`. On our machines that command hits a wall whose default answer is no: not on the committed allowlist, not vouched for by a lockfile snapshot → blocked. Git URLs, tarballs, custom registries → blocked unconditionally (they bypass registry signing entirely). And the same gate runs inline in the hook, so killing the daemon doesn't reopen the door."

### 20. The manifest-edit backdoor, closed `[on]`
- Problem: agents skip the install command and just edit `package.json` — CI installs it later.
- Fix: Write/Edit diffs on manifests across 9 ecosystems (package.json, requirements.txt, pyproject, Cargo.toml, go.mod, Gemfile, composer.json, pom.xml, Gradle, NuGet) block newly-added unapproved deps and version→git/URL re-pins.
- Benefit: both doors to the dependency tree have the same lock.
- Post: "Block `pip install` and a resourceful agent doesn't argue — it just adds the line to requirements.txt and lets CI do the installing tomorrow. So the write gate diffs every manifest edit across 9 ecosystems: package.json, pyproject, Cargo.toml, go.mod, Gemfile, pom.xml… A dep that appears in the diff without an approval blocks at the keystroke. It also catches the sneaky re-pin: version → git URL. Both doors, same lock."

### 21. Three admission screens before a package can be approved `[on]`
- Problem: the worst failure mode is approving a bad package — everything after that is silent.
- Fix: `interlinked allowlist add` runs typosquat detection (Levenshtein ≤2 against ~107 popular names), an SPDX license gate (15 permissive defaults, committed and editable), and an OSV vulnerability query — each refuses without `--force`. Screens run at human-invoked admission time; the per-edit hook path never touches the network.
- Benefit: `expresss` and `axois` die at the approval step, and a CVE-carrying version gets named before it's blessed.
- Post: "What it takes to get a dependency approved here:\n1. Typosquat screen — Levenshtein distance against ~107 popular names. `axois` dies here.\n2. License screen — SPDX expression vs the committed allowlist.\n3. OSV screen — known vulns for that exact version.\nEach refuses without --force, and --force is itself a recorded decision. Because the one failure a supply-chain gate never recovers from is *approving* the bad package."

### 22. Lockfile snapshots + CI-gateable drift check `[on]`
- Problem: approving 400 transitive deps one at a time is theater nobody performs.
- Fix: `interlinked allowlist snapshot` hashes manifests/lockfiles (~30 filename shapes across ecosystems) to approve a whole resolved state at once; `interlinked allowlist verify` exits non-zero on any dep not covered — wire it into CI.
- Benefit: practical fail-closed: one command to bless reality, one command to catch drift forever after.
- Post: "Nobody reviews 400 transitive dependencies one at a time — which is how most fail-closed schemes fail: humans route around them. Our compromise: `allowlist snapshot` hashes your lockfile once and blesses the entire resolved state; `allowlist verify` exits non-zero in CI the moment reality drifts from what was blessed. One sha256 standing between you and silent dependency creep."

### 23. We hold ourselves to the same standard `[on]`
- Problem: a supply-chain gate written by a team with 300 dependencies is a punchline.
- Fix: the CLI ships with exactly one runtime dependency — `commander@12.1.0`, exact-pinned, itself zero-dependency, so the entire tree is one package. It earns its place by owning the largest correctness surface in the CLI: 148 command registrations and ~391 flags' worth of parsing, routing, and help generation. Colors, tables, timestamps, truncation — all hand-rolled. (Two optional deps power the AST complexity gate and faster typechecking, and the tool degrades loudly without them.)
- Benefit: the tool's own attack surface matches its philosophy — and the line has a stated rationale, not a vibe.
- Post: "Run `npm ls` on our CLI and the whole tree is one package: commander — exact-pinned, and itself dependency-free. It stays because it carries the biggest correctness surface we have: parsing and help for 148 command registrations and ~391 flags. Everything that's merely presentation — colors, tables, spinners — we hand-rolled. That's the actual discipline: not 'zero deps' as a flex, but a drawn line you can defend package by package. Ours has one package on the other side."

---

## Pillar 4 — "It caught WHAT?" (the 360-check feedback layer)

After every edit, the harness re-reads the file and reports what an agent can't see. These are
the best single-tweet bug stories — each detector card is a self-contained horror/relief arc.

### 24. The inventory itself `[on]`
- Problem: "we run some checks" is unfalsifiable.
- Fix: `interlinked harness checks` prints the authoritative count, derived live from each registry and pinned by tests: today 360 distinct checks — 235 inline content, 33 tool-based, 29 scored suggestions, 25 structural, 23 sequence/trajectory, 11 session-behavioral, 5 spec-ledger.
- Benefit: a concrete, test-pinned number that can't drift from reality (docs referencing it fail CI when it changes).
- Post: "Ask any scanner vendor 'how many checks, exactly?' and enjoy the silence. Ours is a command:\n\n$ interlinked harness checks\n360 checks · 235 inline · 33 tool-based · 25 structural · 23 trajectory · 11 behavioral · 5 spec-ledger\n\nDerived live from the registries, pinned by tests — add a check without updating the count and the build goes red. A number you can't audit is a slogan."

### 25. Real tools, not vibes — 33 wrapped verifiers `[on]`
- Problem: LLM code review is confident and unverified.
- Fix: 33 checks shell out to the actual toolchain — tsc, biome, eslint, oxlint, mypy, ruff, cargo check/clippy, rustfmt, go build, golangci-lint, clang-tidy, semgrep, gitleaks (800+ secret patterns), dependency audit, shellcheck, actionlint, hadolint, knip, swiftlint… — and report the tool's own verdict.
- Benefit: when the harness says your types are broken, it's because the compiler said so.
- Post: "After every agent edit, our harness asks the professionals. tsc for the types. Clippy for the Rust. Semgrep for the injection shapes. Gitleaks — 800+ patterns — for the secrets. 33 wrapped verifiers, each relaying the tool's own verdict, not a model's impression of one. Of the 865 verified interventions in our 38-day log, 574 were type errors caught at the keystroke. The compiler was right there. We just made it fast enough to consult every time."

### 26. Every finding is tagged [proven] or [heuristic] `[on]`
- Problem: agents over-trust speculative bug reports and "fix" false positives — making the code worse.
- Fix: every warning carries a determinism tag: `[proven]` = a compiler/scanner/parser actually ran your code; `[heuristic]` = a pattern matched and deserves judgment. Unknown checks get no tag rather than a guessed one.
- Benefit: calibrated trust — the agent (and you) know which findings are evidence and which are hypotheses.
- Post: "Failure mode nobody talks about: an agent gets a speculative lint warning, believes it completely, and 'fixes' a false positive — making the code worse. So every finding we emit is labeled with its epistemics: [proven] means a compiler or scanner ran your actual code; [heuristic] means a pattern matched and deserves judgment. Unknown checks get no tag rather than a guessed one. Calibration is a feature."

### 27. The NaN fail-open guard `[on]`
- Problem: `if (Date.parse(expires_at) <= now) revoke()` — a malformed date makes NaN, every comparison with NaN is false, and the expired credential lives forever. Compiles clean. Lints clean.
- Fix: `nan_coercion_guard` flags any `Date.parse`/`Number`/`parseInt`/`parseFloat` result flowing into a `< > <= >=` comparison with no `isFinite`/`isNaN` guard. (Found and fixed 2 real instances in our own sponsor-types module the week it landed.)
- Benefit: a whole fail-open bug class caught at the keystroke.
- Post: "The week we shipped our NaN guard, it found two live bugs — in our own repo. The shape: `if (Date.parse(expires_at) <= now) revoke()`. Feed that a malformed date and Date.parse returns NaN. Every comparison with NaN is false. So the expiry check never fires and the credential lives forever. No exception, no log line, no lint warning — a security check that fails open, silently, for years. Now the pattern can't land: any parse result compared without an isFinite guard gets flagged at the keystroke."

### 28. The 1000× timer bug `[on]`
- Problem: a seconds-named variable (`delaySeconds`, `timeoutSec`) passed straight into `setTimeout` fires 1000× too early. Retries hammer APIs; debounces vanish.
- Fix: `unit_mismatch` detects seconds-named identifiers in millisecond argument positions (and ms-named vars multiplied by 1000 at the call site). Zero-FP bias: only the direct argument position counts.
- Benefit: a one-token bug with production-sized consequences, caught by shape.
- Post: "`setTimeout(retry, delaySeconds)`\n\nReads fine. Type-checks fine. Fires 1000× too early — delaySeconds is 30, setTimeout wants milliseconds, so your 'gentle retry every 30 seconds' is now 33 requests per second against your own API. A one-token bug with an incident-report-sized blast radius. Our check matches the exact shape — seconds-named identifier, milliseconds-typed slot — and nothing else. (`delaySeconds * 1000` passes clean.)"

### 29. The cache that can never hit `[on]`
- Problem: `map.get({...})` or a fresh `new Date()` as a Map key — object identity means the lookup is a *guaranteed* miss. The cache "works," metrics say 0% hit rate, nobody knows why.
- Fix: `fresh-collection-key-lookup` flags fresh objects/spreads/Symbols/NaN used as Map/Set keys (gated to files that actually construct one).
- Benefit: silent-performance-lie bugs surface at edit time.
- Post: "Postmortem you may have lived: the cache hit rate is 0%, there are no errors anywhere, and the recompute bill keeps climbing. Root cause, three weeks later: `map.get({...})`. Fresh object literal → fresh identity → guaranteed miss, every single call, forever. JavaScript will never complain. Our detector flags fresh objects, spreads, Dates, and NaN used as Map/Set keys the moment they're typed — three weeks earlier than the postmortem."

### 30. Agents that downgrade your versions `[on]`
- Problem: a model with a training cutoff "corrects" your deps *backwards* — `node:22` → `node:18`, current model IDs → deprecated ones — confidently, silently.
- Fix: `software_version_regression` blocks edits that move any software identifier backward: package versions, Docker tags, GitHub Action versions, model IDs, API dates.
- Benefit: your project's timeline can't be quietly rewound to the model's memory.
- Post: "There's a new bug class that only AI agents commit: the confident downgrade. The model's training data ends somewhere in the past, so when it 'fixes' your Dockerfile, node:22 becomes node:18 — the version it remembers being current. Same move on package versions, GitHub Actions, model IDs, API dates. Not sabotage; nostalgia. We block any edit that moves a version identifier backward in time."

### 31. The snapshot cheat `[on]`
- Problem: an agent that can't make a snapshot test pass writes the `.snap.new` *review* file instead. The suite looks green; the assertion never ran.
- Fix: `snapshot_hygiene` blocks writes to `*.snap.new` / `*.pending-snap` review artifacts — filename-exact, zero-FP.
- Benefit: one specific, sneaky test-gaming move is simply off the table.
- Post: "Sneakiest agent cheat we've had to engineer against: the snapshot test won't pass, so instead of fixing the code, the agent writes its output into `something.snap.new` — the *review* file the test runner ignores — and reports success. Suite's green. The assertion never ran. The countermeasure is satisfyingly boring: a filename-exact, zero-false-positive block on writes to `*.snap.new` and `*.pending-snap`. Some doors you just brick shut."

### 32. Injection & taint — the trifecta checks `[on]`
- Problem: prompt-injection exfiltration is a *sequence*: read a secret, then make a network call. No single-file scan can see it.
- Fix: 23 trajectory detectors watch action patterns across the session — secret-read-then-network-call, download-then-execute, env-modification-then-bash, the lethal-trifecta structure — plus taint tracking from `req.body`/`process.env` into `eval`/`exec`/`fs.write` sinks with no validator between.
- Benefit: the attack *chains* get caught, not just the artifacts.
- Post: "Every step of a prompt-injection exfil is individually innocent. Reading .env? Normal. Curling an API? Normal. But read-the-secret *then* call-the-network, in the turns right after ingesting an untrusted GitHub issue — that's the lethal trifecta, and no single-file scanner can see it, because no single file contains it. 23 of our detectors don't read files at all. They read the sequence."

### 33. Tests that don't test anything `[on]`
- Problem: agents produce green suites that assert nothing — mock-only tests, timeouts inflated to pass, assertions deleted or value-swapped to match broken output.
- Fix: a family of test-integrity checks: `introverted_test` (assertions never touch the system under test), `test_timeout_inflation` (timeout literal raised to buy wall-clock), `assertion_count_regression` (test file loses `expect()`s while source changed), `assertion_value_swap` (`toBe(5)` → `toBe(6)` right after a failure).
- Benefit: "the tests pass" starts meaning something again.
- Post: "A test fails. The agent, helpfully:\n· raises the timeout until the flake squeaks through\n· or deletes the assertion while 'refactoring'\n· or edits toBe(5) to toBe(6) to match the broken output\n· or writes a test so introverted its assertions never touch the code under test\nWe ship a named detector for each of these moves. 'The tests pass' should be a fact about your code, not about your agent's creativity."

### 34. Cross-file breakage radar — 25 structural checks `[on]`*
- Problem: single-file lint can't see that your rename orphaned 14 importers, or that the import the agent just wrote doesn't exist.
- Fix: dependency-graph checks tiered by cost (<100ms to <1s): export-surface breaks, unresolved/hallucinated imports, duplicate symbols, import cycles, blast-radius ("this file has N importers — care"), test proximity, layer violations.
- Benefit: the "it compiled on my file" class of multi-file breakage surfaces immediately. (*master switch ships conservative — confirm config before claiming the full set runs out of the box.)
- Post: "The agent's file compiled perfectly. The fourteen files importing the symbol it just renamed did not — and single-file linting is structurally incapable of noticing. After each edit we consult the project's real dependency graph: exports that vanished out from under importers, imports of symbols that don't exist (agents hallucinate those), fresh circular chains, and a blast-radius note when the file you're touching has a crowd downstream."

### 35. Ranked, capped, never a firehose `[on]`
- Problem: 100 findings per edit trains the agent (and you) to ignore all of them.
- Fix: deterministic findings (compiler/linter) always show; heuristic findings are scored (severity × file relevance × edit proximity) and only the top 3 above threshold surface. Every suppressed-by-ranking finding still logs to telemetry for later measurement.
- Benefit: signal density stays high enough that warnings retain authority.
- Post: "The fastest way to train an agent to ignore your review gate is to print 100 warnings per edit. Our budget: deterministic findings — compiler, scanner — always speak. Heuristics compete for three slots, scored by severity × file relevance × distance from the lines you just touched. Everything below the line logs silently for later scoring. Authority is a resource. Spend it like one."

### 36. Checks that demote themselves `[on]`
- Problem: every static-analysis tool accretes noisy checks nobody trusts — and keeping them default-on erodes faith in the whole system.
- Fix: a Tricorder-style probation loop watches the recurrence log for checks that keep re-firing on the same findings without ever getting fixed (≥5 average re-fires across ≥5 distinct findings) and flags them as probation candidates; `harness checks` shows the count.
- Benefit: the check *catalog* is subject to the same accountability as the code.
- Post: "Our static-analysis checks can be put on trial. The evidence: the recurrence log shows a check re-firing on the same findings, ≥5 times each across ≥5 distinct findings, and nobody ever fixes them — the fingerprint of a false-positive machine, or a check nobody believes. Verdict: flagged for probation, surfaced right in `harness checks`. Google's Tricorder team learned this years ago — if developers ignore a check, the check is the bug. Few tools ever shipped the courtroom."

### 37. 12 languages, one feedback loop `[on]`
- Problem: most agent-quality tooling is TypeScript-only; your agent also writes Python, Rust, Go, and the occasional shader.
- Fix: 12 language profiles wire the right compilers, linters, and inline footgun checks per file extension — bare `except`, `.unwrap()` in libraries, unsafe blocks, force casts, ignored errors — including CUDA/OpenCL/Metal/HLSL/WGSL.
- Benefit: the guard speaks the dialect of whatever file the agent touched. (Depth varies; TS/Python/Rust are richest.)
- Post: "Your agent writes TypeScript at 2pm, Python at 3, and a CUDA kernel at 4. Guardrails that only read TypeScript clock out at 2:59. Ours switches dialects with the file: the bare `except:` swallowing errors in Python, the `.unwrap()` waiting to panic in library Rust, the force cast in Swift, the unsafe block — 12 language profiles, from web stack to shader languages, one feedback loop."

---

## Pillar 5 — Ratchets & anti-gaming (quality only moves one direction)

The deepest moat story: not just checks, but *monotonic* quality — and defenses against the
agent gaming its own gates.

### 38. The 500-line file cap `[on]`
- Problem: agents (and humans) pile everything into one mega-file until nobody — human or model — can safely edit it.
- Fix: hand-written code modules cap at 500 lines, enforced as a pure before/after delta at write time: growing past the cap blocks; shrinking or holding an over-cap file is always allowed (the refactor-down path). Tests, generated code, and docs are exempt; a committed grandfather list records legacy offenders at their high-water mark.
- Benefit: decomposition becomes the path of least resistance.
- Post: "Our file-size cap has a direction, not just a number. Growing a code file past 500 lines: blocked. Shrinking a 900-line offender to 850: always allowed — the refactor-down path never gets punished. Legacy files live on a committed grandfather list pinned at their high-water mark, allowed to shrink but never grow. We ratcheted our own cap down over months by paying down our worst files first. Absolute gates punish history. Delta gates change behavior."

### 39. The complexity gate with no escape hatch `[on]`
- Problem: one more `if` per edit is how a function becomes unmaintainable — and any suppression comment would just get written by the same agent it's meant to stop.
- Fix: per-function cyclomatic complexity is AST-measured before/after each edit (TS AST; radon for Python). Hard cap 25; a sub-cap function may rise at most +2 branches per edit. There is deliberately NO override — the only way past the gate is to decompose.
- Benefit: in our measured corpus, every time the best model hit this gate it decomposed and produced the better design — 3/3 true positives.
- Post: "We refused to give our complexity gate a suppression comment, and the reasoning is one sentence: any escape hatch an agent can type, an agent will type. Cap of 25 branches per function, AST-measured, max +2 per edit; the only way through is decomposing the function. In our measured frontier-model corpus the gate fired 3 times — and all 3 times the model's forced refactor was the better design. The wall was load-bearing."

### 40. Per-edit coverage with a debt ledger `[on]`
- Problem: agents ship new logic with no test exercising it, then claim done.
- Fix: before a code write lands, affected tests run over an overlay of the proposed content (25s budget). Adding an uncovered line or dropping file coverage opens a *debt* (default) or blocks (strict): the edit lands, the debt is tracked, and wandering off to unrelated files while owing blocks. Too-big suites defer enforcement to the commit gate. Can't-measure fails open, loudly.
- Benefit: TDD pressure calibrated to flow — honest about what it measured either way.
- Post: "Before an agent's edit lands, we run the affected tests against the *proposed* content — a 25-second budget, real coverage, not a guess. New uncovered line? A debt opens. Keep working the same area: fine. Wander off to an unrelated file with the debt still open: blocked. Suite too big for the budget? It says 'deferred to commit gate' out loud. The gate is honest in both directions — it never fakes a pass, and it never pretends it measured what it didn't."

### 41. The CRAP gate `[on]`
- Problem: a complex function that's technically "covered enough" to pass a flat coverage bar is still where your outages live.
- Fix: CRAP = cyclomatic² × (1 − coverage)³ + cyclomatic, computed for edit-touched functions from the same overlay run. At/over 30 → the edit blocks. A 10-branch function scores 110 untested, 10 fully tested.
- Benefit: testing pressure lands exactly on the branchiest code, where it pays most.
- Post: "Best-named metric in software: CRAP — Change Risk Anti-Patterns. The formula: cyclomatic² × (1−coverage)³ + cyclomatic. Watch it work: a 10-branch function scores 110 with no tests… and 10 with full coverage. The complexity is forgiven exactly as fast as you test it. We compute CRAP for every function an edit touches — same test run the coverage gate already paid for — and block at 30. Complex AND untested is the one combination that never ships."

### 42. The gate that guards the gates `[on]`
- Problem: every ratchet reads a baseline file the agent can write. Lowering the bar is the canonical gate-gaming move — it defeats every ratchet at once.
- Fix: the baseline-integrity gate blocks any hand edit that *loosens* a water-line across 8 baseline kinds (coverage, mutation, line cap, untested-file exemptions, metric caps, skipped tests, accepted mutation survivors…). Direction is per-file: floors may only rise, caps only tighten, exemption lists only shrink. The harness's own legitimate raises go through internal writes that never touch the gate. A commit-time backstop re-diffs HEAD vs staged for the git-tracked baselines.
- Benefit: the ratchet system is closed under adversarial pressure from its own subject.
- Post: "Think like an agent that can't pass the coverage gate. The gate reads coverage-baseline.json. You have a Write tool. One tiny edit to the baseline and every ratchet in the repo folds at once. It's such an obvious speedrun that we built the counter before the speedrun: baselines are direction-locked — floors may only rise, caps only tighten, exemption lists only shrink — and a commit-time backstop re-diffs the staged file against HEAD for the sneaky paths. The gate that guards the gates."

### 43. Suppression is visible, deferral is honest `[on]`
- Problem: `@ts-ignore` and friends are how quality dies quietly — but sometimes a deliberate exception is legitimate.
- Fix: suppressions require justification text (unjustified ones get a loud, line-numbered warning); suppression-count *growth* per file is ratcheted — including our own `interlinked-ignore` directive, which counts against the same ratchet. A separate `interlinked: defer` grammar acknowledges a finding while keeping it visible.
- Benefit: escape hatches exist, cost something, and leave a trail.
- Post: "Our own escape hatch testifies against itself. `// interlinked-ignore` — the directive that silences one of our findings — is counted by the same suppression ratchet that counts @ts-ignore and eslint-disable. Add one to a file and the growth is flagged like any other suppression. Silencing a finding is allowed; silencing it invisibly is not. And for 'yes, I know, deliberately': `interlinked: defer` acknowledges a finding while keeping it on the books."

### 44. Fix-what-you-touch, not fix-the-world `[on]`
- Problem: strict gates have a failure mode: one legacy violation makes a 1,100-line file un-editable forever, so people turn the gate off.
- Fix: blocking checks are *introduced-only* — proposed content is compared to the on-disk baseline (multiset over normalized lines); only violations this edit adds can block. Pre-existing ones surface as warnings. Meanwhile ratchets ensure the counts you inherit can't grow.
- Benefit: strictness that scales to real, imperfect codebases without rage-quit.
- Post: "We once watched a single legacy finding at line 49 make an entire ~1,100-line file un-editable — every future edit, by every future agent, blocked for a sin committed months earlier. That wall taught us introduced-only semantics: your edit is diffed against the file's existing baseline, and only violations YOU add can block. Old sins warn. New sins block. And the ratchets make sure the inherited counts can only go down. Meet the codebase where it is; never let it get worse."

### 45. The mutation endgame `[off]`/`[designed]`
- Problem: coverage proves your tests *ran*, not that they'd *fail* when the code is wrong.
- Fix (shipping state): a per-edit mutation gate exists behind config (25s budget, ChangeSet overlays, stable mutant identity, survivor baselines protected by the integrity gate) and honestly reports `[mutation:not-measured]` until the cloud runner is wired. A coarser per-file mutation-score ratchet works today off a Stryker report.
- Benefit: roadmap credibility — the substrate is built and the honesty contract ("never a forged pass") is already enforced.
- Post: "Coverage proves your tests ran. Mutation proves they'd have *noticed* if the code were wrong — flip a branch, break an operator, and a good suite goes red. We've built mutation testing into the per-edit gate: same 25s budget, stable mutant identity, survivor baselines locked by the anti-gaming gate. The cloud runner isn't wired yet, so today it prints `[mutation:not-measured]` — because the one thing a testing gate must never do is sell you a green it didn't earn."

---

## Pillar 6 — Session intelligence (the harness watches trajectories, not just keystrokes)

### 46. Trajectory state that survives restarts `[on]`
- Problem: per-call filters have no memory; agent failure modes are *patterns* — and a daemon restart shouldn't amnesia the session.
- Fix: per-session state tracks tool sequences, files read/written, commands, errors, TDD cycles, verification signals, stubs introduced, taint sources… serialized to disk and rehydrated on restart; subagent signals roll up to the parent so delegated test-running counts.
- Benefit: gates and nudges reason over the whole session, and a restart doesn't reset the story.
- Post: "By hour three of a session, our daemon knows things no single-call filter can: which files got read before being edited, which checks came back red and stayed red, whether the tests the agent claims to have run ever actually ran, what debt is still open. That ledger is serialized to disk — restart the daemon and it picks the story back up — and subagent work rolls up to the parent, so delegating the testing still counts as testing. Gates that judge trajectories need memories."

### 47. The "you didn't verify" stop-check `[on]`
- Problem: agents claim done on code that was never type-checked, run, or tested.
- Fix: at session Stop, if ≥5 code files changed and the verify-to-edit ratio ran an order of magnitude below the measured best-model floor (~0.5–1.0 verifier runs per edit), a nudge fires. Companions: UI edited but never loaded in a browser; TODO/stub markers introduced and left.
- Benefit: the "done" bar rises to include evidence — calibrated from real frontier-model behavior, not vibes.
- Post: "We measured frontier models doing their best work on this repo: 0.5 to 1.0 verification runs per edit — they check constantly when they're right. So our end-of-session nudge only fires when a session runs an order of magnitude below that floor: five-plus code files changed and essentially nothing ever type-checked, tested, or run. The message isn't 'be perfect.' It's 'you're 10× under how the best behave when they're actually done.'"

### 48. Commit cadence with escalating tone — and "Don't push" `[on]`
- Problem: sessions end as one giant uncommitted blob; agents push when nobody asked.
- Fix: uncommitted-code-file count triggers Stop nudges (threshold 5; mid-session backstop at 40), with wording that escalates by session token burn; a companion flags `wip`/`fixup` commit subjects before they reach a PR. Every nudge ends: Don't push — that's the user's call.
- Benefit: reviewable commit hygiene without surrendering push authority to the agent.
- Post: "A session ends. Nine files changed, zero commits — one giant blob of unbundled work. Our Stop nudge fires at five uncommitted code files: bundle by concern, write real messages; the tone escalates the longer the session ran. A companion check flags the `wip`/`fixup` commit subjects before they reach a PR. And every one of these nudges ends with the same two words: 'Don't push.' The commit is the agent's job. The trigger is yours."

### 49. Ambient complexity telemetry `[on]`
- Problem: metrics live in dashboards nobody opens; drift is invisible until a gate slams.
- Fix: after every edit to a governed file, one line reports its cyclomatic profile — ΣCC, delta, worst function — reusing parses the gate already paid for (near-zero marginal cost). Observation only; never blocks.
- Benefit: the agent sees complexity trending *before* the cap does the talking.
- Post: "After each edit, one quiet line in the agent's feedback: `[cyclomatic] ΣCC 34→38 · max fn 12`. It costs nothing — the write gate already parsed the AST, we just kept the numbers — and blocks nothing. But by the time a hard cap would slam, the drift has been visible for ten edits, and agents course-correct off mirrors before they hit walls. Ambient beats enforcement to the punch."

### 50. Recurrence: same-mistake memory `[on]`
- Problem: the same class of agent mistake recurs across sessions with zero institutional memory.
- Fix: every harness catch appends to an append-only recurrence log; deterministic aggregation (no LLM-as-judge) ranks repeating signatures across sessions/files/agents, and `recurrence propose` maps each to a next step: ratchet it, scaffold a rule, or open a cleanup PR. A scanner replays the same detectors over the whole tree to find pre-existing instances.
- Benefit: one-off catches compound into policy.
- Post: "Every block and warning our harness fires appends one line to a local JSONL. `interlinked recurrence list` folds that log into a ranked table — this signature, this many times, across this many sessions and agents — pure counting, no LLM deciding what's a pattern. Then `recurrence propose` names the response: ratchet it, scaffold a rule, or open a cleanup PR. One-off catches are nice. Catches that compound into policy are a moat."

### 51. Per-file error history `[on]`
- Problem: some files are repeat offenders, and every new session re-learns that the hard way.
- Fix: check failures persist per-file across sessions; when an agent returns to a file with a record, it gets the rap sheet — total failures, top 3 recurring checks, what may still be unresolved.
- Benefit: cross-session memory at exactly the moment it changes behavior: right before the edit.
- Post: "Some files are repeat offenders — everyone on the team knows it, and no tool does. Ours keeps the record: when an agent opens a file with history, it gets the rap sheet first — 'this file failed type-safety checks 3× across recent sessions, 2 possibly unresolved.' Cross-session memory, delivered at the one moment it changes behavior: right before the next edit. Files have reputations now."

### 52. Subagent results, captured `[on]`
- Problem: background subagents deliver their answer over a channel that fires no hook — the parent's reasoning inputs vanish from the record.
- Fix: SubagentStop capture persists the final message (scrubbed, bounded) and drains the agent's transcript into the timeline, attributed by agent id — with a delayed re-drain covering the runner's late flush.
- Benefit: multi-agent sessions leave a complete, greppable record — no invisible advisors.
- Post: "We found a hole in our own observability: a background subagent's final answer is delivered over a queue that fires no hook. The advice that shaped the code never touched the record — an invisible advisor. Now SubagentStop tail-reads the agent's transcript (bounded, secret-scrubbed), files it into the session timeline under that agent's id, and re-drains 750ms later because we measured the runner flushing late. If it influenced the code, it's on the record."

---

## Pillar 7 — Multi-agent coordination

### 53. Automatic file reservations `[on]`
- Problem: two agents edit one file; last write wins; work silently vanishes.
- Fix: file writes auto-reserve (5-min TTL, 30s idle auto-release) with optimistic local grant + async server confirm that *rolls back* on rejection and emits a conflict event. All state changes flow through one transition function — live state and event-log replay cannot diverge, verified with fast-check property tests.
- Benefit: the double-allocation bug class is engineered out, not warned about.
- Post: "Two agents open the same file. Both edit. Last write wins; the other agent's work simply ceases to exist, and nobody is told. Our answer: every file an agent touches takes an automatic 5-minute lease (released after 30s idle), conflicts roll back with a recorded reason, and the whole state machine runs through one transition function that's property-tested with fast-check — replay equals live, double-grant provably impossible. Our 38-day log: 17 reservation conflicts caught. That's 17 silent losses that weren't."

### 54. Cohort discipline for shared git state `[on]`
- Problem: one agent runs `git stash` or `rebase` and yanks the working tree out from under every other agent in it.
- Fix: with ≥2 active agents in a worktree, shared-git-state ops (stash, rebase, branch switch) block; dormant when solo; parent↔subagent lineage exempt.
- Benefit: parallel agents stop destroying each other's uncommitted work.
- Post: "Multi-agent horror story in three commands: agents A, B, C share a worktree; A finishes first and tidily runs `git stash` — which stashes the *entire tree*, vaporizing B's and C's uncommitted work mid-thought. Our cohort rules exist for exactly this: with 2+ active agents in a worktree, stash, rebase, and branch-switch are blocked. Solo? The rules go dormant and stay out of your way. Guardrails should know how many hands are on the wheel."

### 55. Reservation-aware git hooks `[opt-in]`
- Problem: coordination that only exists inside one tool fails at the git boundary.
- Fix: `interlinked guard install` adds pre-commit (optionally pre-push) hooks that check staged files against active reservations, warn or block mode.
- Benefit: the same locks agents honor are enforced where humans commit.
- Post: "The agents were honoring the file locks beautifully. Then a human ran `git commit` over one. Coordination that lives inside a single tool dies at the git boundary — so `interlinked guard install` puts the same reservation check into pre-commit (and pre-push if you want it), in warn or block mode. One lock table, honored by agents and enforced on humans."

### 56. One policy for the whole fleet `[on]`
- Problem: five agent runtimes, five hook formats, five chances for policy drift.
- Fix: the same rule corpus, checks, and ratchets evaluate identically for Claude Code, Cursor, Copilot CLI, Gemini CLI, and Codex CLI — hooks installed per-client by one command, policy shared via version control.
- Benefit: "which agent did it" stops mattering; the floor is the floor.
- Post: "Your Claude Code hooks are dialed in. Your teammate uses Cursor. Another swears by Copilot CLI. Congratulations: your policy now has three dialects and two blind spots. We enforce one committed policy identically across five runtimes — Claude Code, Cursor, Copilot, Gemini, Codex — same 119 rules, same ratchets, same local logs. Swap the agent; the floor doesn't move."

---

## Pillar 8 — Platform & pipeline (hooks, capture, config, speed)

### 57. Five runtimes, one command `[on]`
- Problem: each agent CLI has its own hook format and location; wiring them by hand is error-prone and drifts.
- Fix: `interlinked enable` detects installed clients and wires Claude Code (13 hook events), Cursor (15), Gemini CLI (8), Copilot CLI (6), and Codex CLI (6) into one normalized event stream. Installers are idempotent (re-running never stacks duplicates); a nested-checkout check walks to the git root and skips installs that would double-fire under an ancestor's hooks.
- Benefit: zero-to-guardrails across the whole agent zoo in one command.
- Post: "Five agent CLIs, five hook config formats, five places to get it subtly wrong. `interlinked enable` finds whatever's installed — Claude Code (13 hook events), Cursor (15), Copilot (6), Gemini (8), Codex (6) — and wires the same guard into each. Run it twice? Idempotent; nothing stacks. Nested repo under a parent that's already hooked? It detects the ancestor and declines, because double-firing hooks is its own bug class. The agent zoo gets one keeper."

### 58. The Codex silent-failure fix `[on]`
- Problem: Codex requires a `[features] hooks = true` flag in its config or it *silently ignores* your hooks file — users "install" hooks that never fire.
- Fix: the Codex installer flips the flag itself (inserting into an existing `[features]` block or appending one) and auto-migrates the deprecated legacy key.
- Benefit: a whole class of "why is nothing being captured" support tickets never happens.
- Post: "Sharpest edge we've sanded down: you write a perfectly valid hooks.json for Codex, and… nothing. No error, no warning, no events — because Codex silently ignores hooks unless `[features] hooks = true` is set in config.toml. A user could debug that for a day. Our installer just sets the flag itself (and migrates the deprecated key it replaced). Half of good DX is fixing the failure your users could never have diagnosed."

### 59. A hook that outlives its installer `[on]`
- Problem: hooks that import the CLI package break the moment the package is moved, updated, or uninstalled.
- Fix: the generated hook script is a self-contained `.mjs` with no third-party deps and no imports from the CLI package (Node built-ins only), with a version sentinel baked in for staleness detection.
- Benefit: capture and inline guards keep working standalone, whatever happens to the package.
- Post: "Test we hold our hook script to: uninstall the CLI that generated it, and it must keep working. No imports from the package, no third-party code — Node built-ins only, with the fail-closed guards baked into the file itself and a version sentinel so staleness is detectable. When you attach something to a person's editor, it doesn't get to have dependencies."

### 60. Local-first capture, offline-complete `[on]`
- Problem: cloud-dependent capture loses data offline and double-counts when stores overlap.
- Fix: every event appends synchronously to a local append-only JSONL (designed sub-millisecond) before anything else happens; reads merge stores with identity-based dedup (`tool_use_id`-keyed, so parallel same-millisecond tool calls don't collapse).
- Benefit: the activity record is complete on a plane, and it's a file you can grep.
- Post: "First thing that happens on every agent event: one line appended to a local JSONL on your disk. Before any socket, before any network, before anything that can fail. Offline isn't our degraded mode; it's the primary path. And dedup is keyed on tool-call identity, not timestamps — we learned that one when two parallel agents fired in the same millisecond and a timestamp-keyed merge quietly collapsed them into one event."

### 61. The agent never waits on a network `[on]`
- Problem: observability that adds seconds of network latency to every tool call gets uninstalled by Friday.
- Fix: the pipeline is ordered local-write-first; guard verdicts come from a warm local daemon over a Unix socket; server POSTs are fire-and-forget with a 500ms budget and bounded retries. Heavy post-edit checks run under explicit mode budgets (30/50/60s ceilings matched to each runner's hook limits).
- Benefit: full capture and enforcement with no perceptible drag on the agent loop.
- Post: "Ordering rule the whole pipeline obeys: nothing network-shaped may ever stand between the agent and its next action. Local JSONL append first. Guard verdict from a warm local daemon over a Unix socket. Server sync fire-and-forget with a 500ms budget and bounded retries — if it fails, it retries later; the agent never knows. Observability that adds lag gets uninstalled by Friday. Ours has no lag to notice."

### 62. Byte-offset sync cursor (and the 3GB lesson) `[on]`
- Problem: naive sync re-sends everything, loses data on partial failure — and one real workspace's unrotated sync-error log once grew to 3GB.
- Fix: sync tracks an exact byte offset into the activity log; the cursor advances only when a push fully succeeds (at-least-once, never-drop). The error log now rotates at 10MB.
- Benefit: resumable, dedup-safe sync with bounded local footprint.
- Post: "Confession: we once grew a 3-gigabyte error log. A sync kept failing, every failure logged faithfully, nothing ever rotated. That workspace is why sync errors now rotate at 10MB — and why the sync cursor is an exact byte offset into the activity log that only advances when a push *fully* succeeds. Kill the process mid-sync: nothing lost, nothing double-sent. At-least-once, never-drop. Scars make the best invariants."

### 63. Bring-your-own-server, honestly `[opt-in]`
- Problem: "syncs to the cloud!" usually means "your data is on our servers now."
- Fix: the full sync/coordination client is built — batched pushes with retry and egress secret-scrubbing, workspaces, OAuth — but no hosted server ships and none is required. Point it at your own deployment or run purely local forever.
- Benefit: the network tier is optional infrastructure you control, not a dependency you inherit.
- Post: "The cloud half of our CLI is fully built: batched sync with retry, workspaces, OAuth, secrets scrubbed at the egress boundary. And we ship exactly zero servers to talk to. That's the point — 'sync' targets a server YOU deploy, or nothing at all, forever. Every agent event your machine records is yours by construction, not by privacy policy."

### 64. Two-tier config with a security boundary `[on]`
- Problem: one config file means either committing tokens or gitignoring team policy.
- Fix: committed `config.json` holds shared, non-secret settings; gitignored `config.local.json` holds tokens, identity, and the multi-server map (named servers, one active). `INTERLINKED_*` env vars override everything for CI.
- Benefit: teams share policy through version control; secrets stay local by construction.
- Post: "Everyone's config story ends the same way: someone commits the token. Ours can't — the committed config file has no field to put a token in. Secrets, identity, and server credentials live only in the gitignored local tier; CI overrides both via env vars. The leak isn't caught by a scanner; it's ruled out by the schema. Structure beats vigilance."

### 65. Auth that reuses what you already have `[opt-in]`
- Problem: yet another login for a tool that talks to a server you already authenticated with elsewhere.
- Fix: token resolution tries the CLI's own store first, then transparently falls back to your existing Claude Code credentials (matched by server prefix, expiry-checked). Fresh logins use full OAuth PKCE with dynamic client registration and CSRF protection; localhost dev servers skip auth entirely.
- Benefit: zero-friction auth in the common case, standards-grade auth when needed.
- Post: "You already logged into this server once, through Claude Code. Why would our CLI make you do it again? Token resolution checks our own store, then falls back to your existing Claude Code credential — matched by server prefix, expiry-checked, refreshed if stale. And when a fresh login is genuinely needed, it's the real thing: OAuth PKCE, dynamic client registration, CSRF state check. The best login flow is the one that already happened."

### 66. The warm daemon `[on]`
- Problem: running a full policy evaluator inline in every hook process would be brutally slow.
- Fix: a per-repo background daemon holds rules, graphs, and session state warm behind a Unix socket (`node:net`, event-driven, no idle CPU; memory stabilizes around ~30MB per our source annotations). An anti-stomp guard refuses to start a second daemon over a live socket; per-runner mode presets (budget/quality/ci) match each client's hook-timeout ceiling.
- Benefit: millisecond verdicts from an always-ready evaluator that respects your RAM.
- Post: "Why our guard verdicts take milliseconds: they're never computed cold. A per-repo daemon holds the 119 rules, the dependency graph, and the session ledger warm behind a Unix socket — event-driven, zero idle CPU, ~30MB resident. The hook doesn't evaluate anything; it asks a process that already knows. (And an anti-stomp guard refuses to boot a second daemon over a live socket, because two referees is worse than one.)"

### 67. Daemons that hand over to newer builds `[on]`
- Problem: long-lived daemons across many repos keep serving stale builds after you upgrade.
- Fix: each built daemon stats its own dist artifact every 60s and, when a newer settled build appears during a quiet window, restarts itself onto it (throttled, with an env escape hatch). Verified propagating a new build to 3 guarded repos within ~70 seconds.
- Benefit: fleet-wide freshness with no manual restarts.
- Post: "Bug we caught in our own fleet: rebuild the CLI in repo A, and repos B and C keep running week-old guard daemons — stale rules, stale checks, nobody notices. Now every daemon stats its own build once a minute, and when a newer one settles, it waits for a quiet window and restarts itself onto it. We watched one rebuild propagate to 3 guarded repos in ~70 seconds, no human involved. Long-lived daemons need a succession plan."

### 68. Trigram-accelerated search, never-worse by design `[opt-in]`
- Problem: full-repo grep on a huge monorepo is slow, and an agent's own fresh edits need to be searchable instantly.
- Fix: an opt-in trigram index answers queries in ~10–50µs (measured), narrowing ripgrep to candidate files; it intercepts both the Grep tool and Bash rg/grep (subagents included) via block-and-answer, and a dirty layer makes the agent's own writes searchable immediately. It only substitutes when the index is provably fresh and the repo is big enough to profit — on any uncertainty it declines and runs native rg.
- Benefit: monorepo-scale search speedups with a hard "never miss a match" guarantee.
- Post: "Our grep accelerator has one prime directive: never be worse than grep. The trigram index answers in ~10–50 microseconds and hands ripgrep a short candidate list — but the moment anything is uncertain (index stale? repo small? weird output flags?) it steps aside and runs native rg untouched. A dirty layer even indexes the agent's uncommitted edits, so code written 4 seconds ago is already searchable. Fast paths you can't fully trust aren't fast paths."

### 69. …and we don't run it on our own repo `[internal]`
- Problem: features get left on because they demo well, not because they pay rent.
- Fix: on our own 612-file repo, native ripgrep full-scans in ~18ms — so we deliberately don't build the index locally, saving ~139MB of daemon memory. The accelerator is engineered to engage at monorepo scale (≥25K files), not everywhere.
- Benefit: credibility — the performance feature has an honest activation threshold instead of a permanent tax.
- Post: "We built a search accelerator, measured it honestly, and turned it off in our own repo. The math: at 612 files, native ripgrep already answers in ~18ms; keeping the index resident would spend ~139MB of daemon RAM to shave milliseconds nobody feels. So it doesn't even engage below 25K files — monorepo scale, where it actually earns rent. Features should pay for their memory or give it back."

### 70. Scratchpad governance: the /tmp problem `[on]`
- Problem: temp paths are the one surface outside repo protections — the classic staging ground for credential exfil, and where agent-authored probe scripts go to escape review and vanish.
- Fix: any write carrying secret material to a temp path is blocked unconditionally (no escape hatch); agent-authored *code* aimed at the session scratchpad is redirected to a governed in-repo `scratch/` — gitignored but lint/type/security-gated and search-visible (`interlinked scratch init` provisions it). Bash targets resolve through `VAR=` assignments and `cd` hops.
- Benefit: the ungoverned surface gets governed without banning legitimate temp use.
- Post: "/tmp is where guardrails go to die. It sits outside every repo protection, invisible to code search, purged on reboot — which makes it both the classic staging path for credential exfil and the place agent-written scripts escape review. Our split: secrets to any temp path — blocked, no escape hatch, ever. Agent-authored *code* aimed at the scratchpad — steered into a governed scratch/ dir: gitignored, but still lint-gated, secret-scanned, and greppable. Temp files are fine. Ungoverned surfaces aren't."

### 71. The session lab notebook, archived `[on]`
- Problem: the OS purges the session scratchpad — probe scripts, analysis outputs, the "lab notebook" of how a change got made — on reboot.
- Fix: at session end, the scratchpad is archived into the repo's tool-state dir as content-addressed blobs plus a per-session manifest (bounded: 1MiB/file, 24MiB/session, exclusions recorded — no silent truncation).
- Benefit: the work *around* the work survives, attributable per session.
- Post: "An agent session leaves two artifacts: the diff, and the lab notebook — the probe scripts, the scratch analyses, the little experiments that explain *why* the diff looks like it does. The OS shreds the notebook on reboot. We archive it at session end: content-addressed blobs, a per-session manifest, bounded at 24MB with every excluded file listed — no silent truncation. Six months later, the notebook is often worth more than the diff."

### 72. Sponsor slots: fail-closed by construction `[off]`
- Problem: a statusline that renders remote bytes is a terminal-injection and unwanted-ads risk.
- Fix: the opt-in sponsor row renders only Ed25519-signature-verified feeds; unsigned/tampered/expired ⇒ nothing renders. Control bytes are stripped, URLs are https-only, text is capped at 80 chars, the code path is exception-proofed so it can't crash the daemon, and nothing activates until explicit `interlinked sponsor enable`.
- Benefit: a funding mechanism that meets the same security bar as the guardrails.
- Post: "We wanted a way to fund the tool without accounts or payments, so we added an optional sponsor line to the statusline — and then treated our own feature as hostile input. The feed renders only if its Ed25519 signature verifies; tampered, expired, or unsigned means nothing renders at all. Control bytes stripped (terminal injection is real), https-only, 80-character cap, exception-proofed so it can't take the daemon down, and stone dead until you run `sponsor enable`. If your monetization can't pass your own security review, it's malware with a business model."

---

## Pillar 9 — Observability & DX (the daily-driver stuff)

### 73. `interlinked status` — the one-screen answer `[on]`
- Problem: "is capture working? is anything unsynced? what did the agents just do?" is usually three tools.
- Fix: one dashboard — sessions, recent activity, sync state, optional server health behind a 3s timeout — plus a Guidance section that prescribes exact fix commands for detected problems. `--watch` refreshes live; `--json` for scripts.
- Benefit: system state at a glance, offline-first, script-friendly.
- Post: "Four questions you ask a capture system daily: is it alive, what just happened, what's unsynced, is the server up. `interlinked status` answers all four in one screen — and when something's off, the Guidance section doesn't describe the problem, it prints the command that fixes it. ('Activity attributed to unknown agent → regenerate hooks with: …') Dashboards diagnose. Good ones prescribe."

### 74. `interlinked logs -f` — tail -f for agent activity `[on]`
- Problem: agent activity is invisible or trapped in a vendor dashboard.
- Fix: a purely-local, color-coded live tail of the append-only activity log — filter by agent, tool, event type, time window; `--raw` for JSONL.
- Benefit: your agents' behavior is a local file you can grep, tail, and pipe — no server, no daemon required.
- Post: "Everything your AI agents do deserves the dignity of tail -f. `interlinked logs -f`: a live, color-coded stream of every tool call, prompt, and error — filter by agent, tool, or time; --raw when you want to pipe the JSONL somewhere. No server. No daemon, even. It's your file, on your disk, and it works on a plane."

### 75. `interlinked doctor --fix` `[on]`
- Problem: capture silently stopped days ago; a legacy config or stale hook broke something invisibly.
- Fix: a battery of local+server diagnostics — including data-collection *liveness* — with pass/warn/fail output, non-zero exit on failure, and `--fix` auto-repairing known classes (config migration, malformed permission rules, stale hooks).
- Benefit: "it silently stopped working" becomes a failed check with a one-command cure.
- Post: "The worst observability failure isn't loud — it's the quiet one. Hooks installed, everything looks fine, and capture actually died three days ago. `interlinked doctor` treats capture *liveness* as a first-class diagnostic — is data actually flowing, right now? — and `--fix` repairs the known breakage classes itself: legacy config migrated, malformed permission rules stripped, stale hooks regenerated. Exits non-zero on failure, so CI can watch the watcher."

### 76. Dry-run by default for destructive commands `[on]`
- Problem: cleanup tools that act first and explain later.
- Fix: `clean`, `recurrence scan`, `structure init`, `harness reap`, `enable` — all preview by default and require `--force`/`--record`/`--write` to act, printing "would remove …" line by line.
- Benefit: you always see the plan before anything is deleted.
- Post: "House rule across the CLI: anything that deletes shows its work first. `interlinked clean` prints 'would remove…' line by line until you add --force. `recurrence scan` reads until you add --record. `harness reap` lists the orphans before killing any. A tool whose whole job is making agents ask permission should probably ask permission."

### 77. Four output modes on one command surface `[on]`
- Problem: humans want tables; agents and scripts want stable JSON; most CLIs pick one.
- Fix: `--json` / `--short` / `--full` / normal across the command surface via one shared dispatcher (JSON output suppresses decorative text).
- Benefit: the same CLI is a human dashboard and a machine API.
- Post: "Every interlinked view speaks four dialects: a table for you, a one-liner for the statusline, a deep-dive for debugging, and --json for scripts and agents. One shared dispatcher with an exhaustiveness check — add a fifth mode and it's a compile error until every command handles it. Porcelain and plumbing, one binary."

### 78. Respectful terminal citizenship `[on]`
- Problem: ANSI escape codes polluting CI logs and piped output.
- Fix: color auto-disables under `NO_COLOR`, `CI`, or non-TTY stdout; tables compute widths with escape-stripping so colored cells still align; truncation preserves styling.
- Benefit: clean logs everywhere without configuration.
- Post: "Niche craft flex: our table renderer strips ANSI escape codes before computing column widths, so colored cells align to the character — and truncation mid-cell preserves the styling reset so nothing bleeds. All of it vanishes under NO_COLOR, CI, or a pipe. Zero formatting libraries; every escape code is ours. Terminals notice who respects them."

### 79. First-run wizard that also works headless `[on]`
- Problem: onboarding docs that fork into "interactive" and "CI" paths.
- Fix: bare `interlinked` with no config runs a TTY wizard (Enter-to-accept defaults) or, in a pipe/CI, a silent bootstrap from `INTERLINKED_*` env vars. Once configured, bare `interlinked` shows the dashboard plus a context-aware quick-start (suggests only the commands your state actually needs).
- Benefit: one onboarding story for laptops and pipelines.
- Post: "Type `interlinked` with no arguments. In a terminal: a setup wizard, Enter-to-accept the defaults. In CI: it notices there's no TTY and silently bootstraps from env vars instead. Already configured: the status dashboard, plus a quick-start that only suggests commands your actual state needs — it won't pitch `login` if you're on localhost. The zero-argument path is the most-used feature you'll ever ship; design it like one."

### 80. Checkpoints and rewind `[on]`
- Problem: agent work you want to unwind without hand-managed stashes.
- Fix: git-backed session checkpoints — list/show/compare/prune/archive — with `resume` (continue with context) and `rewind` (restore tree state).
- Benefit: agent sessions get save points.
- Post: "Before the agent attempts the ambitious refactor: checkpoint. Git-backed — list them, compare two, prune old ones. If it goes sideways, `rewind` restores the tree; if it goes well and you step away, `resume` picks the thread back up with context. Agents explore more boldly when undo is guaranteed. So do you."

### 81. The orphan-daemon reaper `[on]`
- Problem: long-lived background daemons leak across sessions; one production machine accumulated 28 stale daemons over 4 days (~1.8GB RSS).
- Fix: `harness start` reaps orphans before binding; `harness status` counts them; `reap --force` cleans on demand; `restart` escalates SIGTERM→SIGKILL when wedged.
- Benefit: the infrastructure cleans up after itself — the failure story became the feature.
- Post: "Real machine, real week: 28 orphaned guard daemons piled up over 4 days — ~1.8GB of RSS doing absolutely nothing. That incident is now a comment in our source and a feature in the CLI: `harness start` reaps orphans before binding, `status` reports the survivor count, `reap --force` cleans on demand, and a wedged daemon gets SIGTERM then SIGKILL. If you ship a daemon, ship the janitor."

### 82. Progressive disclosure: viz, completions, env, context `[on]`/`[opt-in]`
- Problem: power features that either overwhelm the front door or don't exist.
- Fix: a loopback web dashboard (`viz serve`) rendering the codebase as a live cell graph; shell completions for bash/zsh/fish; `env` documenting every supported variable with current values; `context` showing the effective merged config and which file each value came from.
- Benefit: depth for those who want it, invisible to those who don't.
- Post: "Hidden gem in the CLI: `interlinked viz serve` renders your codebase as a living cell graph — modules as cells, test and quality state as their health — served loopback-only on localhost. No cloud, no account, just a browser tab. Some code health you compute. Some you recognize on sight."

---

## Pillar 10 — The spec-audit loop (reviews as state, not prose)

### 83. Findings become records, not vibes `[opt-in]`
- Problem: a 5-hour frontier-model audit of a large design doc returns… prose. Nothing verifies the revision actually addressed each finding, and the revision pass mints fresh drift for the next audit.
- Fix: `interlinked findings ingest report.md` parses a numbered review into content-hashed, provenance-merged records; edits touching a finding's cited span mark it `touched`; `findings ack --reason` records deliberate non-action; `findings status` shows the ledger.
- Benefit: external review output becomes a closable checklist with an audit trail.
- Post: "We used to run 5-hour frontier-model audits over a 334KB design doc and get back… prose. Beautiful, damning prose — roughly 70 findings — with no way to verify the revision actually addressed each one. Now: `findings ingest report.md` turns every numbered finding into a content-hashed record. Edit its cited lines and it flips to 'touched.' Disagree? `ack --reason`, on the record. `findings status` shows what's still open. We stopped reading reviews and started closing them."

### 84. Spec drift caught at edit time `[on]`
- Problem: big specs rot in tiny ways — a count claim goes stale, an anchor dangles, a table stops summing — and each audit re-finds the same clerical classes hours later.
- Fix: a spec-fact ledger extracts ID namespaces, count/range claims, anchors, and path refs from prose; 8 registered checks (dangling anchors, numbering gaps, count-claim drift, table sums, stage ordering…) fire per edit, cross-file.
- Benefit: the deterministic share of "audit findings" moves left from hours to milliseconds.
- Post: "How a big spec rots: the intro says 'seven invariants' and the list below has grown to eight. A cross-reference points at a section that got renamed. A table's totals row quietly stopped summing. Every multi-hour audit re-finds these same clerical classes. Our harness extracts the claims themselves — counts, ranges, IDs, anchors — into a ledger and re-verifies them on every edit, across files. What an auditor finds at hour five, the editor now sees at second zero."

### 85. The adversarial review loop with honest exit codes `[internal]`
- Problem: looped AI reviews converge to "0 findings" for the wrong reason — a rate-limited reviewer looks identical to a clean report.
- Fix: our review loop auto-ingests each round's findings and reserves distinct exit codes for rate-limited (111) and incomplete (112) runs so a throttle can never masquerade as convergence. Twenty-plus review rounds are committed to the repo as a corpus.
- Benefit: process credibility — this system was built under its own adversarial review.
- Post: "Subtle trap in looped AI review: round 12 comes back 'TOTAL: 0 findings' — converged! …or the reviewer hit a rate limit and returned early, and silence is indistinguishable from success. Our loop refuses the ambiguity: exit 111 means throttled, 112 means incomplete, and only a clean run gets to claim zero. We ran 20+ adversarial rounds on our own system this way, findings auto-ingested each round. Convergence you can't distinguish from failure is neither."

---

## Pillar 11 — /enforce (your CLAUDE.md, but enforceable)

### 86. Prose imperatives → typed rules with receipts `[opt-in]`
- Problem: AGENTS.md/CLAUDE.md are hopeful prose the model may or may not follow.
- Fix: `/enforce` distills instruction markdown into deterministic guard rules via a binding lexical ladder ("never/MUST NOT" → block, "should not" → ask, "should" → advisory, hedged → skipped). Every rule carries the verbatim source quote + file/lines; a quote that isn't actually in the source is dropped as hallucination. Rules hot-load in ~2s across all five runtimes.
- Benefit: the rules you wrote down become rules that execute — with provenance.
- Post: "Your CLAUDE.md says 'NEVER commit directly to main.' The model reads that as a mood. /enforce reads it as source code: 'never' compiles to a block rule, 'should not' to an ask, 'we usually prefer' gets skipped as a hedge — and every generated rule carries the verbatim quote and line number it came from. If the quote isn't actually in your doc, the rule is discarded as hallucination. Two seconds after you save the file, it's enforced across all five runtimes."

### 87. Honest tiering: what's enforceable and what isn't `[opt-in]`/`[designed]`
- Problem: "we enforce your policies" claims usually paper over the 70–90% of imperatives that are semantic, not lexical.
- Fix: /enforce publishes its own coverage honestly (~5–35% of imperatives distill to deterministic Tier-1 rules, by doc type) and emits structured artifacts for the designed Tier-2 (LLM policy gate) and Tier-3 (async deep review) — including Cedar policies compatible with an external policy engine out of the box.
- Benefit: a credible, staged enforcement story instead of an overclaim.
- Post: "We measured our own policy compiler and published the uncomfortable number: only ~5–35% of the imperatives in real agent-instruction docs are deterministically enforceable — the rest are semantic ('keep changes minimal') that no regex will ever hold. Worked example in the repo: 11 imperatives in, 4 deterministic rules out, 5 routed to the LLM tier, 2 merged, and every skip documented. Distrust any policy product that claims 100%. The honest split IS the product."

---

## Pillar 12 — Build-in-public credibility (process posts)

### 88. The receipts `[on]`
- Problem: every guardrail vendor claims catches; few show data.
- Fix: 38 days of dogfooding on the author's machine: 1,081 logged interventions, 865 surviving an audit pass (299 dedup-collapsed, 174 residual unverified — published too). Breakdown: 574 type-error catches, 90 TDD-gate, 65 shell-redirect bypass attempts, 42 repo-confinement, 32 empty-catch, 25 process-kill, 17 reservation conflicts, 13 destructive-git, 4 secrets, 3 supply-chain.
- Benefit: falsifiable numbers with the messy parts left in.
- Post: "38 days of running our guard layer against our own AI agents, fully logged: 1,081 interventions, of which 865 survived an audit pass (we publish the dedup collapse and the 174 residuals too). Inside the 865: 574 type errors caught at the keystroke. 65 attempts to sneak writes past review via shell redirects. 25 process kills. 13 destructive git commands. 4 secrets stopped at the door. 3 unapproved package installs. One developer's machine — but every number is auditable. Agents don't have bad intent. They have bad afternoons."

### 89. Docs that fail CI when they lie `[on]`
- Problem: every README's numbers rot ("119 rules" survives three refactors as fiction).
- Fix: numeric claims in README/CLAUDE.md/landing are wrapped in gen-markers; a script recomputes each value from source and CI fails on drift; reference docs are generated from the registries and pinned by freshness tests.
- Benefit: marketing numbers with a build step.
- Post: "Here's how '119 built-in rules' stays true in our README: it isn't copy. It's a marker — <!-- gen:builtin_rule_count -->119<!-- /gen --> — recomputed from the actual rule registry on every CI run. Refactor changes the count? The build goes red until the docs tell the truth again. Docs rot because nothing fails when they lie. So we made something fail."

### 90. Calibrated against measured frontier-model behavior `[internal]`
- Problem: harness thresholds are usually guesses, and strict gates risk punishing good behavior.
- Fix: we extracted a behavioral corpus from 17 frontier-model sessions on this repo (4,063 records): Edit:Write ≈ 6:1, ~0.5–1.0 verify runs per edit, ~6× more thinking than speaking — and set nudge floors an order of magnitude *below* the measured floor. Every complexity-gate hit in the corpus was a true positive the model itself chose to refactor.
- Benefit: thresholds grounded in how the best models actually behave when they're right.
- Post: "Before tuning our gates, we instrumented 17 frontier-model sessions on this repo — 4,063 records of tool calls, messages, and reasoning — and measured what 'good' actually looks like: ~6 surgical edits for every full-file rewrite, 0.5–1.0 verification runs per edit, roughly 6× more thinking than talking. Our nudge thresholds sit 10× below those floors, so they only fire on genuine outliers. And every time the complexity gate hit the best model, the forced refactor came out better — 3 for 3. Small corpus, one repo, calibration-grade — and we label it that way."

### 91. Published false-positive rates, self-demoted checks `[on]`
- Problem: static-analysis vendors bury their noise floor.
- Fix: the advisory-demotion policy is a committed file where every demoted check carries a written rationale with real dogfood FP counts (e.g. a duplicate-test-name check that hit 187 mostly-benign times on our own repo) — pinned by a regression test so policy changes show up in diffs.
- Benefit: radical honesty as a feature — the noise floor is documented, versioned, and reviewable.
- Post: "There's a file in our repo listing every check we've demoted from the default gate for being too noisy — each with a written rationale and the real false-positive count from our own codebase that condemned it. One duplicate-test-name check fired 187 mostly-benign times before we pulled it. The list is pinned by a regression test, so softening the gate is always a visible PR, never a quiet config change. Every static-analysis tool has this list. Ours is just committed."

### 92. No autofix, on principle `[on]`
- Problem: auto-fixing review tools rewrite code in flight — and quietly become unaccountable co-authors.
- Fix: the harness never writes a fix. It blocks, warns, and presents evidence + obligations; the coding agent must author every correction itself. (Deterministic-only in the hot path is the sibling principle: no LLM-as-judge in any per-edit decision.)
- Benefit: a clean authorship and accountability story — one author, one reviewer, never blended.
- Post: "In 38 days and 1,081 interventions, our harness has written exactly zero lines of code. That's the design: it blocks, it warns, it presents evidence — and the agent must author every correction itself. The moment your safety layer starts editing code, you have two authors and no accountability for either. Sibling principle: no LLM verdicts anywhere in the hot path. Deterministic, or silent."

### 93. External ideas go through intake, not paste-and-ask `[internal]`
- Problem: "can we use X?" usually means pasting a repo link into a chat and vibing.
- Fix: a committed intake rubric (6 lanes, determinism filter, smallest-spike, which surface ships it) — 52 evaluated tools/papers committed as one-page verdicts, including the rejections and the "read the load-bearing function, not the README" failure mode.
- Benefit: an engineering-culture artifact that doubles as content — every intake page is a potential post.
- Post: "Every 'hey, could we use X?' in this project gets the same treatment: one committed page. What the tool actually does — we read the load-bearing function, because READMEs are marketing. Whether it survives our determinism filter. The smallest spike that would prove it. Whether it's worth a dependency (a find that adds a runtime dep starts from behind). 52 pages so far, rejections included. The corpus is the artifact."

---

## Pillar 13 — Roadmap teasers (post as "building next," never as shipped)

### 94. Tier-2 LLM policy gate `[designed]`
- The semantic 70–90% of your policy docs, evaluated by a fast cloud judge on most tool calls (~3–6s), with the deterministic layer as pre-filter.
- Post: "Next tier on the roadmap: the imperatives no regex can hold — 'prefer X over Y unless Z' — evaluated by a fast LLM policy judge sitting BEHIND the deterministic layer, seeing only the calls the rules couldn't decide. The design doc is public, including the cost model. Deterministic-first isn't a phase we grow out of; it's the architecture."

### 95. Tier-3 async deep review `[designed]`
- Staged-commit architectural review against prose principles, pre-push, warn-only by contract.
- Post: "Also designed, not yet built: pre-push deep review that reads your staged commits against the prose principles nothing else can enforce — 'minimize blast radius,' 'don't widen the public API.' Async, advisory, warn-only by contract. The layering is the point: taste at review speed, determinism at edit speed, and never confusion about which one you're getting."

### 96. Graph-prediction protocol `[opt-in, shadow]`
- Agents predict a file's dependency graph before editing; reveal/reconcile scores the prediction; currently shipping in shadow mode.
- Post: "Experiment currently running in shadow mode: before an agent edits a file, it must *predict* the file's dependency graph — who imports it, what it exports, the blast radius — and then we reveal the real graph and score the delta. The hypothesis we're testing: an agent that can't predict a file's blast radius isn't ready to edit that file. Shadow data first; enforcement only if the data says so."

### 97. Structure companion invariants `[opt-in]`
- A typed artifact graph (7 extractors, 6 rule families) enforcing "every public symbol has a test/doc; every env key is documented; glossary terms leave residue in code," with a 0–1 adoption score per category. Dormant until a repo commits a `structure.json`.
- Post: "'Every public symbol has a test. Every env key is documented. Every glossary term actually appears in the code.' These are existence invariants — and no linter on earth checks existence. So we built a typed artifact graph that does: 7 extractors map your repo, 6 rule families check the companions, and each category gets an adoption score you ratchet from 0 toward 1. One committed structure.json turns it on."

(The per-edit cloud mutation runner is the fifth roadmap story — covered as card 45.)

---

## Appendix A — Thread blueprints & sequencing

**Launch thread (7 posts):** 1 (the thesis) → 2 (the demo GIF) → 88 (the receipts) → 27 or 30 (one visceral bug story) → 42 (the anti-gaming twist) → 14 (fail-closed) → CTA (repo/landing link).

**Weekly cadence suggestion:**
- Mon — a Pillar 1/2 "it blocked WHAT?" story (safety energy starts the week)
- Wed — a Pillar 4 "it caught WHAT?" detector story (engineering depth)
- Fri — a Pillar 12 process post (credibility compounds on quiet days)
- Ongoing — quote-tweet any viral agent-disaster story with the matching card's demo.

**Demo GIF shortlist:** `interlinked harness test "rm -rf /"` · `harness test "git push --force"` · a blocked `npm install` of an unapproved package · the statusline flipping red on daemon kill · `interlinked verify https://github.com/someone/repo` cold-auditing a repo.

**Story shapes in use across the drafts (rotate them; never let three in a row share a shape):**
1. Confession — a real incident from our own logs, then the invariant it produced (62, 81, 88).
2. Failure drill — "kill the daemon, now try rm -rf" (14, 15).
3. Bug autopsy — symptom → invisible cause → the check that sees it (27, 28, 29).
4. Think-like-the-attacker — walk the reader through the gaming move, then the counter (42, 31, 7).
5. Design confession — the counterintuitive choice and the one-sentence reason (39, 69, 92).
6. Receipts drop — verified numbers, minimal commentary (88, 24).

## Appendix B — Fix/verify before posting

1. **README hand-written "27 quality checks"** has drifted from the gen-markered 33 — it's the one un-markered count. Fix before pointing traffic at the README (it also slightly undercuts the card-89 "docs can't lie" post).
2. **Third-party incident references** (the PaaS volume-wipe story, the hijacked-package RAT story) live in rule reason-strings. Verify each against the public record before naming vendors/packages in posts; otherwise use the vendor-neutral phrasing in the draft cards.
3. **The e2e probe scripts and the review-loop script are not in the published tree** (`.interlinked/` is gitignored). Say "our verification runs," not "checked-in probes," unless you commit them first.
4. **Server-backed commands** (login/workspace/tasks/inbox/sync) need your own server — exclude from launch posts or mark "with a coordination server."
5. **Latency claims**: p50 1ms / p99 177ms are from a dated 10k-event verification run on the author's machine. "Milliseconds, no model in the loop" is always safe; the specific percentiles need the "our stress runs" framing.
6. **Structural checks master switch** ships conservative in the generated config reference — confirm the effective default before claiming the full 25 run out of the box.
7. **~20k tests** — keep approximate by policy; the repo explicitly forbids pinning the count.
8. **Stale internal docstrings** found during this sweep (harmless, but tidy before inviting source readers): the hook template's "PreToolUse is fast (500ms)" comment (actual constant 5000ms) and the generated `.mjs` header's "Claude Code (14 events)" (actual array: 13).

