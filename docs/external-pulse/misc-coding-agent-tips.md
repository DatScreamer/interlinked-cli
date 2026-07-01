# misc_coding_agent_tips_and_scripts (Dicklesworthstone / Jeffrey Emanuel)

- **Source:** https://github.com/Dicklesworthstone/misc_coding_agent_tips_and_scripts
- **Encountered:** 2026-06-26, user-supplied ("clone and analyze thoroughly").
- **Verdict:** **mostly skip** (ops/swarm grab-bag + displacement). One PR-candidate (post-compaction re-anchor), one parked doctor-check idea (cross-client hook-protocol hygiene). **Code-borrow is license-blocked** (Anthropic rider) — but we need none of it.

## 1. Core idea (one sentence)
A personal "misc" repo of problem→fix→copy-paste-config writeups for running *large fleets of AI coding agents* (Claude Code / Codex / Gemini CLI) on a Mac + beefy-Linux setup — mostly terminal/remote/host infrastructure for an agent-swarm workflow, wrapped around a small core of deterministic agent-safety hooks, under a stated philosophy of "mechanical enforcement over trust/memory."

## 2. Anatomy (concrete walkthrough)

It's a grab-bag, so the load-bearing question is *which files touch a hooks-based guard/observe CLI at all*. Tagging the 30+ top-level entries:

- **[AGENT] — the bullseye (hooks/guard/observe):** `DESTRUCTIVE_GIT_COMMAND_CLAUDE_HOOKS_SETUP.md` + `install-claude-git-guard.sh`; `CLAUDE_CODE_POST_COMPACT_AGENTS_MD_REMINDER.md` + `install-post-compact-reminder.sh`.
- **[AGENT] — adjacent (agent-CLI maintenance/instruction, not hooks):** `FIX_CLAUDE_CODE_MCP_CONFIG.md`, `SETTING_UP_CLAUDE_CODE_NATIVE.md`, `mirror_cc_skills`, `fix-gemini-cli-ebadf-crash.sh`, `skills/reporting-sensitive-encrypted-gh-issues/SKILL.md`.
- **[SWARM] — agent-motivated host infra, no guard/observe surface:** `swap-flush` (+ installer), `WEZTERM_MUX_PERFORMANCE_TUNING_FOR_AGENT_SWARMS.md` (+ `wezterm-mux-tune.sh`).
- **[OPS] — out of scope (no agent specificity):** Ghostty/WezTerm/Zellij terminfo+themes, MX Master mouse, NFS automount, Vault HA, 10GbE link, Moonlight streaming, Vercel credits, DevOps-CLI guide, `gh-issue-decrypt` (age/X25519 encrypted-issues channel), `bettermouse_config.py`, `BEADS_SETUP.md`.
- **[META]:** README, LICENSE, CHANGELOG, images, and `cc_session_making_encrypted_gh_issues_system.html` — a ~900 KB exported Claude Code *session transcript* (19 prompts / ~400 tool calls) of building the encrypted-issues tool; a showcase artifact, not reusable code.

**Load-bearing file #1 — `git_safety_guard.py` (emitted by `install-claude-git-guard.sh`).** A self-contained Python3 stdlib (`json`/`re`/`sys`) **PreToolUse** hook, `matcher: "Bash"`. End-to-end: Claude proposes a `Bash` command → hook reads the tool envelope on stdin → normalizes a leading absolute path (`/usr/bin/git` → `git`) → checks a `SAFE_PATTERNS` allowlist first (`checkout -b`, `--orphan`, `restore --staged`, `clean -n`, `rm -rf` under `/tmp`/`$TMPDIR`) → else `re.search` over ~16 `DESTRUCTIVE_PATTERNS` → on match emits `{permissionDecision:"deny", permissionDecisionReason:"BLOCKED … Use 'git stash' first"}`. Covers `git checkout --`/`checkout <ref> -- <path>`, `restore`/`restore --worktree`, `reset --hard`/`--merge`, `clean -*f`, `push --force`/`-f` (with `--force-with-lease` carve-out), `branch -D`, `stash drop`/`clear`, and `rm -rf` (combined/separate/long-flag, two-tier severity for `/`/`~`). Pure regex, zero LLM; self-described as "a safety net for honest mistakes, **not a security boundary**."

