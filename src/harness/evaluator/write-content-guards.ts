// ===========================================
// Write/Edit Content Guards (PreToolUse)
// ===========================================
//
// All of the checks that run against the *proposed post-patch content*
// before it hits disk: injection scanning, merge-conflict detection,
// binary-file blocking, path traversal, JSON validation, the pre_block /
// pre_warn registry gates, the biome + tsc diff-overlays, and the legacy
// TypeScript/JavaScript content-quality regex checks.
//
// Each function either returns a blocking `HarnessDecision` that the
// caller should immediately return, pushes warnings onto the shared
// accumulator, or mutates the pending escalation slot on the caller's
// session.

import { existsSync, readFileSync } from "node:fs";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { describeReason, findMalformedRulesIn, suggestRuleFix } from "../../lib/settings-validator.js";
import { buildAgentSafetyChecks, buildCheckInstructions } from "../check-registry/index.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
} from "../diff-overlay.js";
import { resolveProposedContent } from "../overlay-content.js";
import {
	preBlockIntroducedBlock,
	preexistingPreBlockWarnings,
	resolveDiskBaseline,
	runPreBlockRegistryGate,
} from "../pre-block-gate.js";
import { findProjectRoot } from "../quality-checks.js";
import { scanPromptInjection } from "../signatures.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	evaluateTypeErasureOverlay,
	STRICT_TYPING_RULE_ID,
} from "./type-erasure-overlay.js";
import {
	collectContentQualityWarnings,
	INJECTION_SCAN_MIN_CHARS,
	isContentScanExempt,
} from "./write-content-guards-content-quality.js";

/** Extension regex for binary file formats we block text editors from writing to. */
const BINARY_FILE_EXTENSIONS =
	/\.(png|jpe?g|gif|bmp|ico|webp|avif|svg|woff2?|ttf|otf|eot|wasm|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|o|a|pyc|class|jar|mp3|mp4|wav|ogg|webm|mov|avi|db|sqlite|sqlite3)$/i;

/** Merge-conflict marker regex: any of <<<<<<<, =======, >>>>>>> at a line head. */
const MERGE_CONFLICT_MARKER = /^<{7}\s|^={7}$|^>{7}\s/m;

/** TS error codes that indicate the agent referenced a name unresolved in the
 *  current scope. The canonical signature of a multi-step refactor where the
 *  missing identifier is defined in a sibling edit that hasn't landed yet —
 *  retrying the same `Edit` repeatedly will keep tripping the per-edit overlay
 *  on each intermediate state. Cross-module "no exported member" codes
 *  (TS2305 / TS2724) are excluded: they more often indicate a real typo in
 *  the import path than a coordinated refactor. */
const MULTI_EDIT_REFACTOR_TSC_CODES = new Set(["TS2304", "TS2552"]);

interface TscBlockingFinding {
	ruleId?: string | undefined;
	line: number;
	column?: number | undefined;
	message: string;
}

/** Build the human-readable block reason for a tsc diff-overlay failure.
 *  When the failing tool is a single-edit primitive AND every blocking finding
 *  is a "cannot find name" error, append coordinated-refactor guidance: the
 *  missing symbols live in sibling edits that must land together. The guidance
 *  leads with the always-available technique — sequence the edits through an
 *  intermediate that still compiles — and mentions a transactional multi-edit
 *  primitive only as an optional faster path, since not every runner exposes
 *  one (MultiEdit is absent in some toolsets). When the tool is already a batch
 *  primitive, no nudge — the agent used the right primitive and the failure is
 *  a real type bug. Exported for unit tests. */
export function buildTscDiffOverlayBlockReason(
	toolName: string,
	blocking: ReadonlyArray<TscBlockingFinding>,
	filePath: string,
): string {
	const first = blocking[0];
	const rest = blocking.length - 1;
	const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
	const head =
		`BLOCKED by tsc diff-overlay: this edit introduces ${blocking.length} new type error(s) in ${filePath}. ` +
		`First: [${nonNull(first).ruleId}] L${nonNull(first).line}:${nonNull(first).column ?? 1} — ${nonNull(first).message}${restSummary}. ` +
		"Fix the type error(s) in your edit, or retry without introducing them.";
	if (toolName === "MultiEdit") return head;
	const allMissingSymbols = blocking.every((f) =>
		MULTI_EDIT_REFACTOR_TSC_CODES.has(f.ruleId ?? ""),
	);
	if (allMissingSymbols) {
		return (
			`${head} All blocking errors are 'cannot find name' — the signature of a coordinated refactor whose missing symbols live in sibling edits that haven't landed yet. ` +
			"Land the dependent edits together so the overlay only sees a compiling state: sequence them through an intermediate that still compiles (add the new import / declaration ALONGSIDE the old, switch the usages, then drop the old), or apply them as one batch if your toolset has a transactional multi-edit primitive."
		);
	}
	return (
		`${head} If this is a coordinated refactor (multiple symbols moving together), land the dependent edits as one unit — sequence them through an intermediate that still compiles, or use a transactional multi-edit primitive if your toolset exposes one — so the overlay checks only the final content.`
	);
}

