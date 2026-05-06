// Error-handling taste checks (bare catch, untyped catch, throw-as-control-flow, etc).
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Taste Enforcement: Error Handling Quality
// ===========================================
// These checks push agents toward explicit, composable error handling
// and away from patterns that silently lose error context.

/** Detect bare catch blocks: catch {} or catch with only a comment inside */
export function checkBareCatchBlock(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext) && ext !== ".py") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// JS/TS: catch (...) { } or catch { } on same line
		if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
			matches.push({
				line: i + 1,
				text: `bare catch block silently swallows error: ${line.trim().slice(0, 100)}`,
			});
			continue;
		}
		// catch block with only a comment inside
		if (/\bcatch\s*(\([^)]*\))?\s*\{/.test(line) && i + 2 < lines.length) {
			const next = lines[i + 1].trim();
			const afterNext = lines[i + 2].trim();
			if (
				(next.startsWith("//") || next.startsWith("/*") || next === "") &&
				afterNext === "}"
			) {
				matches.push({
					line: i + 1,
					text: `catch block with only a comment — error is silently ignored: ${line.trim().slice(0, 100)}`,
				});
			}
		}
		// Python: except: pass / except Exception: pass
		if (ext === ".py" && /\bexcept\b.*:\s*$/.test(line) && i + 1 < lines.length) {
			const next = lines[i + 1].trim();
			if (next === "pass" || next === "...") {
				matches.push({
					line: i + 1,
					text: `bare except/pass silently swallows error: ${line.trim().slice(0, 100)}`,
				});
			}
		}
		if (matches.length >= 10) break;
	}

	return matches;
}

/** Detect catch-and-return-null: catch (e) { return null/undefined } — lossy error handling */
export function checkCatchReturnNull(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let inCatch = false;
	let catchLine = 0;
	let catchDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/\bcatch\s*(\([^)]*\))?\s*\{/.test(line)) {
			inCatch = true;
			catchLine = i;
			// Start at depth 1 — we're already inside the catch block's opening brace.
			// Count additional braces from the NEXT line to avoid the `} catch {` line
			// where the closing `}` of try and opening `{` of catch net to zero.
			catchDepth = 1;
			continue;
		}
		if (inCatch) {
			for (const ch of line) {
				if (ch === "{") catchDepth++;
				if (ch === "}") catchDepth--;
			}
			if (/\breturn\s+(null|undefined)\s*;?/.test(line)) {
				const catchText = lines[catchLine].trim().slice(0, 80);
				matches.push({
					line: i + 1,
					text: `return null/undefined in catch — error context is lost: ${catchText}`,
				});
			}
			if (catchDepth <= 0) inCatch = false;
		}
		if (matches.length >= 10) break;
	}

	return matches;
}