**Load-bearing file #2 — the post-compact reminder hook (emitted by `install-post-compact-reminder.sh`, ~15 real lines under a 1,680-line ornamental installer).** A **SessionStart** hook, `matcher: "compact"`, double-gated by an in-script re-check: `SOURCE=$(jq -r '.source') ; if [[ "$SOURCE" == "compact" ]]; then cat <<'EOF' … <post-compact-reminder>Context was just compacted. Please reread AGENTS.md…</post-compact-reminder> … EOF; fi`. It injects **only a pointer** (not the file content — defers the token cost to Claude's own `Read`) via raw hook stdout. Deterministic bash+jq; no state, no throttle, fires on every compaction.

## 3. Deterministic or agentic?
**Fully deterministic across the entire repo** — regex/string/crypto/CLI plumbing, no LLM call anywhere (verified in source by independent readers, not from the prose). So it clears interlinked's determinism filter for CLI placement. **License (load-bearing):** `LICENSE` is **"MIT License (with OpenAI/Anthropic Rider)", © 2026 Jeffrey Emanuel.** The rider defines "Restricted Parties" = OpenAI, **Anthropic PBC**, their Affiliates, *and anyone acting directly or indirectly on their behalf or under their direction*; grants them **no rights**; and defines prohibited "use" to explicitly include "**benchmarking, testing, analyzing, indexing, or incorporating … into any … evaluation harness, or pipeline for machine learning.**" This more-restrictive-than-MIT custom term **blocks code-borrow (lanes 3/5)** outright. Patterns/concepts are still observable, but any reimplementation must be independently derived; copying even the regex list is off the table.

## 3b. Role in its native architecture — and does it transfer?
- **Git-guard:** native role is an honest-mistake *safety net* (the author disclaims "security boundary"). That role transfers 1:1 — interlinked's destructive-command guards are likewise deterministic ask/warn nudges, **not** its trust boundary (security is cloud-anchored, per `[[feedback_local_checks_not_a_trust_boundary]]`). No safe-at-home/unsafe-here shift.
- **Post-compact reminder:** native role is a non-blocking *context-hygiene convenience* (stdout nudge). Transfers cleanly as a SessionStart `additionalContext` nudge — same role, no blocking, no sandbox dependency.

## 4. Substrate vs. surface
- Git-guard: substrate = the destructive-pattern list + deny-envelope; surface = the CC PreToolUse hook. interlinked already owns both an equivalent pattern set and the envelope, so there is no substrate to borrow (and the license forbids it anyway).
- Post-compact: substrate = "detect compaction → emit a deterministic re-anchor"; surface = a bash+jq SessionStart hook. interlinked would reimplement the substrate natively inside `handleSessionStart` against its own artifacts — no surface to lift.

## 5. Lane (1–6)
Predominantly **Lane 6 (skip)** for the repo as a whole. The two genuinely transferable ideas are **Lane 2 (detection/behavior technique → harness/doctor)**: (a) the post-compaction re-anchor as a SessionStart behavior, and (b) a cross-client "dead/wrong-protocol hook" doctor scan. Nothing is Lane 3 (no importable substrate; license-blocked) and nothing is Lane 5 (no inference, no cloud).

## 6. Dependency & displacement
- **Deps:** the adoptable ideas add **no runtime dependency** — both are native edits (a `handleSessionStart` branch; a `doctor` scan), not imports. The originals are bash/jq/python3, which we would not pull in.
- **Displacement:** the git-guard overlaps interlinked's built-in destructive-command rules near-completely; the post-compact hook overlaps interlinked's (recognized-but-unhandled) `PreCompact`/`SessionStart` path; `mirror_cc_skills`/installer concerns overlap `CLIENT_INSTALL_REGISTRY`.
- **Equivalence (capability-by-capability):**

