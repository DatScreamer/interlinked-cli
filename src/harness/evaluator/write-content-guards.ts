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
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { describeReason, findMalformedRulesIn, suggestRuleFix } from "../../lib/settings-validator.js";
import { buildAgentSafetyChecks, buildCheckInstructions } from "../check-registry/index.js";
import { isTestFile } from "../checks/shared.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
} from "../diff-overlay.js";
import { resolveProposedContent } from "../overlay-content.js";
import { findProjectRoot } from "../quality-checks.js";
import { scanPromptInjection } from "../signatures.js";
import { extractTemplateInterpolationExpressions, stripAllLiterals } from "../strip-helpers.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	STRICT_TYPING_RULE_ID,
	evaluateTypeErasureOverlay,
} from "./type-erasure-overlay.js";

/** Minimum content length before we bother scanning for prompt injections. */
const INJECTION_SCAN_MIN_CHARS = 10;

/** Extension regex for binary file formats we block text editors from writing to. */
const BINARY_FILE_EXTENSIONS =
	/\.(png|jpe?g|gif|bmp|ico|webp|avif|svg|woff2?|ttf|otf|eot|wasm|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|o|a|pyc|class|jar|mp3|mp4|wav|ogg|webm|mov|avi|db|sqlite|sqlite3)$/i;

/** Merge-conflict marker regex: any of <<<<<<<, =======, >>>>>>> at a line head. */
const MERGE_CONFLICT_MARKER = /^<{7}\s|^={7}$|^>{7}\s/m;

/** TS/JS/MJS/CJS file extensions that trigger the legacy content-quality heuristics. */
const JS_TS_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;

/** Identifiers that mark a value as a credential. The A3 Math.random() check
 *  fires only when one of these shares the Math.random() line — a whole-file
 *  scan for security-ish words made the check fire on any file containing a
 *  React `key={}` prop, a `location.hash`, or an A/B-test `pickVariant()`.
 *  Substring (not word-boundary) so camelCase compounds like `sessionToken`
 *  and `resetToken` match; bare `key`/`hash`/`auth`/`crypto` are deliberately
 *  excluded as far too common to be a reliable security signal. */
const A3_SECURITY_CONTEXT =
	/password|passwd|secret|token|credential|nonce|csrf|\bsalt\b|\bjwt\b|api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?key|session[_-]?id/i;

/** TS error codes that indicate the agent referenced a name unresolved in the
 *  current scope. The canonical signature of a multi-step refactor where the
 *  missing identifier is defined in a sibling edit that hasn't landed yet —
 *  retrying the same `Edit` repeatedly will keep tripping the per-edit overlay
 *  on each intermediate state. Cross-module "no exported member" codes
 *  (TS2305 / TS2724) are excluded: they more often indicate a real typo in
 *  the import path than a coordinated refactor. */
const MULTI_EDIT_REFACTOR_TSC_CODES = new Set(["TS2304", "TS2552"]);

interface TscBlockingFinding {
	ruleId?: string;
	line: number;
	column?: number;
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
		`First: [${first.ruleId}] L${first.line}:${first.column ?? 1} — ${first.message}${restSummary}. ` +
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
	| { kind: "ok"; warnings: string[]; escalation?: EscalationRequest };

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
	if (
		content.length > INJECTION_SCAN_MIN_CHARS &&
		!isContentScanExempt(filePath, cwd)
	) {
		const injectionMatches = scanPromptInjection(content);
		if (injectionMatches.length > 0) {
			const highConfidence = injectionMatches.some(
				(m) => m.severity === "critical" || m.severity === "high",
			);
			if (highConfidence) {
				return {
					kind: "block",
					decision: {
						decision: "block",
						reason: `BLOCKED: Prompt injection pattern detected in content being written to ${filePath}: ${injectionMatches[0].description}. This content may compromise agent behavior.`,
						warnings,
						rule_id: "pretooluse-injection-scan",
						severity: "critical",
						category: "Security",
					},
				};
			}
			// Lower-confidence match — set escalation for classifier
			escalation = {
				trigger: "post_injection_action",
				summary: `Partial prompt injection pattern detected in content for ${filePath}: ${injectionMatches[0].description}`,
				tool_name: toolName,
				tool_input_redacted: { file_path: filePath, content: "[REDACTED]" },
				sensitivity_level: session?.sensitivity_level || "Public",
				step_number: session?.tool_call_count || 0,
				recent_tool_sequence: session?.tool_sequence.slice(-10) || [],
			};
			warnings.push(
				`[interlinked:injection] Low-confidence injection pattern detected in ${filePath}: ${injectionMatches[0].description}`,
			);
		}
	}

