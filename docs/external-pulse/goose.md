# Goose

- **Source:** https://github.com/aaif-goose/goose • https://goose-docs.ai/docs/category/guides
- **Encountered:** 2026-04-29, surveying agent-side guardrail patterns; user pointed at the guides index
- **Verdict:** lane 2 spike (pattern lift) + lane 4 (pattern cluster — third detect/decide+fail-open affirmation) + lane 5 (adversary mode + recipe-scanner reinforce guardrails-cloud thesis). Apache-2.0, no license gate.

## 1. Core idea (one sentence, your words)

Goose is a Rust-based desktop+CLI+API AI agent framework with first-class MCP extension support that ships several guardrails most pure-CLI agents skip — permission modes, `.gooseignore`, an extension allowlist, a macOS sandbox + egress proxy, deterministic prompt-injection patterns, and an optional LLM "adversary" reviewer — making the **guardrail surface** (not the agent runner) the load-bearing read for us.

## 2. Anatomy (concrete walkthrough)

Repo layout (`aaif-goose/goose`, Rust + Electron, ~1.1 GB, ~43.5k stars):

- `crates/goose/` — core agent + provider abstractions, including `src/security/patterns.rs` (deterministic prompt-injection regex set)
- `crates/goose-mcp/` — bundled MCP server extensions
- `crates/goose-cli/`, `crates/goose-server/`, `ui/desktop/` — interface tier
- `recipe-scanner/` — Dockerized scanner that runs goose-with-an-LLM against a recipe to flag injection attempts (`"analysis_method": "goose_ai"`)
- `documentation/docs/guides/` — the user's URL; 30+ guide files

Load-bearing guides (read in source — the `goose-docs.ai` site is Docusaurus HTML, source markdown lives in the repo):

1. `goose-permissions.md` — four modes: Auto / Manual Approval / Smart (risk-based) Approval / Chat. Smart auto-approves low-risk and prompts on high-risk; the risk classifier is the LLM provider itself.
2. `managing-tools/tool-permissions.md` — per-tool 3-level grant: Always Allow / Ask Before / Never Allow. Tier ladder maps cleanly onto our auto-reservation story.
3. `allowlist.md` — `GOOSE_ALLOWLIST=https://...yaml` pointing at an admin-curated YAML of allowed extension install commands. Cached, refetched on restart, exact-match enforcement at install time.
4. `using-gooseignore.md` — gitignore syntax with negation. Defaults when no file exists: `**/.env`, `**/.env.*`, `**/secrets.*`.
5. `sandbox.md` — macOS-only `sandbox-exec` profile + local egress proxy. Blocks tunneling tools (`nc, ncat, netcat, socat, telnet`), raw sockets, kernel-ext loads, writes to `~/.ssh/`, `~/.bashrc`, `~/.zshrc`, `~/.bash_profile`, `~/.zprofile`, `~/.config/goose/`. Egress proxy live-reloads `~/.config/goose/sandbox/blocked.txt` via `fs.watch`.
6. `security/prompt-injection-detection.md` — deterministic patterns in `crates/goose/src/security/patterns.rs` plus optional ML classifier via configurable HTTPS endpoint (default example: HF `protectai/deberta-v3-base-prompt-injection-v2`). Threshold tunable 0.01–1.0; findings get IDs and audit logs.
7. `security/adversary-mode.md` — independent LLM agent that loads `~/.config/goose/adversary.md` (plain-English BLOCK/ALLOW rules) and gates each tool call with original-task + recent-message context. Verbatim: *"If the reviewer fails for any reason, the tool call is allowed through (fail-open)."* Default tools reviewed: `shell`, `computercontroller__automation_script`.
8. `subagents.mdx` — model autonomously spawns recipe-configured subagents (parallel/sequential), 5-min default timeout, scoped extension list. Recipes are YAML.

End-to-end session: `goose` boots → loads providers + MCP extensions + `.gooseignore` + permission mode → user prompts in NL → if `SECURITY_PROMPT_ENABLED`, every tool call passes through `patterns.rs` → if `adversary.md` exists, also passes through the LLM reviewer → if approved by both layers, tool runs, with subagents possibly delegated transparently and results streamed back.

## 3. Deterministic or agentic?

**Hybrid by design**, with the *guardrail layer* having an explicit deterministic-vs-agentic split:

- **Deterministic**: `gooseignore`, allowlist, sandbox profile + egress proxy, prompt-injection regex patterns, permission mode + per-tool grant.
- **Agentic**: the agent itself, subagent orchestration, **adversary mode** (LLM ALLOW/BLOCK reviewer), recipe-scanner (containerized goose+LLM scanning recipes).

Architecture matches `reference_sondera_architecture.md` — pattern matching catches known attacks, LLM reviewer catches contextual ones. Upstream is candid about the limit: *"These checks provide a safeguard, not a guarantee. They detect known patterns but cannot catch all possible threats, especially novel or sophisticated attacks."* SECURITY.md adds: *"goose may follow commands found embedded in content even if those commands conflict with the task given to goose."*

**License**: Apache-2.0 throughout. Clean for substrate borrowing and for paid reuse. Project recently moved from `block/goose` to `aaif-goose/goose` (Linux Foundation's Agentic AI Foundation); the old GitHub URL 301-redirects.

## 4. Substrate vs. surface

- **Surface**: desktop app + CLI + REST API + MCP extension ecosystem, all branded as goose.
- **Substrates** (per layer):
  - `crates/goose/src/security/patterns.rs` — Rust threat-pattern set; **borrowable as regex strings**, not as code (would need Node port).
  - Sandbox profile + egress proxy — useful as a *pattern* (file-protect list, tunneling blocklist) but binary is macOS-only and the interlinked CLI is not a network proxy.
  - Allowlist YAML schema — trivially borrowable; just a scheme.
  - Adversary-mode contract (`~/.config/goose/adversary.md` → LLM ALLOW/BLOCK with conversation context) — borrowable as architecture, not code.

The harness's working surface is JS/TS; the borrowable substrate here is **patterns and architecture, not Rust source**.

## 5. Lane

**Lane 2 (immediate) + lane 4 (pattern cluster) + lane 5 (paid-product reinforcement).** The guides aren't a single thing — they tap multiple lanes:

- **Lane 2** — `crates/goose/src/security/patterns.rs` should be diffed against our existing destructive/exfil and protected-files rules. The sandbox tunneling list (`nc/ncat/netcat/socat/telnet`) and sensitive-file-write list (`~/.ssh/`, shell rcs, `~/.config/goose/`) are direct add candidates.
- **Lane 4** — three pattern reinforcements:
  1. Detect-then-decide split with an LLM contextual layer + **fail-open default** — this is the **third independent affirmation** (Sondera, our own LLM-policy plan in `project_llm_policy_enforcement.md`, now Goose adversary mode). Strong enough to graduate from memory note to RFC.
  2. Plain-language policy file (`adversary.md`) edited by humans, consumed by an LLM reviewer at runtime — same shape as a /enforce *input*, evaluated dynamically rather than distilled into static rules. Worth recording as "the other end of the /enforce spectrum."
  3. Centralized HTTPS-fetched allowlist as deployment surface for orgs — relevant when guardrails-cloud needs multi-tenant policy distribution.
- **Lane 5** — adversary-mode-as-a-service and recipe-scanner-as-a-service map directly onto guardrails-cloud's value prop (LLM-as-judge for agent actions, with org policy). Goose is OSS+local; the *paid* version of this is the agency-cloud / guardrails-cloud thesis.

Not lane 3 (no code-level borrow proposed; license-clean if we change our mind). Not lane 1 directly. **However**: Goose's *own* `AGENTS.md` is one of the cleanest hard-imperative AGENTS.md files seen so far — namespace prefixes (`Ink-Layout:`, `Ink-Overflow:`, `Ink-Text:`), explicit `Never:` blocks, `Test:`/`Error:`/`Provider:` topic-imperatives. It's a high-quality external test corpus *for /enforce*, separate from this evaluation.

## 6. Smallest spike

Pick one of two; both half a day.

- **Spike A — pattern lift to harness.** Read `crates/goose/src/security/patterns.rs` and diff against `src/harness/rules/builtin-rules-extras.ts` + protected-files rules. Add net-new entries:
  1. Tunneling-tool block (`nc`, `ncat`, `netcat`, `socat`, `telnet`) as a destructive/exfil rule entry — verify via `__tests__/builtin-rules-destructive-v1.test.ts` and `command-guard-parity.test.ts`.
  2. Sensitive-file-write protection for `~/.ssh/`, `~/.bashrc`, `~/.zshrc`, `~/.bash_profile`, `~/.zprofile`.
  3. Cross-check our `**/.env`, `**/secrets.*` defaults against Goose's gooseignore defaults — they should already match.
  Single small PR. License-clean (regex strings, not code).
- **Spike B — /enforce regression target.** Run `/enforce https://raw.githubusercontent.com/aaif-goose/goose/main/AGENTS.md` end-to-end and measure how many of Goose's `Never:` blocks, namespace-prefixed `Ink-Layout:`/`Ink-Overflow:` rules, and `Test:`/`Provider:`/`Error:` topic-imperatives /enforce captures as block/ask/advisory. Use deltas to pick the next /enforce parser improvements.

Spike A produces a shippable PR; Spike B produces a benchmark + parser-improvement list.

## 7. Artifact

Memory note (this file) + half-day Spike A PR (when prioritized) + Spike B benchmark addition to /enforce dev loop. The lane-4 detect/decide+fail-open pattern cluster is now strong enough (three independent projects, two of them in production) to move from memory note to **RFC** — to live in the sibling repo's `docs/design/` per `reference_sibling_server_repo.md`.

## 8. Surface

- **interlinked-cli** — Spike A pattern lift, Spike B /enforce benchmark.
- **guardrails-cloud** — adversary-mode-as-a-service (LLM-policy reviewer with org-shared `adversary.md`), recipe-scanner-as-a-service (server-side recipe scan before deploy).
- *Not* agency-cloud directly — Goose competes with our agent-product space, not with our supervision layer.

## Notes

- **Project lineage**: originally `block/goose` (Square), donated to the Linux Foundation's Agentic AI Foundation and renamed to `aaif-goose/goose`. README banner: *"goose has moved! ... please bear with us during the transition."* Apache-2.0 throughout. If any internal memory still references `block/goose`, sweep and update.
- **Adversary mode quote, verbatim**: *"If the reviewer fails for any reason, the tool call is allowed through (fail-open)."* Direct match to `feedback_safety_continuity.md`. Independent third-party confirmation that fail-open is the right default for LLM-policy review.
- **Smart Approval**: marketed as "risk-based approach to automatically approve low-risk actions." The risk classifier *is the model itself* (interpreted by the LLM provider) — tasteful and low-cost but inherits all variance of the underlying provider. Worth contrasting with our deterministic harness rules in any future doc comparing supervision strategies.
- **Subagent default timeout 5 min** — concrete number for cohort-manager design. No output on timeout; for parallel runs, a single failure yields only successful-subagent results.
- **Performance hint**: *"goose performs best with fewer than 25 total tools enabled across all extensions."* Aligns with our "tool-set entropy → tool-decision paralysis" intuition. Cite when justifying scoped reservation/cohort choices.
- **Recipe-scanner architecture**: Docker container, `/usr/local/bin/goose`, base recipe, `OPENAI_API_KEY` required, output JSON includes `analysis_method: "goose_ai"`. Goose-scanning-recipes-with-itself — purest form of LLM-as-judge for agent artifacts. Direct analog for guardrails-cloud's "recipe approval" feature.
- **/enforce test target**: Goose's `AGENTS.md` is unusually structured — namespaced rules, explicit `Never:` blocks, `Topic: imperative` lines. Better /enforce input than most CLAUDE.md files. Use as a regression source, not as enforcement *for* this project.

## Methodology notes

- The user-facing URL pointed at `goose-docs.ai/docs/category/guides`, but the load-bearing work was in `aaif-goose/goose`'s `crates/goose/src/security/patterns.rs` (deterministic), `recipe-scanner/scan-recipe.sh` (LLM-driven), and the sandbox profile (file/network policy). The docs site framed everything as "security features"; the source split cleanly into deterministic + agentic + sandbox layers. Same lesson as CodeWiki — read the source, not the framing.
- The `goose-docs.ai` Docusaurus site does not honor `Accept: text/markdown`. Skip the rendered HTML and pull `documentation/docs/guides/*.md` directly from the GitHub raw URL — the markdown source is far cheaper and complete.
- **Pattern-cluster threshold reached**: detect-then-decide split (Sondera, Supermodel, our LLM-policy plan, now Goose adversary mode) and fail-open default (our `feedback_safety_continuity.md` and Goose adversary mode) have crossed the third-affirmation bar from `serena.md`'s methodology note. Action: open the RFC in the sibling server repo.
