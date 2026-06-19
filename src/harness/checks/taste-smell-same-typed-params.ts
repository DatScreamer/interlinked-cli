// interlinked-tdd: exempt
// Taste check: same-typed adjacent primitive params (positional-swap hazard).
// Extracted from taste-smell.ts to keep that module under the line cap.

import { getExtension, type InlineMatch, isTestFile, stripCommentsAndStrings } from "./shared.js";

// Conventional name-pairs that are not orderable-by-mistake in practice.
// Module-level so it is built once, not per call. Kept small on purpose — grow
// it from real-world false positives, not speculation.
const SAME_TYPED_NAME_ALLOWLIST = new Set([
	"x",
	"y",
	"z",
	"r",
	"g",
	"b",
	"a", // alpha channel (RGBA)
	"w",
	"h",
	"width",
	"height",
	"i",
	"j",
	"k",
	"lat",
	"lng",
	"lon",
	"long",
	"latitude",
	"longitude",
	"min",
	"max",
]);

// Top-level function declarations / arrow assignments must be exported to be
// public. `function foo(...)` without `export` is internal-by-default in an ES
// module. Module-level so it is built once.
const EXPORTED_FUNCTION_PATTERNS: RegExp[] = [
	// export function foo(...), export async function foo(...)
	/^\s*export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	// export default function foo(...)
	/^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)?\s*(?:<[^>]*>)?\s*\(/,
	// export const foo = (...) => ..., export const foo = async (...) => ...
	/^\s*export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
];

interface ExportedClassScope {
	inExportedClass: boolean;
	classBraceDepth: number;
	openBraces: number;
}

/**
 * Advance exported-class scope tracking by one source line. Detects the opening
 * of an exported class, tallies brace depth on the (already stripped) line so
 * brace literals in strings/comments don't drift the count, and closes the
 * class scope when depth falls back to the class's opening level. Returns the
 * updated scope — pure apart from the returned value.
 */
function trackExportedClassScope(line: string, prev: ExportedClassScope): ExportedClassScope {
	let { inExportedClass, classBraceDepth, openBraces } = prev;
	const trimmed = line.trim();
	// Match `export class Foo`, `export default class Foo`, `export abstract class Foo`.
	if (
		!inExportedClass &&
		/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+\w+/.test(trimmed)
	) {
		inExportedClass = true;
		classBraceDepth = openBraces;
	}
	for (const ch of line) {
		if (ch === "{") openBraces++;
		else if (ch === "}") openBraces--;
	}
	if (inExportedClass && openBraces <= classBraceDepth) {
		inExportedClass = false;
		classBraceDepth = 0;
	}
	return { inExportedClass, classBraceDepth, openBraces };
}

/**
 * Identify the public function/method name a signature line introduces, or
 * `null` when the line is not a flagged surface. Three shapes count: exported
 * top-level function / arrow assignment (via `EXPORTED_FUNCTION_PATTERNS`), and
 * — only when inside an exported class — a public method (no
 * `private`/`protected`/`#`, not a getter/setter/constructor, not a control-flow
 * keyword with the same shape).
 */
