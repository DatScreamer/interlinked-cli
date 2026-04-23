// Error-handling taste checks (bare catch, untyped catch, throw-as-control-flow, etc).
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
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