	// Validate JSON files
	let parsedJson: unknown;
	if (filePath.endsWith(".json") && content.trim()) {
		try {
			parsedJson = JSON.parse(content);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(
				`[interlinked] Warning: Invalid JSON in ${filePath}: ${msg.slice(0, 100)}`,
			);
		}
	}

	// Claude Code settings: block writes that introduce malformed permission
	// rules (mismatched parens / unbalanced quotes / empty / no Tool prefix).
	// Claude Code's own /doctor skips these at load time, but the user is
	// left with a noisy allowlist file. Catching it at write time keeps the
	// file canonically clean regardless of source (agent edits, interlinked-cli
	// rewrites, or other tools — Claude Code's own "Always allow" UI doesn't
	// route through tool calls so it can't be intercepted here; that path is
	// covered by the verify-time scan in checkProjectSetup).
	if (isClaudeSettingsFile(filePath) && parsedJson !== undefined) {
		const malformed = findMalformedRulesIn(parsedJson);
		if (malformed.length > 0) {
			const first = malformed[0];
			const others = malformed.length > 1 ? ` (and ${malformed.length - 1} more)` : "";
			const suggestion = suggestRuleFix(first.rule, first.reason);
			const suggestionClause =
				suggestion !== null ? ` Did you mean ${JSON.stringify(suggestion)}?` : "";
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						`BLOCKED: Write to ${filePath} would add a malformed permission rule. ` +
						`permissions.${first.bucket}[${first.index}] = ${JSON.stringify(first.rule)} ` +
						`(${describeReason(first.reason)})${others}.${suggestionClause} ` +
						"Claude Code's /doctor would skip this rule at load time. " +
						"Fix the rule string (or remove it) before retrying.",
					warnings,
					rule_id: "permission-rule-syntax",
					severity: "high",
					category: "settings-integrity",
				},
			};
		}
	}

	// Detect path traversal (writing outside project directory)
	if (filePath.includes("../") || filePath.startsWith("/etc/") || filePath.startsWith("/usr/")) {
		return {
			kind: "block",
			decision: {
				decision: "block",
				reason: `BLOCKED: Writing to ${filePath} — path traversal or system directory write detected. Agents should only write within the project directory.`,
				warnings,
			},
		};
	}

	// Binary file guard — block writing text content to binary file extensions
	if (BINARY_FILE_EXTENSIONS.test(filePath)) {
		return {
			kind: "block",
			decision: {
				decision: "block",
				reason: `BLOCKED: ${filePath} is a binary file. Text editing tools should not write to binary formats — use the appropriate tool or command instead.`,
				warnings,
			},
		};
	}

	// A1: Merge conflict markers — guaranteed parse error, block immediately
	if (MERGE_CONFLICT_MARKER.test(content)) {
		return {
			kind: "block",
			decision: {
				decision: "block",
				reason: `BLOCKED: Merge conflict markers detected in ${filePath}. Resolve the conflict before writing.`,
				warnings,
			},
		};
	}

	// ─────────────────────────────────────────────
	// PreToolUse registry gate — phase: "pre_block"
	// ─────────────────────────────────────────────
	// Fully-deterministic, zero-FP errors. Blocks the write and forces
	// the agent to fix ALL instances of the rule in the target file
	// before retrying — not just the line it was editing.
	//
	// Phase B.4 — pass `preEditContent` so the diff-classifier can skip
	// warning-severity detectors on non-semantic edits. pre_block detectors
	// are all severity=error (e.g. eval_usage, promise_reject_non_error)
	// and STILL run regardless of diff_class, so a credential leaked into
	// a comment / quoted string is still caught.
	{
		const preBlockChecks = buildAgentSafetyChecks(
			content,
			filePath,
			"pre_block",
			preEditContent,
		);
		void postEditContent; // reserved for future hunk-granular pre_block
		const instructions = buildCheckInstructions();
		for (const check of preBlockChecks) {
			const matches = check.fn();
			if (matches.length > 0) {
				const lineList = matches.map((m) => `L${m.line}`).join(", ");
				const instruction = instructions[check.name] || "";
				return {
					kind: "block",
					decision: {
						decision: "block",
						reason:
							`BLOCKED by pre-block rule [${check.name}]. ` +
							`${filePath} contains ${matches.length} violation(s) at ${lineList}. ` +
							"Fix ALL instances of this rule in this file before retrying your edit — " +
							`not just the line you were changing.\n${instruction}`,
						warnings,
						rule_id: check.name,
						severity: "high",
						category: "pre-block",
					},
				};
			}
		}
	}

	// ─────────────────────────────────────────────
	// PreToolUse diff-overlay gate — biome (Phase 2a)
	// ─────────────────────────────────────────────
	if (rules.quality_checks?.biome_lint?.enabled !== false) {
		const cwdForOverlay =
			findProjectRoot(filePath, event.cwd || process.cwd()) || event.cwd || process.cwd();
		const overlay = evaluateBiomeDiffOverlay(filePath, content, cwdForOverlay);
		if (overlay.exceededBudget && overlay.newFindings.length > 0) {
			const first = overlay.newFindings[0];
			warnings.push(
				`[interlinked:biome-overlay] ${overlay.newFindings.length} new biome finding(s) in ${filePath} from this edit (first: ${first.message} at L${first.line}). Overlay ${overlay.elapsedMs}ms exceeded 500ms budget — demoted to warning.`,
			);
		} else if (overlay.newFindings.length > 0) {
			const first = overlay.newFindings[0];
			const rest = overlay.newFindings.length - 1;
			const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						`BLOCKED by biome diff-overlay: this edit introduces ${overlay.newFindings.length} new biome finding(s) in ${filePath}. ` +
						`First: [${first.ruleId ?? "biome"}] L${first.line} — ${first.message}${restSummary}. ` +
						"Fix the new issue(s) in your edit, or retry without introducing them.",
					warnings,
					rule_id: "biome-diff-overlay",
					severity: "high",
					category: "pre-block",
				},
			};
		}
	}

	// ─────────────────────────────────────────────
	// PreToolUse diff-overlay gate — tsc LanguageService (Phase 2b)
	// ─────────────────────────────────────────────
	if (rules.quality_checks?.typescript?.enabled !== false) {
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
		if (blocking.length > 0) {
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason: buildTscDiffOverlayBlockReason(toolName, blocking, filePath),
					warnings,
					rule_id: "tsc-diff-overlay",
					severity: "high",
					category: "pre-block",
				},
			};
		}
	}

	// ─────────────────────────────────────────────
	// PreToolUse strict-typing diff overlay (gated, default off)
	// ─────────────────────────────────────────────
	// Hard-blocks edits that introduce new type-erasure patterns: `as any`,
	// `as unknown as` chains, unjustified `@ts-ignore` / `@ts-expect-error`,
	// and bare `: any` annotations. The post-edit `as_any_ratchet` warning
	// stays in place when this flag is off; this gate moves the same metric
	// to PreToolUse + hard-block when teams want stricter enforcement.
	if (rules.quality_checks?.strict_typing_block?.enabled === true) {
		const overlay = evaluateTypeErasureOverlay(filePath, content);
		if (overlay.newFindings.length > 0) {
			const first = overlay.newFindings[0];
			const rest = overlay.newFindings.length - 1;
			const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
			const lineList = overlay.newFindings
				.slice(0, 5)
				.map((f) => `L${f.line}`)
				.join(", ");
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						`BLOCKED by strict-typing pre-overlay: this edit introduces ${overlay.newFindings.length} new type-erasure pattern(s) in ${filePath} (${lineList}). ` +
						`First: [${first.ruleId}] L${first.line} — ${first.message}${restSummary}. ` +
						"Fix the pattern(s) in your edit, or retry without introducing them. " +
						"Justification escapes are accepted: `// @ts-expect-error: <reason>` for suppression directives.",
					warnings,
					rule_id: STRICT_TYPING_RULE_ID,
					severity: "high",
					category: "pre-block",
				},
			};
		}
	}

	// ─────────────────────────────────────────────
	// PreToolUse registry gate — phase: "pre_warn"
	// ─────────────────────────────────────────────
	//
	// Phase B.4 — pass `preEditContent` so the diff-classifier can skip
	// warning-severity detectors on non-semantic edits (whitespace_only,
	// comment_only). Saves a regex pass on every doc tweak / re-format.
	{
		const preWarnChecks = buildAgentSafetyChecks(
			content,
			filePath,
			"pre_warn",
			preEditContent,
		);
		const instructions = buildCheckInstructions();
		for (const check of preWarnChecks) {
			const matches = check.fn();
			if (matches.length > 0) {
				const lineList = matches.map((m) => `L${m.line}`).join(", ");
				const instruction = instructions[check.name] || "";
				warnings.push(
					`[interlinked:${check.name}] ${filePath} has ${matches.length} violation(s) at ${lineList} — ${instruction}`,
				);
			}
		}
	}

	// Legacy TS/JS/MJS/CJS + cross-language content-quality regex heuristics.
	warnings.push(...collectContentQualityWarnings(filePath, content, event.cwd));

	return { kind: "ok", warnings, escalation };
}

