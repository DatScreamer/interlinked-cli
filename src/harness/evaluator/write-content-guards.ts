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
import { resolveProposedContent } from "../overlay-content.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { collectContentQualityWarnings } from "./write-content-guards-content-quality.js";
import {
	injectionGuard as runInjectionGuard,
	jsonAndClaudeSettingsGuard as runJsonAndClaudeSettingsGuard,
	pathAndFormatGuard as runPathAndFormatGuard,
	type WriteContentGuardState,
} from "./write-content-basic-guards.js";
import {
	biomeDiffOverlayGuard as runBiomeDiffOverlayGuard,
	preBlockRegistryGuard as runPreBlockRegistryGuard,
	runPreWarnRegistry,
	strictTypingOverlayGuard as runStrictTypingOverlayGuard,
	tscDiffOverlayGuard as runTscDiffOverlayGuard,
} from "./write-content-overlay-guards.js";

export { buildTscDiffOverlayBlockReason } from "./write-content-tsc-guidance.js";

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
	/** False on the daemon/cold-hook PreTool path. Transactional CLI callers
	 * run overlays directly through content-gate/multi-edit after admission. */
	externalOverlays?: boolean;
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
	const externalOverlays = args.externalOverlays ?? true;
	const warnings: string[] = [];
	let escalation = args.pendingEscalation;

	const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
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
	const state: WriteContentGuardState = {
		toolName,
		filePath,
		content,
		preEditContent,
		postEditContent,
		event,
		rules,
		session,
		externalOverlays,
		warnings,
		escalation,
	};

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
	const injectionBlock = runInjectionGuard(state);
	escalation = state.escalation;
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
	const settingsBlock = runJsonAndClaudeSettingsGuard(state);
	if (settingsBlock) return { kind: "block", decision: settingsBlock };

	// Cheap path/format guards that block unconditionally: path traversal /
	// system-directory writes (../, /etc/, /usr/), binary-file extensions, and
	// A1 merge-conflict markers (a guaranteed parse error).
	const pathFormatBlock = runPathAndFormatGuard(state);
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
	const preBlockDecision = runPreBlockRegistryGuard(state);
	if (preBlockDecision) return { kind: "block", decision: preBlockDecision };

	// ─────────────────────────────────────────────
	// PreToolUse diff-overlay gate — biome (Phase 2a)
	// ─────────────────────────────────────────────
	const biomeDecision = runBiomeDiffOverlayGuard(state);
	if (biomeDecision) return { kind: "block", decision: biomeDecision };

	// ─────────────────────────────────────────────
	// PreToolUse diff-overlay gate — tsc LanguageService (Phase 2b)
	// ─────────────────────────────────────────────
	const tscDecision = runTscDiffOverlayGuard(state);
	if (tscDecision) return { kind: "block", decision: tscDecision };

	// ─────────────────────────────────────────────
	// PreToolUse strict-typing diff overlay (gated, default off)
	// ─────────────────────────────────────────────
	// Hard-blocks edits that introduce new type-erasure patterns: `as any`,
	// `as unknown as` chains, unjustified `@ts-ignore` / `@ts-expect-error`,
	// and bare `: any` annotations. The post-edit `as_any_ratchet` warning
	// stays in place when this flag is off; this gate moves the same metric
	// to PreToolUse + hard-block when teams want stricter enforcement.
	const strictTypingDecision = runStrictTypingOverlayGuard(state);
	if (strictTypingDecision) return { kind: "block", decision: strictTypingDecision };

	// ─────────────────────────────────────────────
	// PreToolUse registry gate — phase: "pre_warn"
	// ─────────────────────────────────────────────
	//
	// Phase B.4 — pass `preEditContent` so the diff-classifier can skip
	// warning-severity detectors on non-semantic edits (whitespace_only,
	// comment_only). Saves a regex pass on every doc tweak / re-format.
	runPreWarnRegistry(state);

	// Legacy TS/JS/MJS/CJS + cross-language content-quality regex heuristics.
	warnings.push(...collectContentQualityWarnings(filePath, content, event.cwd));

	return { kind: "ok", warnings, escalation };
}
