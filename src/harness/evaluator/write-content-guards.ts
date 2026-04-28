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
import { buildAgentSafetyChecks, buildCheckInstructions } from "../check-registry/index.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
} from "../diff-overlay.js";
import { resolveProposedContent } from "../overlay-content.js";
import { findProjectRoot } from "../quality-checks.js";
import { scanPromptInjection } from "../signatures.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";

/** Minimum content length before we bother scanning for prompt injections. */
const INJECTION_SCAN_MIN_CHARS = 10;

/** Extension regex for binary file formats we block text editors from writing to. */
const BINARY_FILE_EXTENSIONS =
	/\.(png|jpe?g|gif|bmp|ico|webp|avif|svg|woff2?|ttf|otf|eot|wasm|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|o|a|pyc|class|jar|mp3|mp4|wav|ogg|webm|mov|avi|db|sqlite|sqlite3)$/i;

/** Merge-conflict marker regex: any of <<<<<<<, =======, >>>>>>> at a line head. */
const MERGE_CONFLICT_MARKER = /^<{7}\s|^={7}$|^>{7}\s/m;

/** TS/JS/MJS/CJS file extensions that trigger the legacy content-quality heuristics. */
const JS_TS_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;

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

	// PreToolUse injection scanning: catch injection content before it hits disk
	if (content.length > INJECTION_SCAN_MIN_CHARS) {
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
	if (filePath.endsWith(".json") && content.trim()) {
		try {
			JSON.parse(content);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(
				`[interlinked] Warning: Invalid JSON in ${filePath}: ${msg.slice(0, 100)}`,
			);
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
			const first = blocking[0];
			const rest = blocking.length - 1;
			const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						`BLOCKED by tsc diff-overlay: this edit introduces ${blocking.length} new type error(s) in ${filePath}. ` +
						`First: [${first.ruleId}] L${first.line}:${first.column ?? 1} — ${first.message}${restSummary}. ` +
						"Fix the type error(s) in your edit, or retry without introducing them.",
					warnings,
					rule_id: "tsc-diff-overlay",
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
	warnings.push(...collectContentQualityWarnings(filePath, content));

	return { kind: "ok", warnings, escalation };
}

/** Content-quality regex checks shared across all languages plus a TS/JS-only block.
 *  Pure function over `(filePath, content)` — callers append to their warning list. */
function collectContentQualityWarnings(filePath: string, content: string): string[] {
	const warnings: string[] = [];

	// TS/JS content checks
	if (JS_TS_EXTENSIONS.test(filePath) && content.length > INJECTION_SCAN_MIN_CHARS) {
		warnings.push(...collectTsJsQualityWarnings(filePath, content));
	}

	// A7: Hardcoded non-localhost URLs (all file types, skip test/config files)
	if (!/\.(test|spec|config|fixture)\.\w+$/.test(filePath) && !filePath.includes("__tests__")) {
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

	// A10: Regex DoS — nested quantifiers
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

	// Warn on unsafe type assertions
	const asAnyCount = (content.match(/\bas\s+any\b/g) || []).length;
	const asUnknownCount = (content.match(/\bas\s+unknown\b/g) || []).length;
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
	// A3: Math.random in security context
	if (
		/\bMath\.random\b/.test(content) &&
		/\b(token|secret|password|key|nonce|salt|hash|crypto|auth)\b/i.test(content)
	) {
		warnings.push(
			`[interlinked:content-quality] Math.random() used alongside security-related code in ${filePath}. Use crypto.randomUUID() or crypto.getRandomValues() instead.`,
		);
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