/** Public API — return shape from {@link evaluateWriteContentGuards}. Either a
 *  blocking decision (caller must return immediately) or an `ok` envelope
 *  carrying warnings and an optional pending escalation update. */
export type WriteContentGuardsResult =
	| { kind: "block"; decision: HarnessDecision }
	| { kind: "ok"; warnings: string[]; escalation?: EscalationRequest | undefined };

export interface WriteContentGuardsArgs {
	toolName: string;
	toolInput: JsonObject;
	event: HarnessEvent;
	rules: GuardRulesConfig;
	session: SessionTrajectory | undefined;
	pendingEscalation: EscalationRequest | undefined;
}

/** Match Claude Code's settings.json layout: `.claude/settings.json` or
 *  `.claude/settings.local.json`, anywhere in the path. Covers both project-
 *  local (`<cwd>/.claude/settings.json`) and user-global (`~/.claude/...`)
 *  writes. We deliberately do NOT match arbitrary `settings.json` files
 *  outside a `.claude/` directory — those belong to other tools and have
 *  unrelated grammars. */
function isClaudeSettingsFile(filePath: string): boolean {
	return (
		/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(filePath)
	);
}

/** Resolve the PRE-edit content for a Write/Edit/MultiEdit call so the
 *  Phase B.4 diff-classifier can decide whether to skip warning-severity
 *  detectors. Returns `undefined` when the pre-edit text is unavailable —
 *  the dispatcher then falls through to its legacy run-everything path. */
function resolvePreEditContent(filePath: string, toolInput: JsonObject): string | undefined {
	// Edit / MultiEdit — `old_string` carries the snippet being replaced.
	// We could splice it back into the disk content for full-file accuracy,
	// but the diff-classifier only cares about the delta itself, and the
	// delta == (old_string → new_string). Comparing the snippets directly
	// is exactly the diff the agent is asking us to apply.
	const oldString = typeof toolInput.old_string === "string" ? toolInput.old_string : undefined;
	if (oldString !== undefined) return oldString;

	// Write — there is no `old_string`. Read the on-disk file as the base.
	if (filePath) {
		try {
			if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
		} catch (e) {
			void e; // intentional: stat/read failure → fall through to undefined
		}
	}
	return undefined;
}

/** Public API — consumed by evaluator/pre-tool.ts. Runs every content guard
 *  that applies to a file-write tool call (Write / Edit / NotebookEdit /
 *  apply_patch / etc.) and returns a decision envelope. */
