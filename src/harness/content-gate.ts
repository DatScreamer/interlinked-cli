// ===========================================
// Shared Content Gate
// ===========================================
// A single source of truth for the "would this proposed content land cleanly?"
// decision. Reused by:
//   - the Write/Edit hook path (PreToolUse) via evaluator/write-content-guards.ts
//   - the `interlinked write` CLI subcommand (bash-mediated writes)
//   - MultiEdit atomic coordinated edits (sibling design doc)
//
// The gate takes a BATCH of (path, proposedContent) pairs and runs each through
// the deterministic content-quality pipeline (pre_block registry → biome
// diff-overlay → tsc diff-overlay → pre_warn registry). Returns a structured
// `GateResult` listing all failures so callers can decide whether to block,
// warn, or write. Transactional callers (e.g. batch write) should treat any
// non-empty `failures` array as "reject the entire batch".
//
// Design constraints:
//   - Pure function over its inputs (plus filesystem for disk snapshots).
//   - Does NOT write to disk. Does NOT interact with the harness socket.
//   - Matches the existing diff-overlay + pre_block semantics exactly, so
//     the CLI path and the hook path stay in sync.

import { existsSync, readFileSync } from "node:fs";
import { nonNull } from "../lib/non-null.js";
import type { CheckResult } from "./check-engine/types.js";
import { buildAgentSafetyChecks, buildCheckInstructions } from "./check-registry/index.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
	TSC_CHECKER_UNAVAILABLE_CODE,
} from "./diff-overlay.js";
import {
	lineList,
	resolveDiskBaseline,
	runPreBlockRegistryGate,
	suppressionHint,
} from "./pre-block-gate.js";
import { findProjectRoot } from "./quality-checks.js";

// ───────────────────────────────────────────────────────────────
// Named severity constants — public API (consumed by the CLI
// `interlinked write` command and by MultiEdit)
// ───────────────────────────────────────────────────────────────
// Magic-literal-in-conditional rule (and cold-reader clarity): these two
// levels are compared and branched on in several places, so we name them
// once and reuse.
export const GATE_SEVERITY_ERROR = "error" as const;
export const GATE_SEVERITY_WARNING = "warning" as const;
export type GateSeverity = typeof GATE_SEVERITY_ERROR | typeof GATE_SEVERITY_WARNING;

/** Single entry in a write batch — path (must exist or be new) and proposed full content. */
export interface GateInputEntry {
	path: string;
	content: string;
}

/**
 * A single gate failure with enough context for a machine-readable and a
 * human-readable rendering. Shape matches what the Edit/Write diff-overlay
 * surfaces today (tool + ruleId + line + message + severity).
 */
export interface GateFailure {
	/** Absolute or project-relative path the failure applies to. */
	path: string;
	/** Which deterministic check fired. */
	tool: "pre_block" | "biome" | "tsc" | "pre_warn";
	/** Rule/diagnostic id (e.g. "TS2304", "noUnusedImports", "tsc-diff-overlay"). */
	code: string;
	/** 1-based line number (0 if unknown). */
	line: number;
	/** 1-based column number (optional). */
	column?: number | undefined;
	/** Human-readable description of the problem. */
	message: string;
	/** error = transaction-killer; warning = informational only (not a blocker). */
	severity: GateSeverity;
	/** Optional fix hint, mirroring the PreToolUse reason text. */
	hint?: string;
}

export interface GateResult {
	/** True if NO blocking failures. Warnings may still be present. */
	ok: boolean;
	/**
	 * Every failure encountered. Callers that want transaction semantics should
	 * treat any `severity: "error"` entry as "abort". `severity: "warning"` is
	 * informational; the gate does not downgrade based on its own policy.
	 */
	failures: GateFailure[];
	/** Wall-clock ms spent in the gate (for telemetry/budget). */
	elapsedMs: number;
}

/**
 * Gate options for `gateProposedContent`.
 *
 * `projectRoot` is the directory used for biome/tsc config resolution. If
 * omitted, we compute it per-entry via `findProjectRoot()` on the target path.
 */
