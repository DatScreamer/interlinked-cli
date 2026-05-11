# FailproofAI

- **Source:** https://github.com/exospherehost/failproofai • https://docs.befailproof.ai
- **Encountered:** 2026-05-11, user prompt — direct competitor in the local-hook-guard space
- **Verdict:** PR (port the 5 Stop-hook workflow gates + repeated-tool-call detection) + memory note (treat as the reference competitor; their multi-CLI plumbing patterns are validated and worth mining)

## 1. Core idea (one sentence, your words)

A locally-installed Node CLI that hooks 7 agent runners (Claude Code, Codex, Copilot, Cursor, OpenCode, Pi, Gemini), evaluates each tool-call event against ~39 regex-based deterministic policies plus user-authored JS/TS policies, and returns allow / deny / **instruct** (allow-but-inject-context) per-event — same shape as our harness, slightly different surface.

## 2. Anatomy (concrete walkthrough)

**Directory map (only the load-bearing pieces):**
```
src/hooks/
  builtin-policies.ts     1975 lines — all 39 deterministic policies, regex constants hoisted at top
  policy-evaluator.ts      716 lines — per-CLI response shaping (deny/instruct/allow → 7 different stdout shapes)
  integrations.ts         1433 lines — per-CLI install/uninstall registry; INTEGRATIONS map keyed by CLI id
  install-prompt.ts        657 lines — TTY arrow-key multi-select for "which CLIs do you want hooks for"
  handler.ts               394 lines — stdin JSON → canonicalize event/tool/input → eval → write stdout/stderr
  custom-hooks-loader.ts   208 lines — convention discovery: .failproofai/policies/*policies.{js,mjs,ts}
  llm-client.ts             90 lines — utility for user-authored policies to call OpenAI-compatible APIs
                                       (NOT used by any builtin — fully optional)
  policy-helpers.ts         17 lines — allow() / deny() / instruct() decision constructors
.failproofai/
  policies-config.json     — enabledPolicies[] + per-policy params + customPoliciesPath
  policies/                — convention-discovered *policies.{js,mjs,ts} (dogfood: changelog/docs/PR/version reminders)
```

**Five load-bearing files in my words:**
1. `builtin-policies.ts` — one giant file of pure functions like `function blockRmRf(ctx) → PolicyResult`. Every regex is a hoisted module-level constant. The 39 policies fall into ~9 categories: Sanitize (5), Environment (3), Commands (10), Database (2), Packages & System (5), Git (4), AI Behavior (1 — the loop detector), Workflow (5), …
2. `policy-evaluator.ts` — runs the policies for a given event, then **branches per-CLI** to emit the right stdout shape. Cursor wants `{permission, user_message, agent_message}`; Pi wants flat `{permission, reason}`; Claude wants `{hookSpecificOutput: {permissionDecision}}`; Copilot wants `{decision: "block", reason}` for Stop because exit-2-from-Stop is logged as warning but doesn't retry. ~250 lines of these per-CLI branches.
3. `policy-helpers.ts` — three trivial constructors. `instruct(reason)` is the interesting one: `{decision: "instruct", reason}` flows through the evaluator and produces `additionalContext` injection on PreToolUse — the action proceeds but the agent sees the text on its next turn. This is **the third primitive** beyond allow/deny.
4. `custom-hooks-loader.ts` — convention discovery: it auto-loads any file matching `*policies.{js,mjs,ts}` from `.failproofai/policies/` (project scope) and `~/.failproofai/policies/` (user scope). Files import from `failproofai` and call `customPolicies.add({name, match: {events}, fn})`.
5. `install-prompt.ts` — `detectInstalledClis()` does a PATH probe for each agent binary (`claude`, `codex`, `copilot`, `cursor-agent`, `opencode`, `pi`, `gemini`); if multiple are present + TTY, opens an arrow-key multi-select to pick which to install hooks for.

**End-to-end session (Claude Code, dirty branch, tries to `/clear` to stop):**
1. Claude fires `Stop` hook → spawns `npx -y failproofai --hook Stop`
2. `handler.ts` reads JSON from stdin, canonicalizes event/tool/input per-CLI, loads merged config (project/local/global)
3. `evaluator` runs Stop-event policies — `require-commit-before-stop` shells out: `execSync("git status --porcelain")` → finds dirty files
4. Returns `deny("You have uncommitted changes…")` → evaluator emits `exitCode: 2, stderr: "MANDATORY ACTION REQUIRED…"`
5. Claude Code's hook protocol treats exit-2-from-Stop as "force the agent to keep going with this in its context"
6. Agent loops back, commits the changes, tries to stop again → policy now passes → hook returns `exitCode: 0`
7. Total time per hook: ~10–50 ms for builtin policies; sub-shell git calls cost the most

## 3. Deterministic or agentic?