/**
 * Files where regex-based content-quality scans produce only false positives:
 * the dangerous patterns appear AS DATA (rule definitions, test fixtures),
 * not as live code. Scanning them turns every legitimate use of "chmod 777",
 * "Access-Control-Allow-Origin: *", or a nested-quantifier regex string into
 * a misleading warning. The exemption is path-based because content-based
 * disambiguation (is-this-inside-a-string-literal?) requires a real parser
 * for a marginal gain.
 *
 * Exempt:
 *  - Documentation / prose files (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`,
 *    `.adoc`). These routinely contain regex examples, "chmod 777" in
 *    tutorials, sample URLs, etc. — all as documentation, not code.
 *  - Interlinked CLI's own rule definition files (`src/harness/rules/**`,
 *    `check-registry/**`) via the shared package-root-scoped `isTestFile()`
 *    exemption. User projects with similarly named directories are still scanned.
 *  - Test fixtures: `*.test.*`, `*.spec.*`, files under `__tests__/`
 *  - Config/fixture sentinels: `*.config.*`, `*.fixture.*`
 *
 * Real bugs in test files still surface via tsc/biome/eslint — those run
 * regardless. Only the regex-driven content-quality heuristics are skipped.
 */
function isContentScanExempt(filePath: string, cwd: string | undefined): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	if (/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(normalized)) return true;
	if (/\.(config|fixture)\.\w+$/.test(normalized)) return true;
	if (isTestFile(normalized)) return true;
	if (!isAbsolute(filePath) && cwd && isTestFile(resolve(cwd, filePath))) return true;
	return false;
}