/** Detect throw-as-control-flow: throwing for expected conditions (not found, validation) */
export function checkThrowAsControlFlow(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const CONTROL_FLOW_THROWS =
		/\bthrow\s+new\s+(?:Error|TypeError|RangeError)\s*\(\s*["'`](?:not found|invalid|missing|expected|no such|does not exist|cannot find|failed to)/i;

	for (let i = 0; i < lines.length; i++) {
		if (CONTROL_FLOW_THROWS.test(lines[i])) {
			matches.push({
				line: i + 1,
				text: `throw for expected condition — return a Result or error value instead: ${originalLines[i].trim().slice(0, 120)}`,
			});
		}
		if (matches.length >= 5) break;
	}

	return matches;
}

/** Detect untyped catch: catch (e) without type narrowing or instanceof check */
export function checkUntypedCatch(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const catchMatch = lines[i].match(/\bcatch\s*\(\s*(\w+)\s*\)\s*\{/);
		if (!catchMatch) continue;

		const varName = catchMatch[1];
		let hasNarrowing = false;
		const endSearch = Math.min(i + 10, lines.length);
		for (let j = i + 1; j < endSearch; j++) {
			const jLine = lines[j];
			if (jLine.includes("}") && !jLine.includes("{")) break;
			if (
				jLine.includes("instanceof") ||
				jLine.includes(`${varName}._tag`) ||
				jLine.includes(`${varName}.code`) ||
				jLine.includes(`typeof ${varName}`) ||
				/\bas\s+\w+Error\b/.test(jLine)
			) {
				hasNarrowing = true;
				break;
			}
		}

		if (!hasNarrowing) {
			matches.push({
				line: i + 1,
				text: `untyped catch(${varName}) without narrowing — use instanceof, tagged errors, or error codes: ${originalLines[i].trim().slice(0, 100)}`,
			});
		}
		if (matches.length >= 5) break;
	}

	return matches;
}

/** Detect error string comparison: if (err.message === "...") — fragile pattern */
export function checkErrorStringComparison(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripComments(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const ERR_MSG_CMP = /\.message\s*===?\s*["'`]|\.message\.includes\s*\(\s*["'`]/;

	for (let i = 0; i < lines.length; i++) {
		if (ERR_MSG_CMP.test(lines[i])) {
			matches.push({
				line: i + 1,
				text: `comparing error.message string — fragile, use error codes or instanceof instead: ${originalLines[i].trim().slice(0, 120)}`,
			});
		}
		if (matches.length >= 5) break;
	}

	return matches;
}

/**
 * Detect catch blocks that throw a fresh `new Error(...)` (or any `*Error`
 * subclass constructor) without forwarding the caught exception via the
 * ES2022 `{ cause: e }` option. Loses the original stack trace and breaks
 * `error.cause`-chain inspection downstream — the same shape the
 * "Errors Deserve Better" post (April 2026) flags as the lie-of-omission
 * around error rethrow.
 *
 * Fires on:
 *   catch (e) { throw new Error("wrapped"); }
 *   catch (e) { throw new TypeError(`bad: ${e}`); }
 *   catch (err) { logger.error(err); throw new HttpError("upstream"); }
 *
 * Skips:
 *   - `throw e` / `throw err` (cause already preserved by reference)
 *   - `throw new Error("msg", { cause: e })` and friends
 *   - `throw new MyError({ cause }, ...)` shorthand
 *   - `catch { ... }` with no caught variable (nothing to preserve)
 *   - test files (legitimate throw-and-rethrow patterns in fixtures)
 *
 * Args of the throw expression are scanned with strings/comments blanked,
 * so a `cause` token inside a template-literal body never silences the check.
 */
export function checkLossyErrorRethrow(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	// Comments-only strip preserves string positions for accurate line numbers,
	// while string-strip is applied per-throw to the args window so a `cause:`
	// substring inside a template literal can't false-skip the check.
	const stripped = stripComments(content);
	const blanked = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const catchOpenRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
	const ERROR_CTOR_RE =
		/\bthrow\s+new\s+(?:[A-Z][A-Za-z0-9_$]*Error|Error|TypeError|RangeError|SyntaxError|EvalError|URIError|AggregateError)\s*\(/g;

	let openMatch: RegExpExecArray | null = catchOpenRe.exec(stripped);
	while (openMatch !== null) {
		if (matches.length >= 10) break;
		const catchVar = openMatch[1];
		const openIdx = openMatch.index + openMatch[0].length - 1;

		let depth = 1;
		let closeIdx = -1;
		for (let i = openIdx + 1; i < stripped.length; i++) {
			const ch = stripped[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					closeIdx = i;
					break;
				}
			}
		}
		if (closeIdx < 0) {
			openMatch = catchOpenRe.exec(stripped);
			continue;
		}

		const bodyStart = openIdx + 1;
		ERROR_CTOR_RE.lastIndex = bodyStart;
		let throwMatch: RegExpExecArray | null = ERROR_CTOR_RE.exec(stripped);
		while (throwMatch !== null && throwMatch.index < closeIdx) {
			if (matches.length >= 10) break;

			const argsStart = throwMatch.index + throwMatch[0].length;
			let pdepth = 1;
			let argsEnd = -1;
			for (let i = argsStart; i < stripped.length && i < closeIdx; i++) {
				const ch = stripped[i];
				if (ch === "(") pdepth++;
				else if (ch === ")") {
					pdepth--;
					if (pdepth === 0) {
						argsEnd = i;
						break;
					}
				}
			}
			if (argsEnd < 0) break;

			const argsBlanked = blanked.slice(argsStart, argsEnd);
			const preservesCause = /\bcause\s*[:,}]/.test(argsBlanked);
			if (!preservesCause) {
				const lineNum = stripped.slice(0, throwMatch.index).split("\n").length;
				matches.push({
					line: lineNum,
					text: `throw new Error in catch(${catchVar}) without { cause: ${catchVar} } — original stack lost: ${(originalLines[lineNum - 1] ?? "").trim().slice(0, 100)}`,
				});
			}
			throwMatch = ERROR_CTOR_RE.exec(stripped);
		}

		openMatch = catchOpenRe.exec(stripped);
	}

	return matches;
}

/** Detect inconsistent error strategy in a single file: mix of throw + return { error } + return null */
export function checkInconsistentErrorStrategy(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (content.split("\n").length < 20) return [];

	const stripped = stripComments(content);

	const throwCount = (stripped.match(/\bthrow\s+new\s+\w*Error/g) || []).length;
	const returnNullCount = (stripped.match(/\breturn\s+null\s*;/g) || []).length;
	const returnErrorObjCount = (
		stripped.match(/\breturn\s+\{\s*(?:error|success\s*:\s*false)/g) || []
	).length;

	const strategies = [throwCount > 0, returnNullCount > 1, returnErrorObjCount > 0].filter(
		Boolean,
	).length;

	if (strategies >= 3) {
		return [
			{
				line: 1,
				text: `file uses ${strategies} different error strategies (throw: ${throwCount}, return null: ${returnNullCount}, return {error}: ${returnErrorObjCount}) — pick one approach, preferably Result types or typed error returns`,
			},
		];
	}

	return [];
}