**Fully deterministic** for all 39 built-ins. Verified by grepping the entire `src/` and `examples/` tree for `chatCompletion` / `llm-client` imports — only `llm-client.ts` itself shows up. No built-in policy and no example policy uses an LLM call. `llm-client.ts` is offered as a *utility for user-authored policies* and is essentially marketing positioning ("you could write LLM-judged policies if you wanted to") rather than a load-bearing piece. Marketing is honest here ("Zero latency. Runs locally.") — the README claim survives source-reading.

**License:** **MIT + Commons Clause.** Free for personal/internal use; the Commons Clause forbids selling a product/service whose value derives "entirely or substantially" from failproofai. **Blocks lane 5** (a paid product substantially derived from their code triggers the clause). **Lane 3 (code-borrow)** is fine for our open-source CLI because we're not "Selling the Software" — but if we copy whole files verbatim, attribute and keep the clause attached. Lane 4 (pattern reuse) is always free and the highest-yield route here.

## 4. Substrate vs. surface

- **Surface:** `npx failproofai policies --install` writes settings to all 7 CLI dotfile dirs, then `failproofai` (no args) launches a Next.js dashboard at `localhost:8020`. Same job as `interlinked enable` + `interlinked harness` + planned dashboard.
- **Substrate:** an event handler that takes `{eventType, payload, session, params}` and returns `{decision: allow|deny|instruct, reason}`. The 39 policies are independent regex-and-shell functions. **Each policy is borrowable in isolation** — copy `requireCommitBeforeStop`'s 20-line body into our harness as a Stop-event rule and it's done. No ML, no graph, no shared state besides a per-cwd branch cache.

## 5. Lane (1–6)

**Lane 2 (detection technique) + Lane 4 (pattern), with a sliver of Lane 1.**

- **Lane 2** — the 5 `require-*-before-stop` policies and `warn-repeated-tool-calls` are deterministic detectors we could land as harness rules with no new infrastructure beyond a Stop-event hook path. Direct PR candidates.
- **Lane 4** — `instruct` as a decision primitive, convention-based policy discovery (`*policies.{js,mjs,ts}` auto-loaded from a known dir), and the per-CLI response-shape branching pattern in `policy-evaluator.ts` (one evaluator → 7 stdout dialects) are architectural patterns worth memory'ing or RFC'ing depending on scope.
- **Lane 1** — their dogfooded `.failproofai/policies/workflow-policies.mjs` (changelog reminder on `git commit`, docs reminder on `git commit`, PR-description reminder on `git push`) is essentially imperative AGENTS.md content delivered as just-in-time deterministic `instruct()` calls. Same shape `/enforce` produces, different delivery channel.

## 6. Smallest spike (≤1 day)

**Port the 5 Stop-hook workflow gates as new harness rules.** Concretely:

1. Add a Stop event to our harness adapter dispatch (we already canonicalize event types — check whether Stop is currently a no-op or unrouted).
2. Port `requireCommitBeforeStop` (20 lines, `git status --porcelain`), `requirePushBeforeStop` (90 lines incl. squash-merge detection), `requirePrBeforeStop` (90 lines, uses `gh pr view`), `requireNoConflictsBeforeStop` (95 lines, layers local `git merge-tree --write-tree` + `gh pr view --json mergeable`), `requireCiGreenBeforeStop` (100 lines, `gh run list` + third-party check-runs API + commit-statuses API).
3. All five default-off; opt-in via config flag (analogous to our advisory-skip pattern in `verify.ts`).
4. Tests: integration tests with a temp git repo for each.

Half-day stretch goal: also port `warn-repeated-tool-calls` (the sidecar fingerprint counter, ~30 lines). Trivial and high-leverage — catches "agent is stuck in a loop calling the same tool with the same args 5× in a row," which is one of the documented failure modes we don't currently detect.

If the spike grows past 1 day, the right cut is: ship the 5 Stop gates and defer `instruct` + convention-discovery to a separate RFC, because both touch our rule-loader architecture rather than just adding new rule entries.

## 7. Artifact

- **PR #1** (spike output): Stop-event harness rules — the 5 workflow gates + repeated-tool-call detector.
- **Memory note** (this file): record failproofai as the reference competitor; note that its multi-CLI dispatch + per-CLI response shaping (especially Cursor `{followup_message}`-on-Stop and Copilot `{decision:"block"}`-on-Stop, both of which differ from our exit-2 default) are independently-derived solutions to the same problems we hit. Worth cross-referencing the next time we add a CLI adapter.
- **No RFC needed for the spike** — workflow gates fit cleanly into the existing rule taxonomy. RFC may follow if/when we adopt `instruct` as a third decision type or add JS-policy support.

## 8. Surface

