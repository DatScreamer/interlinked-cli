# AGNT

- **Source:** https://github.com/agnt-gg/agnt (v0.6.4, AGNT Labs / Nathan Wilbanks)
- **Encountered:** 2026-07-07, GitHub (evaluated against this rubric)
- **Verdict:** Compound — **memory note** (thesis validation) + **1 new harness check** (zip-slip tar-extract) + use as a **`cross-repo-validate` corpus**. Skip as an adoption target; license blocks code-borrow.

## 1. Core idea (one sentence)
A local-first "agent operating system" — an Electron desktop app + Express/SQLite backend that builds, runs, traces, and self-improves AI-agent *workflows* (a visual DAG engine, a multi-LLM orchestrator, a plugin marketplace, goals, and skills), all on one machine.

## 2. Anatomy
```
main.js / preload.js        Electron shell (loopback backend on :3333)
backend/src/
  workflow/                 deterministic DAG engine (WorkflowEngine, NodeExecutor, EdgeEvaluator)
  services/orchestrator/    the agent brain — llmAdapters.js (~6k LOC), OrchestratorService, tools.js
  services/goal/            TaskOrchestrator + SkillEvolver ("SkillForge": traces→skills)
  services/auth/            AuthManager + Gemini/Codex/Antigravity credential-borrowers
  services/unfirehose/      UnfirehoseLogger — append-only JSONL execution traces
  plugins/                  PluginInstaller / PluginManager (.agnt marketplace packages)
  tools/library/            60+ built-in tools incl. execute-javascript / -python, mcp-client
backend/plugins/            marketplace-default + dev templates (github, plaid, twitter, telegram…)
frontend/                   Vue canvas UI (dark "command-center" design system, DESIGN.md)
```
**Load-bearing files:** `workflow/WorkflowEngine.js` (deterministic trigger→node→edge BFS with iteration caps, every run logged to `ExecutionModel`); `services/orchestrator/OrchestratorService.js` + `llmAdapters.js` (15+ providers); `plugins/PluginInstaller.js` (marketplace install — no signing); `tools/library/utilities/execute-javascript-child.js` (whose header states `node:vm` "is not a security boundary"); `services/goal/SkillEvolver.js` (LLM rewrites a skill from a trace).
**User invokes:** `npm start` (Electron) or `npm run dev` (backend). **Session:** a trigger (webhook/timer/message) fires → `WorkflowEngine._executeWorkflow` walks the node graph, resolving `{{trigger}}`/`{{node}}` params and following edges whose conditions pass → each node runs an LLM call, a tool, or arbitrary JS/Python → `ExecutionModel` + `UnfirehoseLogger` record the trace → later, SkillForge feeds that trace to an LLM to author a "better" reusable skill.

## 3. Deterministic or agentic?
**Hybrid.** The *control plane* is deterministic (DAG traversal, edge conditions, `globalMaxIterations=100` runaway cap, SQLite-persisted execution log). The *nodes* are agentic/effectful (LLM orchestrator, unsandboxed code tools, LLM-authored SkillForge). Architecturally it's the mirror of interlinked — AGNT keeps the *workflow* deterministic and puts the model in the nodes; we keep the *check pipeline* deterministic and quarantine the model to an escalation layer. **License: AGNT Community Core License — source-available, fair-use internal-commercial** (no fork/redistribute/SaaS/multi-tenant; "Powered by AGNT" attribution; paid upgrade $333→$33k/yr). **Blocks lane-3 code-borrow and lane-5 paid reuse.** Pattern-learning and read-only use as a fixture are unaffected.

## 3b. Role in its native architecture — and does it transfer?
AGNT's plugin + code-exec layer is a **convenience** layer resting on one explicit bet, quoted in its own source: *"code is written by the user running their own backend"* (`execute-javascript-child.js:12`). Under that bet the posture is coherent. It **does not transfer** to a governed or multi-agent topology: the same paths — a marketplace plugin fetched from a server-controlled `downloadUrl` (unsigned, unpinned, `preservePaths:true` tar extraction, postinstall-enabled `npm install`), and LLM-emitted JS/shell that runs with the credential manager + `AGNT_AUTH_TOKEN` in `process.env` — become the attack surface the moment code stops being hand-authored by the operator. Native role: convenience. Role it would have to take in our stack: an *untrusted-input boundary* AGNT simply does not draw.

