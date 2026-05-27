// Shared types for the check-metadata module. A light file of its own so
// each metadata constant file can import from here without re-importing
// Determinism directly from ../types.

import type { Determinism, ToolExternality } from "../types.js";

/**
 * OWASP Agentic Security Initiative 2026 risk IDs (ASI01–ASI11).
 *
 * Borrowed from Microsoft Agent Governance Toolkit's `docs/compliance/owasp-agentic-top10-architecture.md`.
 * The working group expanded from 10 to 11 risks in 2026; we adopt the full ASI01–ASI11
 * range. Mapping a check to an ASI is positioning, not certification — it documents the
 * threat class the check is designed to mitigate, and lets `interlinked verify --json`
 * surface coverage in compliance-team-readable terms without a third-party audit.
 *
 * - ASI01 Agent Goal Hijack — adversarial inputs override an agent's intended goal
 * - ASI02 Tool Misuse and Exploitation — agent invokes tools in unintended ways
 * - ASI03 Identity and Privilege Abuse — n/a for the local harness (no agent identity)
 * - ASI04 Agentic Supply Chain — typosquats, dependency confusion, unverified package installs
 * - ASI05 Unexpected Code Execution — eval/exec, deserialization, hardcoded secrets, code injection
 * - ASI06 Memory and Context Poisoning — instruction-injection in tool output or read files
 * - ASI07 Insecure Inter-Agent Communication — n/a for the local harness (no A2A)
 * - ASI08 Cascading Agent Failures — n/a for the local harness (no SLO/circuit-breaker)
 * - ASI09 Human-Agent Trust Exploitation — silent edits, hidden side effects, audit gaps
 * - ASI10 Rogue Agents — n/a for the local harness (no agent quarantine)
 * - ASI11 Agent Untraceability — tamper-evident audit, hash-chained decision log
 */
export type OwaspAsi =
	| "ASI01"
	| "ASI02"
	| "ASI03"
	| "ASI04"
	| "ASI05"
	| "ASI06"
	| "ASI07"
	| "ASI08"
	| "ASI09"
	| "ASI10"
	| "ASI11";

/** Documentation metadata for a single registered check. */
export interface CheckMeta {
	name: string;
	description: string;
	tier: 1 | 2 | 3;
	determinism: Determinism;
	/**
	 * Optional OWASP ASI 2026 risk this check mitigates. Surface in
	 * `interlinked verify --json` and reference docs. Multiple risks may apply
	 * — use the most specific. Omit if the check doesn't have a clean ASI fit
	 * (style/complexity/taste checks usually don't).
	 */
	asi?: OwaspAsi;
	/**
	 * Optional externality tier this check is scoped to (see
	 * `src/harness/evaluator/tool-classifiers.ts`).
	 *
	 * - `pure_read`       — check fires on Read / Glob / Grep targets only.
	 * - `local_write`     — check fires after a local file write / edit.
	 * - `external_action` — check fires on calls that escape the local
	 *                       machine (WebFetch, mcp send, git push, …).
	 *
	 * Biased toward correctness: leave undefined when unsure, when the check
	 * is session-level (not tied to one tool call), or when it runs across
	 * multiple externality tiers. Docs generation and policy authoring use
	 * this to surface coverage by tier.
	 */
	externality?: ToolExternality;
}