`interlinked-cli` — all adoptable patterns live in the local harness layer; nothing routes to guardrails-cloud or agency-cloud.

## Notes

**What they have that we don't (ranked by adoption value):**

1. **Stop-event workflow gates** — `require-commit/push/pr/no-conflicts/ci-green-before-stop`. We have 105 PreToolUse guard rules but **no Stop-event rules at all**. This is the headline gap. Stop hooks turn the agent's natural "I'm done" moment into an opportunity to enforce process invariants. Our memory `project_supervisor_pattern.md` discusses detection/decision split but doesn't cover Stop-phase enforcement specifically.
2. **`instruct` decision** — third primitive beyond allow/deny that says "let this through but tell the agent X on its next turn." Maps to `additionalContext` on PreToolUse, `followup_message` on Stop. Our harness has `pre_warn` (stderr) and `post_warn` (PostToolUse `additionalContext`) but no PreToolUse `additionalContext` injection. Per `project_copilot_cursor_status.md`, Cursor preToolUse can't carry additionalContext, but Claude/Codex/Gemini can — so this would be a 3-of-5 CLI feature.
3. **`warn-repeated-tool-calls`** — sidecar JSON at `${transcriptPath}.tool-calls.json` tracking `JSON.stringify({tool, input})` → count, fires `instruct` at count ≥ 3. Fully deterministic loop detection. ~30 lines.
4. **Convention-based policy discovery** — drop `*policies.{js,mjs,ts}` into `.failproofai/policies/`, auto-loaded at project + user scope, no config edit. Our equivalent today is `.interlinked/guard-rules.json` (JSON-only). Auto-loading JS modules is a much bigger architectural change (sandboxing, dep resolution, ESM rewriting via `loader-utils.ts`) — file as an RFC, not a quick PR.
5. **OpenCode + Pi adapter coverage** — they support 7 CLIs to our 5 (we have Claude/Copilot/Cursor/Codex/Gemini per `project_copilot_cursor_status.md`'s capability matrix). OpenCode uses an in-process JS plugin model (no external hooks), so adding it requires a different pattern than our settings-file writes — they ship `.opencode/plugins/failproofai.mjs` that subprocess-calls the binary. Pi uses a direct settings-file write to `.pi/settings.json`. Both are niche enough today to defer unless a paying user asks.

**What we have that they don't** (kept short — this is intake, not competitive analysis):
- A real harness daemon (Unix socket, hot-reload, single-process state) — they re-exec `npx failproofai` per hook event.
- Trigram-indexed grep acceleration.
- 25 structural / dependency-aware checks (`structural-checks.ts`) — they have none of this; all their detectors are intra-command regex.
- Multi-project / multi-workspace coordination via reservations.
- Server-backed activity sync and the Interlinked MCP Server pairing.
- 11 sub-`checks/<family>.ts` files for code-quality analysis (taint tracking, complexity, magic numbers, async/await correctness, etc.) — they explicitly stop at the security/workflow boundary.

**Architectural mirror-points worth recording:**
- They re-derived the **per-CLI response shaping** pattern we use in `src/harness/adapters/*.ts`. Their `policy-evaluator.ts` lines 147–270 are an independent implementation of what our adapter dispatch does. Two of their Stop-event branches (Cursor `{followup_message}`, Copilot `{decision:"block"}`) match our adapter tests verbatim — useful corroboration when our memory says "this is how Cursor Stop is documented."
- They split their built-ins into 9 categories and `defaultEnabled: false` for ~30 of 39 (only the 9 most aggressive defaults are on by default). Our 105 guard rules default to all-on with `disabled_rules` overrides. Their model is more conservative; ours assumes opt-out.

**Cursor Cloud caveat to record** (from their CLAUDE.md, verified against Cursor forum): Cursor Cloud Agent VMs do NOT run `stop` / `subagentStop` / `afterAgentResponse` hooks. If we ever care about Cursor Cloud parity, the Stop-event workflow gates we're about to port won't fire in that environment. Local Cursor sessions: fine. Worth a memory entry if we go remote-agent-aware.

## Methodology notes

- README said "30 built-in policies." Source has 39 (counted by `grep -c 'name:' builtin-policies.ts`). Minor marketing under-statement — uncommon direction (usually they over-state).
- "Catches loops" in the README is `warn-repeated-tool-calls`, which is exact-fingerprint-counting, not semantic loop detection. Mild marketing-vs-reality flag but the implementation is honest and the technique works for the most common loop shape (identical retries).
- The presence of `llm-client.ts` at the top level of `src/hooks/` initially looked like a determinism red flag — turned out to be utility-only, no built-in or example uses it. Confirms the INTAKE.md rule: **always grep imports of the suspicious file across `src/` and `examples/` before classifying determinism**. One `grep -rn chatCompletion src/ examples/` settled it in this case.