export interface GateOptions {
	projectRoot?: string;
	/**
	 * When true (default), skip the pre_warn phase entirely — pre_warn is
	 * informational and should never block a batch write. Left here as an
	 * explicit knob for future callers that want the warnings surfaced.
	 */
	skipPreWarn?: boolean;
	/**
	 * Severity assigned when the tsc diff-overlay reports the checker itself
	 * was UNAVAILABLE (sidecar spawn failure / timeout / cooldown) — the file
	 * was not type-checked at all. Unavailable is not clean: transactional
	 * callers (verify-changeset, batch landings) should pass
	 * GATE_SEVERITY_ERROR so the batch aborts; the default keeps the ordinary
	 * single-edit advisory path at a visible warning.
	 */
	tscUnavailableSeverity?: GateSeverity;
}

/**
 * Per-file context threaded through each pipeline phase below. Bundles the
 * four values every phase needs (the failure sink is shared/mutated across
 * phases by design — one accumulator per batch entry).
 */
interface GatePhaseContext {
	path: string;
	content: string;
	projectRoot: string;
	failures: GateFailure[];
}

/**
 * Phase 1: pre_block registry — introduced-only vs the on-disk snapshot,
 * suppression-aware (shared semantics with the PreToolUse write guard; see
 * pre-block-gate.ts). A pre-existing finding is a warning, not a
 * transaction-killer; a new-file write has no baseline, so every finding is
 * introduced (strict) — matching how phases 2-3 treat new files.
 */
function applyPreBlockPhase(ctx: GatePhaseContext): void {
	const { path, content, projectRoot, failures } = ctx;
	const preBlockOutcomes = runPreBlockRegistryGate({
		content,
		filePath: path,
		baselineContent: resolveDiskBaseline(path),
		projectRoot,
	});
	for (const o of preBlockOutcomes) {
		if (o.introduced.length > 0) {
			failures.push({
				path,
				tool: "pre_block",
				code: o.checkId,
				line: nonNull(o.introduced[0]).line,
				message: `introduces ${o.introduced.length} violation(s) at ${lineList(o.introduced)}`,
				severity: "error",
				hint: [o.instruction, suppressionHint(o.checkId)].filter(Boolean).join(" "),
			});
		}
		if (o.preexisting.length > 0) {
			failures.push({
				path,
				tool: "pre_block",
				code: o.checkId,
				line: nonNull(o.preexisting[0]).line,
				message:
					`${o.preexisting.length} pre-existing violation(s) at ${lineList(o.preexisting)} ` +
					"(already on disk — not introduced by this write)",
				severity: "warning",
			});
		}
	}
}

/** Phase 2: biome diff-overlay. New files use an empty diagnostic baseline. */
function applyBiomeOverlayPhase(ctx: GatePhaseContext): void {
	const { path, content, projectRoot, failures } = ctx;
	const biomeOverlay = evaluateBiomeDiffOverlay(path, content, projectRoot);
	for (const f of biomeOverlay.newFindings) {
		failures.push({
			path,
			tool: "biome",
			code: f.ruleId ?? "biome",
			line: f.line,
			column: f.column,
			message: f.message,
			severity: "error",
		});
	}
}

/** Phase 3: tsc diff-overlay. New files use an empty diagnostic baseline. */
function applyTscOverlayPhase(ctx: GatePhaseContext, unavailableSeverity: GateSeverity): void {
	const { path, content, projectRoot, failures } = ctx;
	const tscOverlay = evaluateTscDiffOverlay(path, content, projectRoot);
	if (tscOverlay.checkerUnavailable !== undefined) {
		failures.push({
			path,
			tool: "tsc",
			code: TSC_CHECKER_UNAVAILABLE_CODE,
			line: 0,
			message:
				`type checker unavailable (${tscOverlay.checkerUnavailable}) — ` +
				"this file was NOT type-checked; unavailable is not clean",
			severity: unavailableSeverity,
		});
		return;
	}
	for (const f of tscOverlay.newFindings) {
		const blocking = isTscFindingBlocking(f);
		failures.push({
			path,
			tool: "tsc",
			code: f.ruleId ?? "tsc",
			line: f.line,
			column: f.column,
			message: f.message,
			severity: blocking ? "error" : "warning",
		});
	}
}

