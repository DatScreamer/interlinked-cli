# Hud (hud.io) — Runtime Code Sensor

- **Source:** https://www.hud.io/ • https://github.com/code-hud • https://docs.hud.io • npm `hud-sdk` / `hud-mcp` / `@code-hud/hud-cli` • PyPI `hud-sdk`
- **Encountered:** 2026-06-11, user-requested deep dive
- **Verdict:** pattern haul (lane 4) + Agent CI roadmap input (lane 5) + one ≤1-day CLI spike (local MCP read surface). No sensor build — different product, zero gate overlap.

## 1. Core idea (one sentence, your words)

In-process runtime sensors (Node/Python/Java) stream function-level production behavior — invocations, latency percentiles, errors, CPU, caller→callee, per-deployment — into a ClickHouse-backed cloud, and every agent-facing surface (MCP/SQL, IDE overlays, autonomous GH-Actions fix loops) exists to let coding agents query that production truth instead of guessing.

## 2. Anatomy (concrete walkthrough)

Company: Israeli, founded by Roee Adler (CEO, ex-WeWork), May Walter (ex-CTO Santa/Bond/Shookit), Shai Wininger (Lemonade co-founder, non-exec). ~$21M raised quietly; public launch 2025-12-10. Customers: monday.com, Drata, ZoomInfo, Guardz. Tagline: *"Observability was built for humans. Runtime intelligence was built for coding agents."* Core is closed-source; the GitHub org (`code-hud`) holds only shims, demos, and perf-fork showcases — the shipped source of record is the npm/PyPI artifacts.

- **`hud-sdk` (Node, v1.8.10, ~34MB dist):** entry `on_require.js`/`on_import.mjs` via `require-in-the-middle`; the actual rewrite lives in a napi-rs **native addon** exporting `transform` / `getSourceMap` / `markFileAndFunctions` (7 platform prebuilds — SWC-style load-time function instrumentation in Rust). `worker_threads` exporter (512KB `worker.js`), `AsyncLocalStorage` flow context, `@babel/core` only for declaration parsing, esbuild/Next.js plugins for bundled apps. ~17 runtime deps (axios, babel, typescript, zod…). Overhead is *governed, not assumed*: `HUD_MIN_POD_MEMORY_MB`, `HUD_MAX_INSTRUMENTED_FUNCTIONS`, `HUD_MAX_OUTBOUND_WITH_DATA`, module include/exclude knobs.
- **Data plane:** two classes — **metrics** (aggregates, PII-free) and **forensics** (event payloads on errors/spikes only, scrubbed **in-pod** before egress: ~60 key names + regex patterns → `[REDACTED]`; function params off by default). **HudQL** = ClickHouse SQL at `POST api.hud.io/v1/query`: `Functions` / `FunctionMetrics{High,Low}Resolution` (caller/callee + `wrapped_endpoint_id` — a runtime call graph), `Endpoints` / `EndpointMetrics*`, `MachineMetrics`, `Forensics`, deployment tables; helpers `percentileMS()`, `endpoint_error_rate()`.
- **`hud-mcp` v2:** zero-dep stdio→remote **bridge** — no tool definitions in the bundle; tools, schemas, and even agent skills are served from their cloud (server-versioned agent surface). Tools (from docs/recipes): `hud-get-schema`, `hud-query` (SQL), `hud-get-forensics`, `hud-get-skill` (serves prompt-skills like `use-hud-forensics`, `create-hud-url`), `create-hud-url`; REST adds list-issues/issue-details.
- **`agent-runner`:** reusable GH Actions workflow — vendor-cloud Workflow Manager queues tasks; the **customer's** CI polls via GitHub **OIDC→Auth0 short-lived token exchange** (no static secrets), runs tasks matrix-parallel in a **Claude Code subprocess** with a deny-by-default env allowlist; self-dispatch continuation deliberately lives in the *caller* so agent steps never hold `actions: write`; freeform agent text travels via artifacts/files because GitHub's secret masker eats JWT-shaped `$GITHUB_OUTPUT`.
- **`hud-agentic-workflows-recipes`:** use-case × runner matrix (GH Actions Claude/Codex, gh-aw, Cursor automations, Claude routine). Recipes: **blast-radius** (0–100 score; `WEIGHT_CODE_CHANGE_RISK=0.40` + traffic/latency-sensitivity weights), **weekly report** (self-healing PRs), **dead-code cleanup** (zero production invocations over a lookback), **rollback-check** (ROLLBACK/INVESTIGATE/WARN/CLEAN; a full per-version endpoint-ownership algorithm written as prose for the agent, with subagent delegation). Prompts carry `NON_NEGOTIABLES` blocks encoding statistical discipline ("`SUM(invocations)`, not `COUNT(*)`"; "never order versions lexicographically — by observed `first_seen` only").
- **PR comparison (early access):** GitHub App comments when *test-job* runtime metrics degrade vs main — fires only on degradation ≥100% **AND** ≥200 invocations **AND** p90 ≥200ms (volume floor × magnitude floor × relative delta).

