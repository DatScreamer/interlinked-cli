// Deletion hygiene — zombie code detectors.
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Deletion Hygiene — Zombie Code Detectors
// ===========================================
// These checks detect code that should have been deleted but wasn't.
// AI agents systematically hedge on deletion: they stub instead of remove,
// add deprecation ceremony instead of deleting, hollow out tests instead
// of removing them, and narrate deletions in comments. These patterns
// are never shippable and indicate an incomplete deletion.

/**
 * Detect "not implemented" / "TODO" / "stub" throw statements.
 * `throw new Error("Not implemented")` is never shippable — the agent punted.
 *
 * Also detects: `throw new Error("TODO")`, `throw new Error("stub")`,
 * `throw "not implemented"`, `// TODO: implement` on an otherwise empty function.
 *
 * Skips test files (test stubs are sometimes intentional).
 */
export function checkNotImplementedStubs(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Match the original lines (we need the string content), but skip comment-only lines
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = originalLines[i];
		const strippedLine = strippedLines[i].trim();

		// Skip if the line is entirely a comment (stripped content is empty)
		if (strippedLine.length === 0 && line.trim().length > 0) continue;

		// Pattern 1: throw new Error("Not implemented|TODO|stub|...")
		if (
			/\bthrow\s+new\s+Error\s*\(\s*["'`](not\s*implemented|todo|stub|fixme|unimplemented|needs?\s*implementation)/i.test(
				line,
			)
		) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			continue;
		}

		// Pattern 2: throw "not implemented" (bare string throw)
		if (/\bthrow\s+["'`](not\s*implemented|todo|stub)/i.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			continue;
		}

		// Pattern 3: return with a TODO/FIXME comment indicating incomplete implementation
		// e.g., `return null; // TODO: implement` or `return undefined; // FIXME`
		if (/\breturn\s+(null|undefined)\s*;?\s*\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}

	return matches;
}

/**
 * Detect functions/methods with empty bodies or trivial stub returns.
 * An exported function that does nothing is dead weight pretending to be alive.
 *
 * Detects:
 * - `function foo() {}`
 * - `function foo() { return undefined; }`
 * - `function foo() { return null; }`
 * - `foo() { return; }`
 * - Arrow functions: `const foo = () => {}`
 *
 * Skips: test files, abstract/interface declarations, catch blocks,
 * noop/_ prefixed functions, callback/handler stubs (onX, handleX with 0 lines),
 * .d.ts files, overload signatures.
 */
export function checkEmptyFunctionBody(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const funcPatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/,
		/(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/, // method syntax
	];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i].trim();

		let funcName: string | null = null;
		for (const pat of funcPatterns) {
			const m = line.match(pat);
			if (m) {
				funcName = m[1];
				break;
			}
		}
		if (!funcName) continue;

		// Skip noop/_ prefixed (intentional no-ops)
		if (funcName.startsWith("_") || funcName === "noop" || funcName === "NOOP") continue;
		// Skip abstract/interface context
		if (/\babstract\b/.test(line)) continue;
		// Skip constructors (may intentionally be empty for DI)
		if (funcName === "constructor") continue;

		// Check if body is empty or trivial stub
		// Collect the function body (up to 5 lines)
		let bodyContent = "";
		let braceDepth = 0;
		let started = false;
		for (let j = i; j < Math.min(i + 8, strippedLines.length); j++) {
			for (const ch of strippedLines[j]) {
				if (ch === "{") {
					started = true;
					braceDepth++;
				}
				if (ch === "}") braceDepth--;
			}
			if (started && j > i) {
				bodyContent = `${bodyContent}${strippedLines[j].trim()}\n`;
			}
			if (started && braceDepth === 0) break;
		}

		bodyContent = bodyContent.trim();

		// Empty body: just whitespace or closing brace
		const isEmptyBody = bodyContent === "" || bodyContent === "}";
		// Trivial stub: only `return null;` or `return undefined;` or `return;`
		const isStubReturn =
			/^(return\s*(null|undefined)\s*;?\s*\}?|return\s*;\s*\}?)$/m.test(bodyContent) &&
			bodyContent.split("\n").filter((l) => l.trim().length > 0 && l.trim() !== "}").length <=
				1;

		if (isEmptyBody || isStubReturn) {
			matches.push({
				line: i + 1,
				text: `[empty function body] ${originalLines[i].trim().slice(0, 120)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect deprecation ceremony — @deprecated annotations or deprecation warnings
 * on functions that have no real implementation.
 *
 * Legitimate: `@deprecated` on a working function (telling callers to migrate).
 * Zombie: `@deprecated` on an empty/stub function, or `console.warn("deprecated")`
 * added as the only logic. The agent added ceremony instead of deleting.
 */
export function checkDeprecationNotice(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = originalLines[i];

		// Pattern 1: console.warn/log with "deprecated" or "removed" in the message
		if (
			/\bconsole\.(warn|log)\s*\([^)]*\b(deprecated|removed|no\s*longer\s*(available|supported|exists?))\b/i.test(
				line,
			)
		) {
			matches.push({
				line: i + 1,
				text: `[deprecation ceremony — just delete it] ${line.trim().slice(0, 120)}`,
			});
			continue;
		}

		// Pattern 2: @deprecated JSDoc tag followed by an empty/stub function
		if (/@deprecated/i.test(line)) {
			// Scan ahead for the function and check if its body is empty/stub
			for (let j = i + 1; j < Math.min(i + 5, originalLines.length); j++) {
				const nextLine = originalLines[j].trim();
				if (/^(export\s+)?(async\s+)?function\s+\w+|^\w+\s*\(/.test(nextLine)) {
					// Found the function — check if body is trivial
					let bodyLines = 0;
					let braceDepth = 0;
					let bodyStarted = false;
					for (let k = j; k < Math.min(j + 8, originalLines.length); k++) {
						for (const ch of originalLines[k]) {
							if (ch === "{") {
								bodyStarted = true;
								braceDepth++;
							}
							if (ch === "}") braceDepth--;
						}
						if (bodyStarted && k > j) {
							const trimmedBody = originalLines[k].trim();
							if (trimmedBody.length > 0 && trimmedBody !== "}") bodyLines++;
						}
						if (bodyStarted && braceDepth === 0) break;
					}
					if (bodyLines <= 1) {
						matches.push({
							line: i + 1,
							text: `[@deprecated on empty/stub function — just delete it] ${nextLine.slice(0, 100)}`,
						});
					}
					break;
				}
				// Skip blank lines and other JSDoc lines
				if (nextLine.length > 0 && !nextLine.startsWith("*") && !nextLine.startsWith("//"))
					break;
			}
		}
	}

	return matches;
}

/**
 * Detect test blocks with empty bodies — tests that silently pass without
 * testing anything. The agent hollowed out the test instead of deleting it.
 *
 * Distinct from:
 * - checkAssertionFreeTests: catches tests with CODE but no assertions
 * - checkTestRegressions: catches it.skip / it.todo
 * This catches tests that LOOK active but have completely empty bodies.
 *
 * Detects:
 * - `it("...", () => {})`
 * - `it("...", () => { return; })`
 * - `it("...", function() {})`
 * - `test("...", () => {})`
 */
export function checkOrphanedTestStub(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Pattern: it( or test( on a line (not .skip, .todo, xit, xtest)
	const testOpenPattern = /\b(?:it|test)\s*\(\s*(?:["'`])/;
	const skipPattern = /\b(?:it|test)\s*\.\s*(?:skip|todo|only)\s*\(/;
	const xPattern = /\b(?:xit|xtest)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i].trim();

		if (!testOpenPattern.test(line)) continue;
		if (skipPattern.test(line) || xPattern.test(line)) continue;

		// Collect the test body
		let braceDepth = 0;
		let bodyStarted = false;
		let bodyContent = "";

		for (let j = i; j < Math.min(i + 10, strippedLines.length); j++) {
			for (const ch of strippedLines[j]) {
				if (ch === "{") {
					bodyStarted = true;
					braceDepth++;
				}
				if (ch === "}") braceDepth--;
			}
			if (bodyStarted && j > i) {
				bodyContent = `${bodyContent}${strippedLines[j].trim()} `;
			}
			if (bodyStarted && braceDepth <= 0) break;
		}

		bodyContent = bodyContent.trim();

		// Check if body is empty or trivial
		const isEmptyBody =
			bodyContent === "" ||
			bodyContent === "}" ||
			bodyContent === "}" + ")" + ";" || // });
			/^(return\s*;?\s*)?[});\s]*$/.test(bodyContent);

		if (isEmptyBody) {
			matches.push({
				line: i + 1,
				text: `[empty test body — delete the test or implement it] ${originalLines[i].trim().slice(0, 100)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect comments that narrate deletion — prose about what was removed,
 * what used to exist, or what "no longer" applies.
 *
 * These comments are dead weight: the git history records what was deleted.
 * Leaving narration comments clutters the code and confuses grep.
 *
 * Detects:
 * - `// Removed the old auth handler`
 * - `// Previously this called validateToken()`
 * - `// No longer needed`
 * - `// Was: oldFunction()`
 * - `// Deleted the X feature`
 *
 * Skips: TODO/FIXME comments, license headers, JSDoc annotations.
 */
export function checkDeletionComments(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py"].includes(ext))
		return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const isPython = ext === ".py";
	const commentPattern = isPython ? /^\s*#\s*(.+)/ : /^\s*\/\/\s*(.+)/;

	// Patterns that indicate deletion narration
	const deletionPatterns = [
		/\b(removed|deleted|stripped\s+out|ripped\s+out|gutted|eliminated)\s+(the|this|old|previous|legacy|unused|obsolete)\b/i,
		/\bpreviously\s+(this|we|it)\s+(called|used|had|was|relied)/i,
		/\bno\s+longer\s+(needed|used|required|necessary|exists?|supported|available)/i,
		/\bwas\s*:\s*\w+/i, // "Was: oldFunction()"
		/\bused\s+to\s+(call|use|have|be|return|import)/i,
		/\b(old|legacy|deprecated|obsolete)\s+\w+\s+(removed|deleted|stripped)/i,
		/\bthis\s+(was|used\s+to\s+be|has\s+been)\s+(removed|deleted|deprecated)/i,
	];

	// Skip patterns (legitimate comments that happen to use deletion vocabulary)
	const skipPatterns = [
		/^\s*(\/\/|#)\s*(TODO|FIXME|HACK|XXX|NOTE)\b/i,
		/^\s*(\/\/|#)\s*@/i, // JSDoc annotations
		/^\s*(\/\/|#)\s*(copyright|license|MIT|Apache)/i,
		/^\s*(\/\/|#)\s*eslint-disable/i,
		/^\s*(\/\/|#)\s*interlinked-ignore/i,
	];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = originalLines[i];

		// Must be a comment line
		const commentMatch = line.match(commentPattern);
		if (!commentMatch) continue;

		// Skip known non-deletion comment types
		if (skipPatterns.some((p) => p.test(line))) continue;

		// Check if the comment narrates a deletion
		const commentText = commentMatch[1];
		if (deletionPatterns.some((p) => p.test(commentText))) {
			matches.push({
				line: i + 1,
				text: `[deletion narration — git history records this] ${line.trim().slice(0, 120)}`,
			});
		}
	}

	return matches;
}