function identifyPublicFunctionName(trimmed: string, inExportedClass: boolean): string | null {
	for (const pat of EXPORTED_FUNCTION_PATTERNS) {
		const m = trimmed.match(pat);
		if (m) return m[1] ?? "<anonymous>";
	}
	if (!inExportedClass) return null;
	// Method shape: `methodName(...)`, `public methodName(...)`, `async ...`,
	// `static ...`. Class field arrow methods `name = (...) =>` count too.
	const methodMatch = trimmed.match(
		/^\s*(?:public\s+|static\s+|async\s+|readonly\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/,
	);
	if (
		methodMatch &&
		!/^\s*(?:private|protected|#|get\s|set\s|constructor\b)/.test(trimmed) &&
		// Avoid control-flow keywords with the same shape: `if (`, `while (`, etc.
		!/^\s*(?:if|while|for|switch|return|throw|catch|else|do|try|new)\b/.test(trimmed) &&
		methodMatch[1] !== "constructor"
	) {
		return methodMatch[1];
	}
	return null;
}

/**
 * Scan a parsed parameter list for the first pair of adjacent same-typed
 * primitives that is orderable-by-mistake, returning a description of the pair
 * or `null` when none qualifies. Pairs where both names are in the allowlist
 * (`x`/`y`, `min`/`max`, …) are exempt; `null`-typed params (rest, destructure,
 * branded, union, array, generic) never pair.
 */
function findFirstSameTypedPair(
	parsed: ParsedParam[],
): { type: string; left: string; right: string } | null {
	for (let p = 0; p < parsed.length - 1; p++) {
		const left = parsed[p];
		const right = parsed[p + 1];
		if (!left || !right) continue;
		if (left.type === null || right.type === null) continue;
		if (left.type !== right.type) continue;
		const leftLower = left.name.toLowerCase();
		const rightLower = right.name.toLowerCase();
		if (SAME_TYPED_NAME_ALLOWLIST.has(leftLower) && SAME_TYPED_NAME_ALLOWLIST.has(rightLower))
			continue;
		return { type: left.type, left: left.name, right: right.name };
	}
	return null;
}

/**
 * Detect exported / public-method signatures that take 2+ adjacent parameters
 * of the same primitive type (`string`, `number`, `boolean`). Callers can swap
 * positional arguments at the call site with no help from the type system —
 * `transfer(fromId, toId, amount)` lets `transfer(toId, fromId, amount)`
 * compile cleanly. The fix is types-that-make-illegal-states-unrepresentable:
 * branded types (`type UserId = string & { __brand: 'UserId' }`) or a single
 * struct parameter destructured by name.
 *
 * Only flags two consecutive same-typed primitives in the same function/method
 * signature. We work from the surface annotation, not a resolved alias chain —
 * `(a: UserId, b: AccountId)` does NOT fire even when both alias to `string`,
 * because the cold reader sees distinct types at the call site.
 *
 * FP controls (the allowlist is the load-bearing FP lever):
 * - Only public surfaces: top-level `export function`, `export const ... = (...)`,
 *   `public ...(...)` methods in exported classes.
 * - Skip test files.
 * - Skip well-known orderable-by-name pairs: `x/y/z` (coords),
 *   `r/g/b/a` (colors), `w/h` / `width/height`, `lat/lng/lon/long/latitude/
 *   longitude`, `i/j/k` (indices), `min/max`. When BOTH same-typed param
 *   names are in this set, the pair is exempt — `setPoint(x: number, y: number)`
 *   doesn't fire. Conservative on purpose: a tiny allowlist is easier to grow
 *   than to retract.
 * - Skip rest params (`...args: string[]`) and array params (`string[]`) — the
 *   ordering risk is one parameter, not two.
 *
 * Only runs on `.ts`, `.tsx`, `.mts`, `.cts` (needs the surface annotation).
 */
export function checkSameTypedPrimitiveParams(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Track exported-class scope so we can flag public methods. Methods on
	// non-exported classes don't have a public surface outside the module.
	let scope: ExportedClassScope = {
		inExportedClass: false,
		classBraceDepth: 0,
		openBraces: 0,
	};

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = lines[i].trim();
		scope = trackExportedClassScope(lines[i], scope);

		// Identify the function/method signature start point (exported top-level
		// function/arrow, or a public method inside an exported class).
		const funcName = identifyPublicFunctionName(trimmed, scope.inExportedClass);
		if (!funcName) continue;

		// Collect the full parameter list, balancing nested parens / brackets /
		// braces / angle brackets. The signature may wrap across many lines.
		const params = collectParamList(lines, i);
		if (!params) continue;

		// Find the first adjacent same-typed-primitive pair. One finding per
		// signature is enough — don't double-report a `(a, b, c)` string triple.
		const pair = findFirstSameTypedPair(parseParamPrimitives(params));
		if (!pair) continue;
		matches.push({
			line: i + 1,
			text: `[2 same-typed ${pair.type} params (${pair.left}, ${pair.right}) → use branded types or a struct param] ${originalLines[i].trim().slice(0, 100)}`,
		});
	}

	return matches;
}

/**
 * Collect a parenthesized parameter list starting at the opening `(` of a
 * function signature on `lines[startIdx]`. Balances nested parens, brackets,
 * braces, and angle-brackets (generic params). Reads up to 20 subsequent
 * lines — long enough for any sane signature, short enough to never run away.
 * Returns the joined param-list contents (without surrounding parens) or
 * `null` if the signature can't be closed within the window.
 */
function collectParamList(lines: string[], startIdx: number): string | null {
	const first = lines[startIdx];
	const openIdx = first.indexOf("(");
	if (openIdx < 0) return null;
	let depthParen = 0;
	let depthAngle = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	let buf = "";
	let started = false;
	for (let i = startIdx; i < Math.min(startIdx + 20, lines.length); i++) {
		const line = lines[i];
		const startCol = i === startIdx ? openIdx : 0;
		for (let k = startCol; k < line.length; k++) {
			const ch = line[k];
			if (ch === "(") {
				depthParen++;
				if (depthParen === 1 && !started) {
					started = true;
					continue;
				}
			} else if (ch === ")") {
				depthParen--;
				if (depthParen === 0 && started) {
					return buf;
				}
			} else if (ch === "<") depthAngle++;
			else if (ch === ">") depthAngle = Math.max(0, depthAngle - 1);
			else if (ch === "{") depthBrace++;
			else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
			else if (ch === "[") depthBracket++;
			else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
			if (started) buf += ch;
		}
		buf += " ";
		// Sanity: if the depths are way off the signature isn't well-formed.
		if (depthAngle > 4 || depthBrace > 4 || depthBracket > 4) return null;
	}
	return null;
}

interface ParsedParam {
	name: string;
	/** Surface primitive type or null when not a flagged primitive. */
	type: "string" | "number" | "boolean" | null;
}

/**
 * Parse a parameter-list buffer into ordered entries with name + surface
 * primitive type. Splits on top-level commas (respecting nested
 * parens/brackets/braces/angle-brackets). For each entry, looks for the
 * pattern `name: <primitive>` where `<primitive>` is exactly `string`,
 * `number`, or `boolean` at the surface (no aliases, no unions, no `| undefined`,
 * no `string[]`, no `Promise<string>`). Rest params and untyped params parse
 * to `type: null` so they don't pair with anything.
 */
function parseParamPrimitives(paramStr: string): ParsedParam[] {
	const out: ParsedParam[] = [];
	const parts: string[] = [];
	let buf = "";
	let depth = 0;
	for (const ch of paramStr) {
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		if (ch === "," && depth === 0) {
			parts.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim().length > 0) parts.push(buf);

	for (const part of parts) {
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		// Rest param — orderable-by-mistake doesn't apply to a single rest.
		if (/^\.\.\./.test(trimmed)) {
			out.push({ name: "<rest>", type: null });
			continue;
		}
		// Destructured param (`{ a, b }: T`) — no single name to pair with;
		// the type annotation describes a struct, not a primitive.
		if (/^\{/.test(trimmed) || /^\[/.test(trimmed)) {
			out.push({ name: "<destructure>", type: null });
			continue;
		}
		// Match: `[modifiers ]?name[?]: <annotation>[= default]`. The annotation
		// runs until `=` (default value) or end of part. Modifiers covers
		// constructor-parameter properties (`public name: string`); we won't
		// reach those here since we skip constructors, but support is cheap.
		const m = trimmed.match(
			/^(?:public\s+|private\s+|protected\s+|readonly\s+)*(\w+)\s*\??\s*:\s*([^=]+?)\s*(?:=|$)/,
		);
		if (!m) {
			out.push({ name: trimmed.split(/[\s:?]/)[0] || "<unknown>", type: null });
			continue;
		}
		const name = m[1];
		const annotation = m[2].trim();
		// Surface-primitive match: must be exactly `string` / `number` /
		// `boolean`, no unions, no arrays, no generics, no `| undefined` etc.
		let type: "string" | "number" | "boolean" | null = null;
		if (annotation === "string") type = "string";
		else if (annotation === "number") type = "number";
		else if (annotation === "boolean") type = "boolean";
		out.push({ name, type });
	}
	return out;
}