End-to-end: one import installs the sensor → streams to cloud → IDE overlay + Slack heads-up alerts → agent queries truth via MCP SQL → scheduled/queued agents open fix PRs → PR comparison checks the fix's runtime behavior.

## 3. Deterministic or agentic?

**Hybrid, cleanly split.** Sensing, aggregation, and every threshold are deterministic (native instrumentation, ClickHouse, conjunction-gated PR warnings). All analysis/remediation is agentic (Claude/Codex executing prose algorithms over HudQL). The notable inversion of our rule: they put deterministic-shaped *algorithms inside prompts* (rollback ownership procedure) — tolerable in their stack because every agentic output is **advisory** (report, PR), never a gate. **License:** closed-source core; recipes/runner repos show no permissive license — patterns yes, code-borrow no.

## 3b. Role in its native architecture — and does it transfer?

The sensor is an **oracle** (production truth); nothing in their stack is a boundary — nothing blocks. The MCP layer is **convenience/context**; agent-runner is **orchestration** that leans on GitHub's permission model as its boundary. Transfer: the oracle role does not transplant (we have no production plane and won't — local-first); the orchestration security patterns transfer directly to Agent CI; the MCP-read-surface pattern transplants to the local harness as-is, because read-only + deterministic.

## 4. Substrate vs. surface

Substrate: load-time native rewriting, ClickHouse metrics store, SQL-over-MCP, OIDC task loop, server-distributed skills. Surface: IDE overlays, Slack alerts, PR comments, recipes. None of the sensor substrate is borrowable (different product, closed source) — what's borrowable is the *shape*: a ~5-tool MCP surface (schema + query + detail + skill + deep-link) over an existing corpus.

## 5. Lane (1–6)

**Lane 4** (patterns: MCP-as-agent-surface over a data corpus; server-versioned skills via `get-skill`; volume×magnitude×delta threshold conjunction; runtime-truth oracles upgrading static checks) **+ lane 5** (Agent CI: customer-compute runner topology and its three security patterns). Thin lane-3 sliver: a hand-rolled MCP stdio server over our local JSONL corpora (zero new deps).

## 6. Dependency & displacement