/** Phase 4: pre_warn registry — informational, skipped entirely by default. */
function applyPreWarnPhase(
	ctx: GatePhaseContext,
	instructions: Record<string, string>,
	skipPreWarn: boolean,
): void {
	if (skipPreWarn) return;
	const { path, content, failures } = ctx;
	const preWarnChecks = buildAgentSafetyChecks(content, path, "pre_warn");
	for (const check of preWarnChecks) {
		const matches = check.fn();
		if (matches.length === 0) continue;
		const first = nonNull(matches[0]);
		const hint = instructions[check.name];
		failures.push({
			path,
			tool: "pre_warn",
			code: check.name,
			line: first.line,
			message: `${matches.length} violation(s) at ${matches.map((m) => `L${m.line}`).join(", ")}`,
			severity: "warning",
			...(hint !== undefined ? { hint } : {}),
		});
	}
}

/**
 * Run the deterministic content-quality pipeline against a batch of proposed
 * writes. Pure: no disk writes, no harness socket. Returns every failure
 * encountered so the caller can decide transactional policy.
 *
 * Pipeline (mirrors evaluator/write-content-guards.ts):
 *   1. pre_block registry checks (deterministic zero-FP agent-safety rules).
 *   2. biome diff-overlay (new-findings-only vs disk snapshot).
 *   3. tsc diff-overlay (new-findings-only vs disk snapshot).
 *   4. (optional) pre_warn registry checks — surfaced as warnings.
 *
 * New-file writes use an empty baseline in steps 2-3, so every diagnostic
 * introduced by the proposed file is eligible to block the transaction.
 */
export function gateProposedContent(batch: GateInputEntry[], opts: GateOptions = {}): GateResult {
	const start = Date.now();
	const failures: GateFailure[] = [];
	const skipPreWarn = opts.skipPreWarn !== false; // default true
	const tscUnavailableSeverity = opts.tscUnavailableSeverity ?? GATE_SEVERITY_WARNING;

	for (const { path, content } of batch) {
		const projectRoot =
			opts.projectRoot ?? findProjectRoot(path, process.cwd()) ?? process.cwd();
		const instructions = buildCheckInstructions();
		const ctx: GatePhaseContext = { path, content, projectRoot, failures };

		applyPreBlockPhase(ctx);
		applyBiomeOverlayPhase(ctx);
		applyTscOverlayPhase(ctx, tscUnavailableSeverity);
		applyPreWarnPhase(ctx, instructions, skipPreWarn);
	}

	const elapsedMs = Date.now() - start;
	const blocking = failures.some((f) => f.severity === GATE_SEVERITY_ERROR);
	return { ok: !blocking, failures, elapsedMs };
}

/**
 * Read on-disk content for a path, returning undefined if the file doesn't
 * exist. Helper for callers that want to know whether a gate entry is a
 * fresh-file write (no diff-overlay coverage) without duplicating the logic.
 */
export function readOnDiskOrUndefined(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Human-readable rendering of a `GateResult`. Mirrors the shape from the
 * design doc: one section per file, each failure prefixed with its tool and
 * rule code. Used by the CLI subcommand; also exported for tests.
 */
export function formatGateResult(result: GateResult): string {
	if (result.ok && result.failures.length === 0) {
		return `interlinked gate: clean (${result.elapsedMs}ms)`;
	}
	const blocking = result.failures.filter((f) => f.severity === GATE_SEVERITY_ERROR);
	const warnings = result.failures.filter((f) => f.severity === GATE_SEVERITY_WARNING);
	const byFile = new Map<string, GateFailure[]>();
	for (const f of result.failures) {
		if (!byFile.has(f.path)) byFile.set(f.path, []);
		byFile.get(f.path)?.push(f);
	}
	const lines: string[] = [];
	lines.push(
		`interlinked gate: ${blocking.length} blocking failure(s), ${warnings.length} warning(s) across ${byFile.size} file(s) (${result.elapsedMs}ms)`,
	);
	lines.push("");
	for (const [file, fs] of byFile) {
		lines.push(`  ${file}`);
		for (const f of fs) {
			const loc = f.line > 0 ? `line ${f.line}` : "global";
			const marker = f.severity === GATE_SEVERITY_ERROR ? "" : "warn: ";
			lines.push(`    ${f.tool}: ${marker}${f.code} ${loc} — ${f.message}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

/**
 * Re-export check-engine's CheckResult so downstream callers (e.g.
 * `interlinked write`) can depend only on this module without reaching into
 * check-engine internals. Keeps the public surface small.
 */
export type { CheckResult };