## 4. Substrate vs. surface
Surface = the desktop agent-OS. Substrate = the DAG engine, plugin loader, JSONL trace store, credential-borrowers, and an ML-KEM-768 + ChaCha20-Poly1305 E2EE transport (confidentiality wrapper for LLM traffic to *one* provider, Chutes.ai — not plugin signing, not credential-at-rest). Could the substrate be borrowed without the surface? **No** — license forbids it, and each piece is something we already ship (traces, auth-fallback) or deliberately avoid (a plugin marketplace, runtime deps). The substrate's value to us is as *negative examples*, not code.

## 5. Lane (1–6)
**Primary 2 (detection technique)** + **4 (pattern)**; **6 (skip)** for the product itself. Two-lane pick justified: AGNT's fail-open supply-chain paths are concrete, deterministic anti-pattern *fixtures* a harness check can key on (lane 2), and its whole security posture is external evidence validating our fail-closed thesis (lane 4). It is emphatically **not** lane 3/5 (license-blocked; a peer agent-runner, not a capability we host).

## 6. Dependency & displacement
- **Deps:** adopting AGNT would add Electron + ~40 runtime deps — a non-starter. Using it as a read-only fixture/corpus adds **zero**.
- **Displacement:** its supply-chain install is the fail-**open** mirror of our `evaluator/package-install-guard.ts` + `package-allowlist.json` + `manifest-edit-guard.ts`; its `UnfirehoseLogger` trace overlaps our `activity.jsonl`/trajectory; its Gemini/Codex credential-borrowers mirror our `auth.ts` Claude-Code-creds fallback — but AGNT *writes tokens back* and adds ban-avoidance, where we stay read-only.
- **Equivalence (capability → our status):** supply-chain admission gate → **shipped** (allowlist, three admission screens). `npm install --ignore-scripts` enforcement → **shipped** (`builtin-npm-no-ignore-scripts` warn rule; AGNT `PluginInstaller.js:1097` is a positive fixture). Zip-slip / unsafe-tar-extract detector → **absent** (the one new check). Credential-fallback → **shipped** (read-only, narrower than AGNT by design). Governance hook into AGNT → **absent + blocked** (no interception point; forking forbidden).

## 7. Smallest spike (≤1 day)
Two independent, day-scoped, zero-license-risk spikes: (a) run the `cross-repo-validate` skill against the cloned AGNT tree (711 backend JS files — a real, messy, agentic Node repo) for detector fire-rate + FP calibration; (b) add a `unsafe_tar_extract` detector — flag `tar`/`tarExtract` calls with `preservePaths:true` or `filter:()=>true` (disabled path-traversal defense), with `PluginInstaller.js:611-620` as the positive fixture and ≥3 negatives (default-safe extraction, non-tar, guarded). Sibling to `checks/fs-write-safety.ts`.

## 8. Phase relevance
| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | `unsafe_tar_extract` check + AGNT as a `cross-repo-validate` corpus | §7 | now |
| Guardrails / Agent CI | — (AGNT is a peer product, not cloud fodder for us) | — | parked |

Credential-borrowing informs our own runner-auth posture (where we draw the read-only line) — a parked pattern, not a surface.

## 9. Artifact
Compound: (1) **memory note** — AGNT is the canonical fail-open baseline that validates the supply-chain-allowlist thesis, and the credential-borrowing line-drawing reference; (2) **one harness check** — `unsafe_tar_extract` (lane 2, per `feedback_generalize_across_codebases`); (3) **corpus** — keep the clone as a `cross-repo-validate` target. **Not** a PR to AGNT, **not** an RFC, **not** adoption. The "govern AGNT as a runner" seam is parked: it ships no pre-tool hook to install against, and the license forbids the fork that adding one would require.

## Notes
- Its own comment is the thesis in one line: `node:vm` "is not a security boundary … AGNT's local-first threat model — code is written by the user running their own backend — makes node:vm the right fit" (`execute-javascript-child.js:8-14`). External confirmation of `feedback_local_checks_not_a_trust_boundary`.
- `AntigravityAuthManager.js` carries a `PRD-109 ban-avoidance` comment + `SOFT_QUOTA_FLOOR` and spoofs `ideType:'ANTIGRAVITY'` headers to pass Google's gates — credential-borrowing pushed to ToS-adjacent quota evasion. We do the *read-only* half of this pattern; note the line.
- No marketing-vs-reality gap (cf. CodeWiki): AGNT is honestly what it claims, *including* honestly insecure-by-design. The gap is between its trust model and any multi-party one.
- Related intakes: supply-chain — `sondera-coding-agent-hooks.md`, `grype-syft.md`, `trivy.md`, `sanctum-oss.md`; runner-governance — `project_copilot_cursor_status` (per-runner hook matrix).