- **Deps:** nothing to import — the spike is hand-rolled JSON-RPC over stdio (we already run a Unix-socket JSON server). Contrast worth recording: their *sensor* ships ~17 runtime deps; a sensor can afford that, a guard can't — validates our 1-dep stance without generalizing it to their product class.
- **Displacement:** none today. They observe runtime post-deploy; we gate edits pre-commit. Zero gate collision; their IDE/PR surfaces are read-only context. Closest internal overlaps: `impact-analysis.ts` blast radius (static reach) vs their traffic-weighted blast radius; `dead_exports` (static liveness) vs their zero-invocation cleanup.
- **Equivalence:** prod runtime sensor → **absent** (deliberate; different product). Agent-queryable harness data → **absent** locally (bespoke CLI subcommands only; the sibling MCP server is sync/system-of-record, not a local query surface) ← the gap worth closing. Autonomous remediation loop → **designed** (Agent CI P4–5) vs their shipped. PR runtime comparison → **designed-adjacent** (commit gate + mutation are our pre-merge analogs; runtime-metric flavor needs a data plane we don't have). Issue→task aggregation → **shipped** edit-time analog (`recurrence` + `proposeAction`). In-workload scrubbing before egress → **shipped** analog (local PII/secrets scrub before server sync). Server-versioned skills → **absent** (ours live in-repo).

## 7. Smallest spike

≤1 day: `interlinked mcp serve` — hand-rolled stdio MCP exposing 3 read-only tools over existing corpora: `il-get-schema` (describes `activity.jsonl` v5 / `recurrences.jsonl` / reservation-event shapes), `il-query` (parameterized canned queries first; SQL later if wanted), `il-get-check-doc` (serves check metadata + fix guidance from `check-metadata.ts` — our `hud-get-skill` analog). Proves: can Cursor/any agent self-serve "what does the harness keep flagging in this repo?" without us shipping IDE anything.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | local MCP read surface over harness corpora; conjunction-threshold calibration for ratchet/pulse checks | §7 | next |
| Agent CI (P4–5) | customer-compute runner topology (OIDC short-lived exchange, continuation-in-caller, artifact channel for freeform agent text, deny-by-default env allowlist) as an alternative/complement to Cloudflare Sandboxes; runtime-truth check upgrades if a customer data plane ever exists | fold into `tier-3-async-deep-review.md` as a deployment-topology option | next / parked |

## 9. Artifact

This file + memory note (`reference_hud_runtime_sensor.md`). Compound verdict: **adopt** the MCP-read-surface spike, the agent-runner security trio (into the Tier 3 memo), and the threshold-conjunction pattern; **reject** building any runtime sensor (different product) and reject LLM-executed algorithms anywhere gating (their prose-algorithm pattern stays advisory-only by our rules).

## Notes

- **Name collision:** hud.so / github.com/hud-evals (`hud-python` on PyPI) is an unrelated agent-*evals* company. THIS Hud = hud.io / `code-hud` / npm+PyPI `hud-sdk`. Don't conflate.
- Their thesis is our thesis at the opposite end of the lifecycle: agent-era-checks says "watch the agent, not the file"; Hud says "show the agent the runtime, not the README." Same observation — the agent is the new consumer of dev-infra signal — split by where each sits (edit-time vs run-time). Partnership-shaped, not competitor-shaped (cf. `supermodel.md`).
- 4th independent witness for predict/reveal/reconcile-with-reality (after ECHO, Devin, Supermodel dead-code playbook): production invocations are a *more*-precise liveness oracle than static graphs — "don't verify a precise tool with a less-precise one" generalizes to "prefer the most-precise available oracle per claim."
- The `claude-code-action` fork (2025-07) predates agent-runner; the runner now drives a Claude Code subprocess directly. `hud-cursor-plugin` repo is empty; Cursor integration ships through the IDE extension + MCP instead.
- No public pricing (demo-gated; AWS Marketplace listing exists). Wedge stat: "75% struggle to scale AI pilots to production."
- Marketing-vs-reality check **passed**: claims match shipped artifacts (native transform addon, in-pod scrub knobs, real OIDC loop, documented thresholds). Sensor internals beyond the napi export names are inferred from package anatomy — flagged as such.

## Methodology notes (optional)

- For closed-source vendors, `npm pack` / PyPI tarballs are the source of record — the GitHub org held only shims while the real anatomy (native addons, env surface, worker topology) was in the published package.
- A vendor's *workflow comments* can be the highest-signal artifact: agent-runner's YAML comments documented two security decisions (continuation-in-caller, artifact-vs-output masking) more clearly than any doc page.
- During this intake our own trifecta detector FP'd on a grep whose *pattern* contained `https://` — URL-shaped strings in text-tool arguments are not network calls. Logged for a detector refinement.