| External capability | interlinked equivalent | Status |
|---|---|---|
| `git checkout -- ` / `checkout .` block | `builtin-git-discard-file`, `builtin-git-checkout-dot` | shipped |
| `git restore` / `restore --worktree` block | `builtin-git-restore-dot`, `builtin-git-restore-worktree` | shipped |
| `git reset --hard` | `builtin-git-reset-hard` | shipped |
| `git reset --merge` | — | **absent** (micro-gap) |
| `git clean -*f` | `builtin-git-clean-f` | shipped |
| `git push --force` (+ `--force-with-lease` carve-out) | `builtin-git-force-push` (same carve-out) | shipped |
| `git branch -D` | `builtin-git-branch-D` (`-D/-M/-f`) | shipped (superset) |
| `git stash drop`/`clear` | `builtin-git-stash-drop-or-clear`, `builtin-git-stash-destroy` | shipped |
| `rm -rf /`/`~` (loud) | `builtin-rm-rf-root` | shipped |
| `rm -rf` (general) | `builtin-rm-requires-prior-inspection` | shipped |
| temp-dir escape hatch (`/tmp`, `$TMPDIR`) | scratchpad-confinement carve-out (`[[feedback_scratchpad_confinement_carveout]]`) | shipped (analogous) |
| abs-path normalization (`/usr/bin/git …`) | `\bgit\b` word-boundary regexes catch the same | shipped (equivalent effect) |
| installer self-test (pipe a known-bad cmd) | `command-guard-parity` + rule tests | shipped (analogous) |
| _(interlinked-only extras)_ `filter-branch`, `rebase -i`, `commit --amend`, `clone-into-tree`, `rm` lockfile/node_modules/wrangler, `add -i` | — | interlinked superset |
| **post-compaction guidance re-anchor** | `handleSessionStart` (cohort/index/perm-strip; **no `source==compact` branch**) | **absent** ← the gap |
| cross-client dead/wrong-protocol hook detection | `doctor` + settings-permission validator (`[[project_settings_permission_validator]]`) | partial (no wrong-protocol scan) |
| multi-client hook/skill fan-out (claude/codex/gemini) | `CLIENT_INSTALL_REGISTRY` (`hook-installers.ts`) | shipped (for hooks) |
| guard verdict = reason + dry-run + fail-closed config validation | guard reasons + `caps`/metric-caps validation + `--dry-run` patterns | shipped |
| git-synced append-only JSONL store (beads) | `activity.jsonl` / `collection.jsonl` | shipped (note the beads worktree-collision gotcha if we ever git-sync ours) |

The dominant verdict is the most useful one per the rubric: **we already ship this** — the destructive-git-guard is a thing *not to rebuild*; analyzing it mainly validates interlinked's own coverage and surfaces one micro-gap (`git reset --merge`).

## 7. Smallest spike (≤1 day)
**Post-compaction re-anchor**, native: in `handleSessionStart`, add an `event.source === "compact"` branch that returns a `HarnessDecision` carrying `additionalContext` — a *deterministic* re-anchor that (a) points at `CLAUDE.md`/`AGENTS.md` and (b) inlines a compact summary of the active `distilled-rules.json` (count by strength + the top block-level rules). Throttle to once/session (the original has no dedup). The elegant interlinked twist: the **daemon persists across compaction and already "remembers" everything** — the nudge only re-anchors the *model* to what the daemon holds, and re-anchoring against already-parsed distilled rules beats "go re-read a file." Tests: `source==compact` fires; `startup`/`resume`/`clear` don't; no distilled-rules → graceful pointer-only. All substrate exists (SessionStart handler, `additionalContext` emission, `distilled-rules.json`), so this is a genuine ≤1-day add. *(Secondary spike — the doctor check below — is a separate ≤1-day item.)*

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Post-compaction `SessionStart{source:compact}` re-anchor against CLAUDE.md + distilled-rules | §7 | next |
| Free CLI (P1) | `doctor`/harness check: scan each agent CLI's `settings.json` for dead-binary or wrong-protocol hook entries (CC JSON protocol injected into Gemini's `BeforeTool` fires errors every tool call — `fix-gemini-cli-ebadf-crash.sh` Patch 3) | ~½ day extending the settings validator | parked |
| Free CLI (P1) | `git reset --merge` added to the reset rule | trivial | parked |