export function evaluateWriteContentGuards(args: WriteContentGuardsArgs): WriteContentGuardsResult {
	const { toolName, toolInput, event, rules, session } = args;
	const warnings: string[] = [];
	let escalation = args.pendingEscalation;

	const filePath = (toolInput.file_path as string) || "";
	// Resolve PROPOSED FULL FILE CONTENT (post-patch) so diff-overlay
	// checks see imports/types/etc., not just the replacement snippet.
	const content = resolveProposedContent(filePath, toolInput);
	// Resolve the pre-edit content so the registry dispatch can apply the
	// Phase B.4 diff-class skip. For an Edit, this is the old_string snippet;
	// for a Write, it is the on-disk file before the overwrite.
	const preEditContent = resolvePreEditContent(filePath, toolInput);
	// The new-content side of the diff has to match the granularity of the
	// pre-edit side. For Edit (where preEdit is the old_string snippet), we
	// pair with new_string; for Write (where preEdit is the on-disk file),
	// we pair with the full proposed content. Falling back to `content`
	// when no `new_string` is present preserves the legacy granularity.
	const postEditContent =
		typeof toolInput.new_string === "string" ? toolInput.new_string : content;

	// PreToolUse injection scanning: catch injection content before it hits
	// disk. Skip test/spec/doc/fixture files — those legitimately contain PI
	// patterns as positive-case fixtures for the detector itself (the
	// canonical example is the signatures-test file, which carries the very
	// strings the prompt_injection rules are written to catch). Without this
	// exemption the daemon scans the proposed full-file content, trips on the
	// existing fixtures, and blocks the Edit; meanwhile the cold-fallback
	// inline path (which has no PI scan) silently allows the same content.
	// The resulting block/allow flap depends on whether the hook reached the
	// daemon within its 500 ms socket timeout — to the caller it looks like
	// non-determinism. Apply the same path-based exemption already used by
	// `collectContentQualityWarnings` so both code paths agree on these files.
	const cwd = typeof event.cwd === "string" ? event.cwd : undefined;
	// Nested helper: scoped to this call's `warnings`/`escalation`. Returns a
	// block decision (high-confidence hit) or null (skip / low-confidence hit,
	// in which case it sets `escalation` and pushes a soft warning as a side
	// effect on the captured locals).
	function injectionGuard(): HarnessDecision | null {
		if (content.length <= INJECTION_SCAN_MIN_CHARS || isContentScanExempt(filePath, cwd)) {
			return null;
		}
		const injectionMatches = scanPromptInjection(content);
		if (injectionMatches.length === 0) return null;
		const highConfidence = injectionMatches.some(
			(m) => m.severity === "critical" || m.severity === "high",
		);
		if (highConfidence) {
			return {
				decision: "block",
				reason: `BLOCKED: Prompt injection pattern detected in content being written to ${filePath}: ${nonNull(injectionMatches[0]).description}. This content may compromise agent behavior.`,
				warnings,
				rule_id: "pretooluse-injection-scan",
				severity: "critical",
				category: "Security",
			};
		}
		// Lower-confidence match — set escalation for classifier
		escalation = {
			trigger: "post_injection_action",
			summary: `Partial prompt injection pattern detected in content for ${filePath}: ${nonNull(injectionMatches[0]).description}`,
			tool_name: toolName,
			tool_input_redacted: { file_path: filePath, content: "[REDACTED]" },
			sensitivity_level: session?.sensitivity_level || "Public",
			step_number: session?.tool_call_count || 0,
			recent_tool_sequence: session?.tool_sequence.slice(-10) || [],
		};
		warnings.push(
			`[interlinked:injection] Low-confidence injection pattern detected in ${filePath}: ${nonNull(injectionMatches[0]).description}`,
		);
		return null;
	}
	const injectionBlock = injectionGuard();
	if (injectionBlock) return { kind: "block", decision: injectionBlock };

	// Validate JSON files + Claude Code settings permission-rule integrity.
	// On parse failure we push a soft warning; for a `.claude/settings(.local)
	// .json` that parsed we block any write introducing a malformed permission
	// rule (mismatched parens / unbalanced quotes / empty / no Tool prefix).
	// Claude Code's own /doctor skips those at load time, but the user is left
	// with a noisy allowlist file. Catching it at write time keeps the file
	// canonically clean regardless of source (agent edits, interlinked-cli
	// rewrites, or other tools — Claude Code's own "Always allow" UI doesn't
	// route through tool calls so it can't be intercepted here; that path is
	// covered by the verify-time scan in checkProjectSetup).
	function jsonAndClaudeSettingsGuard(): HarnessDecision | null {
		let parsedJson: unknown;
		if (filePath.endsWith(".json") && content.trim()) {
			try {
				parsedJson = JSON.parse(content);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				warnings.push(`[interlinked] Warning: Invalid JSON in ${filePath}: ${msg.slice(0, 100)}`);
			}
		}
		if (!isClaudeSettingsFile(filePath) || parsedJson === undefined) return null;
		const malformed = findMalformedRulesIn(parsedJson);
		if (malformed.length === 0) return null;
		const first = malformed[0];
		const others = malformed.length > 1 ? ` (and ${malformed.length - 1} more)` : "";
		const suggestion = suggestRuleFix(nonNull(first).rule, nonNull(first).reason);
		const suggestionClause =
			suggestion !== null ? ` Did you mean ${JSON.stringify(suggestion)}?` : "";
		return {
			decision: "block",
			reason:
				`BLOCKED: Write to ${filePath} would add a malformed permission rule. ` +
				`permissions.${nonNull(first).bucket}[${nonNull(first).index}] = ${JSON.stringify(nonNull(first).rule)} ` +
				`(${describeReason(nonNull(first).reason)})${others}.${suggestionClause} ` +
				"Claude Code's /doctor would skip this rule at load time. " +
				"Fix the rule string (or remove it) before retrying.",
			warnings,
			rule_id: "permission-rule-syntax",
			severity: "high",
			category: "settings-integrity",
		};
	}
	const settingsBlock = jsonAndClaudeSettingsGuard();
	if (settingsBlock) return { kind: "block", decision: settingsBlock };

	// Cheap path/format guards that block unconditionally: path traversal /
	// system-directory writes (../, /etc/, /usr/), binary-file extensions, and
	// A1 merge-conflict markers (a guaranteed parse error).
	function pathAndFormatGuard(): HarnessDecision | null {
		if (filePath.includes("../") || filePath.startsWith("/etc/") || filePath.startsWith("/usr/")) {
			return {
				decision: "block",
				reason: `BLOCKED: Writing to ${filePath} — path traversal or system directory write detected. Agents should only write within the project directory.`,
				warnings,
			};
		}
		if (BINARY_FILE_EXTENSIONS.test(filePath)) {
			return {
				decision: "block",
				reason: `BLOCKED: ${filePath} is a binary file. Text editing tools should not write to binary formats — use the appropriate tool or command instead.`,
				warnings,
			};
		}
		if (MERGE_CONFLICT_MARKER.test(content)) {
			return {
				decision: "block",
				reason: `BLOCKED: Merge conflict markers detected in ${filePath}. Resolve the conflict before writing.`,
				warnings,
			};
		}
		return null;
	}
	const pathFormatBlock = pathAndFormatGuard();
	if (pathFormatBlock) return { kind: "block", decision: pathFormatBlock };

	// ─────────────────────────────────────────────
	// PreToolUse registry gate — phase: "pre_block"
	// ─────────────────────────────────────────────
	// Deterministic error-class checks, INTRODUCED-ONLY: a finding blocks
	// only when THIS edit adds it relative to the on-disk baseline (multiset
	// over normalized line text — shared semantics in pre-block-gate.ts,
	// matching the biome/tsc diff-overlays below). A pre-existing finding
	// surfaces as a warning instead of bricking the file for every unrelated
	// future edit (the bio-orchestrator wall, 2026-07: one legacy match at
	// L49 made a ~1,100-line registry file un-editable). Inline
	// `// interlinked-ignore: <check> — reason` directives and
	// .interlinked/verify-suppressions.json entries are honored — the same
	// suppression grammar PostToolUse and verify already use, so "this line
	// is deliberate" finally has a pre-block answer.
	function preBlockRegistryGuard(): HarnessDecision | null {
		void postEditContent; // reserved for future hunk-granular pre_block
		const outcomes = runPreBlockRegistryGate({
			content,
			filePath,
			// Full on-disk file — NOT preEditContent, which for an Edit is the
			// old_string snippet and would misread every out-of-snippet
			// pre-existing finding as introduced.
			baselineContent: resolveDiskBaseline(filePath),
			projectRoot:
				findProjectRoot(filePath, event.cwd || process.cwd()) || event.cwd || process.cwd(),
		});
		const blocking = outcomes.find((o) => o.introduced.length > 0);
		if (blocking) return preBlockIntroducedBlock(blocking, filePath, warnings);
		warnings.push(...preexistingPreBlockWarnings(outcomes, filePath));
		return null;
	}
	const preBlockDecision = preBlockRegistryGuard();
	if (preBlockDecision) return { kind: "block", decision: preBlockDecision };

	// ─────────────────────────────────────────────
	// PreToolUse diff-overlay gate — biome (Phase 2a)
	// ─────────────────────────────────────────────
	function biomeDiffOverlayGuard(): HarnessDecision | null {
		if (rules.quality_checks?.biome_lint?.enabled === false) return null;
		const cwdForOverlay =
			findProjectRoot(filePath, event.cwd || process.cwd()) || event.cwd || process.cwd();
		const overlay = evaluateBiomeDiffOverlay(filePath, content, cwdForOverlay);
		if (overlay.newFindings.length === 0) return null;
		const first = overlay.newFindings[0];
		if (overlay.exceededBudget) {
			warnings.push(
				`[interlinked:biome-overlay] ${overlay.newFindings.length} new biome finding(s) in ${filePath} from this edit (first: ${nonNull(first).message} at L${nonNull(first).line}). Overlay ${overlay.elapsedMs}ms exceeded 500ms budget — demoted to warning.`,
			);
			return null;
		}
		const rest = overlay.newFindings.length - 1;
		const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
		return {
			decision: "block",
			reason:
				`BLOCKED by biome diff-overlay: this edit introduces ${overlay.newFindings.length} new biome finding(s) in ${filePath}. ` +
				`First: [${nonNull(first).ruleId ?? "biome"}] L${nonNull(first).line} — ${nonNull(first).message}${restSummary}. ` +
				"Fix the new issue(s) in your edit, or retry without introducing them.",
			warnings,
			rule_id: "biome-diff-overlay",
			severity: "high",
			category: "pre-block",
		};
	}
	const biomeDecision = biomeDiffOverlayGuard();
	if (biomeDecision) return { kind: "block", decision: biomeDecision };

	// ─────────────────────────────────────────────
	// PreToolUse diff-overlay gate — tsc LanguageService (Phase 2b)
	// ─────────────────────────────────────────────
	function tscDiffOverlayGuard(): HarnessDecision | null {
		if (rules.quality_checks?.typescript?.enabled === false) return null;
		const cwdForTsc =
			findProjectRoot(filePath, event.cwd || process.cwd()) || event.cwd || process.cwd();
		const tscOverlay = evaluateTscDiffOverlay(filePath, content, cwdForTsc);
		const blocking = tscOverlay.newFindings.filter(isTscFindingBlocking);
		const warnOnly = tscOverlay.newFindings.filter((f) => !isTscFindingBlocking(f));
		for (const f of warnOnly) {
			warnings.push(
				`[interlinked:tsc-overlay] ${filePath}:${f.line} — ${f.ruleId} ${f.message}. New in this edit (warn-only code).`,
			);
		}
		if (blocking.length === 0) return null;
		return {
			decision: "block",
			reason: buildTscDiffOverlayBlockReason(toolName, blocking, filePath),
			warnings,
			rule_id: "tsc-diff-overlay",
			severity: "high",
			category: "pre-block",
		};
	}
	const tscDecision = tscDiffOverlayGuard();
	if (tscDecision) return { kind: "block", decision: tscDecision };

	// ─────────────────────────────────────────────
	// PreToolUse strict-typing diff overlay (gated, default off)
	// ─────────────────────────────────────────────
	// Hard-blocks edits that introduce new type-erasure patterns: `as any`,
	// `as unknown as` chains, unjustified `@ts-ignore` / `@ts-expect-error`,
	// and bare `: any` annotations. The post-edit `as_any_ratchet` warning
	// stays in place when this flag is off; this gate moves the same metric
	// to PreToolUse + hard-block when teams want stricter enforcement.
	function strictTypingOverlayGuard(): HarnessDecision | null {
		if (rules.quality_checks?.strict_typing_block?.enabled !== true) return null;
		const overlay = evaluateTypeErasureOverlay(filePath, content);
		if (overlay.newFindings.length === 0) return null;
		const first = overlay.newFindings[0];
		const rest = overlay.newFindings.length - 1;
		const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
		const lineList = overlay.newFindings
			.slice(0, 5)
			.map((f) => `L${f.line}`)
			.join(", ");
		return {
			decision: "block",
			reason:
				`BLOCKED by strict-typing pre-overlay: this edit introduces ${overlay.newFindings.length} new type-erasure pattern(s) in ${filePath} (${lineList}). ` +
				`First: [${nonNull(first).ruleId}] L${nonNull(first).line} — ${nonNull(first).message}${restSummary}. ` +
				"Fix the pattern(s) in your edit, or retry without introducing them. " +
				"Justification escapes are accepted: `// @ts-expect-error: <reason>` for suppression directives.",
			warnings,
			rule_id: STRICT_TYPING_RULE_ID,
			severity: "high",
			category: "pre-block",
		};
	}
	const strictTypingDecision = strictTypingOverlayGuard();
	if (strictTypingDecision) return { kind: "block", decision: strictTypingDecision };

	// ─────────────────────────────────────────────
	// PreToolUse registry gate — phase: "pre_warn"
	// ─────────────────────────────────────────────
	//
	// Phase B.4 — pass `preEditContent` so the diff-classifier can skip
	// warning-severity detectors on non-semantic edits (whitespace_only,
	// comment_only). Saves a regex pass on every doc tweak / re-format.
	function runPreWarnRegistry(): void {
		const preWarnChecks = buildAgentSafetyChecks(content, filePath, "pre_warn", preEditContent);
		const instructions = buildCheckInstructions();
		for (const check of preWarnChecks) {
			const matches = check.fn();
			if (matches.length === 0) continue;
			const lineList = matches.map((m) => `L${m.line}`).join(", ");
			const instruction = instructions[check.name] || "";
			warnings.push(
				`[interlinked:${check.name}] ${filePath} has ${matches.length} violation(s) at ${lineList} — ${instruction}`,
			);
		}
	}
	runPreWarnRegistry();

	// Legacy TS/JS/MJS/CJS + cross-language content-quality regex heuristics.
	warnings.push(...collectContentQualityWarnings(filePath, content, event.cwd));

	return { kind: "ok", warnings, escalation };
}