/** A file whose entire job is to hold constant data — `consts.ts`,
 *  `constants.ts`, and the language-agnostic equivalents. URLs in such a file
 *  are committed content (canonical links, OG images, social handles), not
 *  deployment config, so the A7 "move to env vars" advice does not apply.
 *  Stem-only exact match: a `constants.py` qualifies, an `app-constants.ts`
 *  intentionally does not (kept tight so A7 still fires on real logic files). */
function isUrlDataFile(filePath: string): boolean {
	const base = (filePath.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
	const stem = base.replace(/\.[^.]+$/, "");
	return stem === "const" || stem === "consts" || stem === "constant" || stem === "constants";
}

/** Content-quality regex checks shared across all languages plus a TS/JS-only block.
 *  Pure function over `(filePath, content)` — callers append to their warning list. */
function collectContentQualityWarnings(
	filePath: string,
	content: string,
	cwd: string | undefined,
): string[] {
	const warnings: string[] = [];

	// Files in this list legitimately contain dangerous-looking strings as
	// data — short-circuit the entire content-quality scan for them.
	if (isContentScanExempt(filePath, cwd)) return warnings;

	// TS/JS content checks
	if (JS_TS_EXTENSIONS.test(filePath) && content.length > INJECTION_SCAN_MIN_CHARS) {
		warnings.push(...collectTsJsQualityWarnings(filePath, content));
	}

	// A7: Hardcoded non-localhost URLs (all file types).
	// Path-based exemption already handled above. Dedicated constant/content
	// modules (consts.ts, constants.ts) legitimately hold URLs as committed
	// data, so they are exempt from this one check.
	if (!isUrlDataFile(filePath)) {
		const urlMatches = content.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"'`>)}\]]+/g);
		if (urlMatches && urlMatches.length > 3) {
			warnings.push(
				`[interlinked:content-quality] ${urlMatches.length} hardcoded URLs in ${filePath}. Consider using configuration or environment variables.`,
			);
		}
	}

	// A8: SQL injection patterns — template literal interpolation in SQL
	if (/\.(tsx?|jsx?|py)$/.test(filePath)) {
		if (
			/\.exec\s*\(\s*`[^`]*\$\{/.test(content) ||
			/\.query\s*\(\s*`[^`]*\$\{/.test(content) ||
			/\bsql\s*`[^`]*\$\{/.test(content)
		) {
			warnings.push(
				`[interlinked:content-quality] Possible SQL injection in ${filePath}. Use parameterized queries instead of template literal interpolation.`,
			);
		}
	}

	// A9: Overly permissive CORS/chmod
	if (
		/Access-Control-Allow-Origin:\s*\*/.test(content) ||
		/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/.test(content)
	) {
		warnings.push(
			`[interlinked:content-quality] Wildcard CORS (Access-Control-Allow-Origin: *) in ${filePath}. Restrict to specific origins in production.`,
		);
	}
	if (/\bchmod\s+777\b/.test(content) || /\b0o777\b/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] chmod 777 / 0o777 in ${filePath}. Use more restrictive permissions.`,
		);
	}

	// A10: Regex DoS — nested quantifiers. Fires on `(...)[+*]` in the raw
	// content. The check is intentionally a coarse shape-match: the goal is
	// to surface every nested-quantifier regex in user source so the agent
	// considers backtracking complexity. Files designed to DETECT ReDoS (e.g.
	// the validator at `src/harness/redos-validation.ts`) deliberately contain
	// such shapes as pattern data; they are a known-FP class and accept the
	// noise as the cost of broad coverage elsewhere.
	if (/\([^)]*[+*][^)]*\)[+*]/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] Potential ReDoS pattern (nested quantifiers) in ${filePath}. Simplify the regex to avoid catastrophic backtracking.`,
		);
	}

	// A11: JSDoc premature close — "*/" inside a single-line JSDoc body
	// (e.g., glob "**/*.ext" where ** + / = * + */ terminates the comment early).
	const singleLineJsdocRe = /\/\*\*(.+)\*\//g;
	for (
		let jsdocMatch = singleLineJsdocRe.exec(content);
		jsdocMatch !== null;
		jsdocMatch = singleLineJsdocRe.exec(content)
	) {
		if (jsdocMatch[1].includes("*/")) {
			const lineNum = content.slice(0, jsdocMatch.index).split("\n").length;
			warnings.push(
				`[interlinked:content-quality] JSDoc at line ${lineNum} in ${filePath} contains "*/" which prematurely closes the comment. Glob patterns like "**/*.ext" break parsers (tsc, biome, esbuild). Rephrase to avoid "*/" sequences.`,
			);
			break;
		}
	}

	return warnings;
}

/** TS/JS-specific content-quality heuristics (A2-A6 plus the older as-any / console.log set). */
function collectTsJsQualityWarnings(filePath: string, content: string): string[] {
	const warnings: string[] = [];

	// Warn on unsafe type assertions. Scan comment- and string-stripped
	// content: a real `as any` / `as unknown` cast is always code, so the
	// bare words inside a doc comment (e.g. "Count of `as any` casts") or a
	// string literal are not assertions — counting those was a recurring FP
	// on type-definition files that document the ratchet metrics.
	const interpolationCode = extractTemplateInterpolationExpressions(content)
		.map((expr) => stripAllLiterals(expr))
		.join("\n");
	const codeOnly = `${stripAllLiterals(content)}\n${interpolationCode}`;
	const asAnyCount = (codeOnly.match(/\bas\s+any\b/g) || []).length;
	const asUnknownCount = (codeOnly.match(/\bas\s+unknown\b/g) || []).length;
	const parts: string[] = [];
	if (asAnyCount > 0) parts.push(`${asAnyCount} "as any"`);
	if (asUnknownCount > 0) parts.push(`${asUnknownCount} "as unknown"`);
	if (parts.length > 0) {
		warnings.push(
			`[interlinked:content-quality] ${parts.join(" + ")} assertion(s) in ${filePath}. Prefer proper typing (interfaces, generics, branded types).`,
		);
	}
	// Warn on console.log left in production code (not test files)
	if (!/\.(test|spec)\.\w+$/.test(filePath)) {
		const consoleLogs = (content.match(/\bconsole\.(log|debug|info)\b/g) || []).length;
		if (consoleLogs > 2) {
			warnings.push(
				`[interlinked:content-quality] ${consoleLogs} console.log statements in ${filePath}. Remove debug logging before committing.`,
			);
		}
	}
	// Warn on unresolved task markers (to-do, fix-me, etc.) in new code
	const taskMarkerPattern = /\b(TO(?:DO)|FIX(?:ME)|HA(?:CK)|X(?:XX))\b/g;
	const taskMarkers = (content.match(taskMarkerPattern) || []).length;
	if (taskMarkers > 0) {
		warnings.push(
			`[interlinked:content-quality] ${taskMarkers} unresolved task marker${taskMarkers > 1 ? "s" : ""} in ${filePath}. Resolve before committing or create a tracking issue.`,
		);
	}
	// Warn on empty catch blocks
	if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] Empty catch block in ${filePath}. Silent error swallowing hides bugs — at minimum log the error.`,
		);
	}
	// A2: eval / Function constructor
	if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) {
		warnings.push(
			`[interlinked:content-quality] eval() or new Function() in ${filePath}. These enable code injection — use safer alternatives.`,
		);
	}
	// A3: Math.random() feeding a security-sensitive value (predictable
	// tokens). Scoped to the Math.random() line itself (plus the line above,
	// for multi-line assignments): a whole-file scan fired on any file that
	// merely contained "key"/"hash"/"auth" elsewhere — a React `key={}` prop
	// or an A/B-test `pickVariant()` that uses Math.random() for bucketing,
	// where crypto-grade randomness is genuinely unnecessary.
	const a3Lines = content.split("\n");
	for (let i = 0; i < a3Lines.length; i++) {
		if (!/\bMath\.random\b/.test(a3Lines[i])) continue;
		const ctx = (i > 0 ? `${a3Lines[i - 1]}\n` : "") + a3Lines[i];
		if (A3_SECURITY_CONTEXT.test(ctx)) {
			warnings.push(
				`[interlinked:content-quality] Math.random() used to derive a security-sensitive value in ${filePath} (line ${i + 1}). Use crypto.randomUUID() or crypto.getRandomValues() instead.`,
			);
			break;
		}
	}
	// A4: Floating promises — async-named calls without await/void/return/.then/.catch
	const floatingPromisePattern =
		/^\s*(?!.*\b(await|void|return)\b)(?!.*\.(then|catch|finally)\s*\().*\b\w*(Async|async)\w*\s*\(/gm;
	const floatingMatches = content.match(floatingPromisePattern);
	if (floatingMatches && floatingMatches.length > 0) {
		warnings.push(
			`[interlinked:content-quality] ${floatingMatches.length} potential floating promise(s) in ${filePath}. Add await, void, or .catch() to handle rejections.`,
		);
	}
	// A5: JSON.parse without try-catch
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/\bJSON\.parse\s*\(/.test(lines[i])) {
			// Check preceding 5 lines for try
			const preceding = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
			if (!/\btry\s*\{/.test(preceding)) {
				warnings.push(
					`[interlinked:content-quality] JSON.parse() without try-catch at line ${i + 1} in ${filePath}. Wrap in try-catch to handle malformed input.`,
				);
				break; // One warning is enough
			}
		}
	}
	// A6: Import/require mixing
	if (!/\.cjs$/.test(filePath)) {
		const hasImport = /\bimport\s+/.test(content);
		const hasRequire = /\brequire\s*\(/.test(content);
		if (hasImport && hasRequire) {
			warnings.push(
				`[interlinked:content-quality] Mixed import/require in ${filePath}. Use one module system consistently (prefer ES imports).`,
			);
		}
	}

	return warnings;
}