No Guardrails/Agent-CI rows — nothing here needs inference or central state.

## 9. Artifact
**Compound:**
- **PR-candidate:** the post-compaction re-anchor (§7) — small, on-philosophy (`[[feedback_reluctance_to_push]]`-style deterministic local nudge), no new dep. Build clean-room; do **not** consult the licensed hook code.
- **Memory note (parked):** cross-client hook-protocol-hygiene doctor check (the genuinely novel find — concrete evidence of the failure mode interlinked's multi-client installer lives in).
- **Trivial:** add `git reset --merge` to `builtin-git-reset-hard`'s pattern.
- **Skip:** the entire git-guard (displacement + license-blocked), all [SWARM] host infra, all [OPS], the encrypted-issues system, beads.
- **License caveat (must-document):** never copy patterns/code from this repo into the harness; the Anthropic rider forbids it and we don't need it.

## Notes
- **Meta-irony worth recording:** the author wrote a license expressly to keep Anthropic (and parties under its direction) from executing/testing/analyzing the code — and this intake was produced by an Anthropic agent at the (independent) user's direction. Practical posture: read-only / clean-room; copy nothing; rely on interlinked's independently-derived equivalents. The license costs us nothing because we already ship the only overlapping capability.
- **Origin story** (validates interlinked's whole thesis): the git-guard exists because an agent ran `git checkout -- <files>` and wiped hours of a *parallel* agent's uncommitted work (recovered via `git fsck --lost-found`). That is precisely the multi-agent / `git-session-scope-gate` hazard interlinked already guards — external confirmation the bug class is real and frequent.
- **Borrowable *design* shapes (not code), mostly already embodied:** swap-flush's "worth-it AND safe" multi-predicate gate (one human-readable `skip_reason`, single-line structured decision log, `DRY_RUN`, fail-closed numeric-config validation — the doc notes a European-locale `"1,5"` parsing to `0` would fail *open*) maps onto a clean guard verdict; interlinked's verdicts + `caps` validation already do this. `mirror_cc_skills` adds a hash+mtime "don't clobber locally-edited state; back up before destructive sync" conflict guard across the same claude/codex/gemini client surface interlinked installs into.
- **Bug-class seed:** `fix-gemini-cli-ebadf-crash.sh`'s headline defect — an error caught only by `err.code === 'ESRCH'` while the real signal (`EBADF`) lives only in `err.message` — is a tidy candidate for an error-handling check ("catch discriminates on `.code` but the distinguishing signal is in `.message`").

## Methodology notes (optional)
- A multi-item "misc repo" stretches the one-page-per-*project* template: §2 became an inventory + two file walk-throughs rather than one. That's the right adaptation — the unit of evaluation is the [AGENT] core, and the [OPS]/[SWARM]/[META] bulk earns one tagged line each, not a section.
- The single highest-value output for a mature-overlap find was the §6 equivalence table ("what NOT to rebuild"), exactly as the rubric predicts. The two non-obvious finds (post-compact gap; cross-client hook-protocol doctor check) surfaced only from reading the *installers'* emitted hooks and the Gemini patcher's Patch 3 — i.e. from "read the source, not the README."
