// PII detection + mixed error strategy check.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
} from "./shared.js";

// ===========================================
// PII Detection
// ===========================================

/** A PII pattern definition with an optional skip pattern for false positive suppression. */
export interface PiiPattern {
	name: string;
	pattern: RegExp;
	skip?: RegExp;
	severity?: "low" | "medium" | "high" | "critical";
}

/** Default-on patterns: high signal, low noise */
const DEFAULT_PII_PATTERNS: PiiPattern[] = [
	{
		name: "ssn",
		pattern: /\b\d{3}-\d{2}-\d{4}\b/,
		skip: /0{3}-0{2}|123-45|000-|666-|9\d{2}-/,
		severity: "high",
	},
];

/** Opt-in patterns: useful but noisy without per-project tuning */
const OPTIN_PII_PATTERNS: PiiPattern[] = [
	{
		name: "email",
		pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
		skip: /noreply|example\.com|test\.com|localhost|users\.noreply|@types|@param|@returns/,
		severity: "medium",
	},
	{
		name: "phone_us",
		pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
		skip: /port|timeout|0{3}|version|127\.|192\.|\.0\.|\.ts:|\.js:/,
		severity: "medium",
	},
	{
		name: "ip_address",
		pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/,
		skip: /127\.0\.0\.1|0\.0\.0\.0|255\.255|10\.0\.|172\.1[6-9]\.|192\.168\./,
		severity: "low",
	},
];

/** Files to skip entirely for PII detection (test fixtures, examples, config) */
function isPiiExcludedFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	if (isTestFile(filePath)) return true;
	if (normalized.endsWith(".env.example")) return true;
	if (normalized.includes("/fixtures/")) return true;
	if (normalized.includes("/mock")) return true;
	if (normalized.includes("/seed")) return true;
	if (normalized.includes("/testdata/")) return true;
	return false;
}

/**
 * Detect PII patterns in source code.
 * Default-on: SSN (high signal). Opt-in: email, phone, IP (need per-project tuning).
 * Skips test files, fixtures, .env.example, mock data.
 * Custom patterns and opt-in selection via config.
 */
export function checkPiiInSource(
	content: string,
	filePath: string,
	opts?: {
		optIn?: string[];
		customPatterns?: Array<{ name: string; pattern: string; severity?: string }>;
	},
): InlineMatch[] {
	if (isPiiExcludedFile(filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Collect active patterns
	const activePatterns: PiiPattern[] = [...DEFAULT_PII_PATTERNS];

	// Add opt-in patterns
	if (opts?.optIn) {
		for (const name of opts.optIn) {
			const found = OPTIN_PII_PATTERNS.find((p) => p.name === name);
			if (found) activePatterns.push(found);
		}
	}

	// Add custom patterns from config (validated: max 200 chars, must compile)
	if (opts?.customPatterns) {
		for (const cp of opts.customPatterns) {
			if (typeof cp.pattern !== "string" || cp.pattern.length > 200) continue;
			try {
				// Reason: opts.customPatterns is admin-authored config;
				// length-capped at 200 and compile failures fall through.
				// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
				const compiled = new RegExp(cp.pattern);
				activePatterns.push({
					name: cp.name,
					pattern: compiled,
					severity: (cp.severity as PiiPattern["severity"]) || "medium",
				});
			} catch {
				// intentional: drop user-supplied patterns that fail to
				// compile rather than aborting the whole rule load.
			}
		}
	}

	for (const piiPattern of activePatterns) {
		for (let i = 0; i < strippedLines.length; i++) {
			if (matches.length >= 20) return matches;
			const line = nonNull(strippedLines[i]);
			if (!piiPattern.pattern.test(line)) continue;
			// Check skip pattern for false positive suppression
			if (piiPattern.skip?.test(line)) continue;
			// Skip lines that document the format (e.g., "format: EMP-XXXXXX")
			if (/format:|example:|e\.g\.|placeholder|XXXX|sample/i.test(line)) continue;
			matches.push({
				line: i + 1,
				text: `[pii:${piiPattern.name}] ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect functions that use mixed error strategies — both `throw` and
 * `return { error }` / `return { success: false }` in the same function body.
 *
 * Callers cannot know whether to try/catch or check the return value,
 * leading to unhandled errors in either direction. This is the core problem
 * that Result types solve: a single, consistent error channel.
 *
 * Only flags when BOTH patterns appear in the same function. A file that
 * consistently uses one strategy throughout is fine.
 *
 * Skips: test files, type definition files, files < 5 lines.
 */
export function checkMixedErrorStrategy(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (content.split("\n").length < 5) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Walk through lines, tracking function boundaries via brace depth
	let funcStartLine = -1;
	let funcDepth = 0;
	let inFunc = false;
	let throwLines: number[] = [];
	let returnErrorLines: number[] = [];

	const FUNC_START =
		/(?:^|[\s;])(?:(?:export\s+)?(?:async\s+)?function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>|(?:async\s+)?\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)/;
	const THROW_PAT = /\bthrow\s+(?:new\s+\w+|err|e|error)\b/;
	const RETURN_ERROR_PAT =
		/\breturn\s+\{[^}]*(?:success\s*:\s*false|error\s*:|err\s*:)|return\s+(?:null|undefined)\s*;?\s*\/\/.*error/i;

	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);

		// Detect function start
		if (!inFunc && FUNC_START.test(line) && line.includes("{")) {
			inFunc = true;
			funcStartLine = i;
			funcDepth = 0;
			throwLines = [];
			returnErrorLines = [];
		}

		if (inFunc) {
			// Track brace depth
			for (const ch of line) {
				if (ch === "{") funcDepth++;
				if (ch === "}") funcDepth--;
			}

			// Only flag throw/return-error at the function's own level (depth 1)
			// or one level in (if/else/try blocks at depth 2). Skip deeply nested.
			if (funcDepth >= 1 && funcDepth <= 2) {
				if (THROW_PAT.test(line)) throwLines.push(i);
				if (RETURN_ERROR_PAT.test(line)) returnErrorLines.push(i);
			}

			// Function ended
			if (funcDepth <= 0) {
				if (throwLines.length > 0 && returnErrorLines.length > 0) {
					// Report on the function start line
					const funcLine = nonNull(originalLines[funcStartLine]).trim().slice(0, 120);
					matches.push({
						line: funcStartLine + 1,
						text: `mixed error strategy: function both throws (L${nonNull(throwLines[0]) + 1}) and returns error object (L${nonNull(returnErrorLines[0]) + 1}): ${funcLine}`,
					});
				}
				inFunc = false;
				if (matches.length >= 5) break;
			}
		}
	}

	return matches;
}
