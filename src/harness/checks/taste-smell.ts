// Taste checks — part 2 of 2 (magic numbers, ternaries, flag args, commented-out code).
// Extracted from taste.ts to stay under the 800-line module ceiling.

import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * Detect magic numbers in logic — numeric literals without named constants.
 * `if (retries > 3)` — why 3? `setTimeout(fn, 86400000)` — what is that?
 *
 * Only flags numbers in conditionals and expressions, not declarations.
 * Skips: 0, 1, -1, 2, common HTTP status codes, powers of 2, test files,
 * array indices, and numbers in const/enum declarations.
 */
export function checkMagicNumbers(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Numbers that are universally acceptable without a name
	const ALLOWED = new Set([
		"0",
		"1",
		"2",
		"-1",
		"-2",
		"10",
		"16",
		"100",
		"1000",
		// HTTP status codes
		"200",
		"201",
		"204",
		"301",
		"302",
		"304",
		"400",
		"401",
		"403",
		"404",
		"405",
		"409",
		"422",
		"429",
		"500",
		"502",
		"503",
		"504",
		// Powers of 2
		"8",
		"32",
		"64",
		"128",
		"256",
		"512",
		"1024",
		"2048",
		"4096",
	]);

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		const trimmed = line.trim();

		// Skip declarations — the number IS the named constant
		if (/^\s*(const|let|var|enum|static\s+(readonly\s+)?)\b/.test(trimmed)) continue;

		// Skip return statements returning bare numbers (often intentional)
		if (/^\s*return\s+-?\d/.test(trimmed)) continue;

		// Skip case labels
		if (/^\s*case\s+-?\d/.test(trimmed)) continue;

		// Must be in a conditional, expression, or function call context
		// (not just any line with a number)
		if (
			!/\b(if|else|while|for|switch|&&|\|\||[<>=!]+|[+\-*/%])\b/.test(trimmed) &&
			!/\w+\s*\(/.test(trimmed)
		)
			continue;

		// Find bare numeric literals
		const numPattern = /(?<![.\w])(-?\d+(?:\.\d+)?)\b/g;
		const numHits = line.matchAll(numPattern);
		let flaggedLine = false;
		for (const numMatch of numHits) {
			if (flaggedLine) break;
			const num = numMatch[1];
			if (ALLOWED.has(num)) continue;

			// Skip if it's an array index: [123]
			const before = line.slice(Math.max(0, numMatch.index! - 1), numMatch.index);
			if (before === "[") continue;

			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			flaggedLine = true;
		}
	}

	return matches;
}

/**
 * Detect `if (!condition) { ... } else { ... }` — negated condition with else.
 * The reader must mentally double-negate. Just flip the branches.
 *
 * Only flags simple negation of a single identifier (not complex expressions).
 * Skips: if blocks without else, complex negated expressions like !(a && b).
 */
export function checkNegatedConditionWithElse(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Match: if (!identifier) or if (!identifier.property)
		if (!/\bif\s*\(\s*!\s*\w+[\w.]*\s*\)/.test(line)) continue;

		// Must have a corresponding else — scan ahead for } else
		let braceDepth = 0;
		let foundElse = false;
		let scanDone = false;
		for (let j = i; j < Math.min(i + 50, strippedLines.length) && !scanDone; j++) {
			const scanLine = strippedLines[j];
			for (let k = 0; k < scanLine.length; k++) {
				if (scanLine[k] === "{") braceDepth++;
				if (scanLine[k] === "}") {
					braceDepth--;
					// The moment the if-block closes, check for else
					if (braceDepth === 0 && (j > i || k > 0)) {
						const remaining = scanLine.slice(k + 1);
						if (/\belse\b/.test(remaining)) {
							foundElse = true;
						} else if (
							j + 1 < strippedLines.length &&
							/^\s*else\b/.test(strippedLines[j + 1])
						) {
							foundElse = true;
						}
						scanDone = true;
						break;
					}
				}
			}
		}

		if (!foundElse) continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect nested ternary expressions.
 * `a ? b ? c : d : e` is a puzzle, not code.
 * Use if/else or extract into a function.
 */
export function checkNestedTernary(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Quick check: line must have at least 2 question marks
		const qCount = (line.match(/\?/g) || []).length;
		if (qCount < 2) continue;

		// Verify nesting: walk through and track ternary depth
		// Skip ?. (optional chaining) and generic type params <T>
		let ternaryDepth = 0;
		let maxTernaryDepth = 0;
		let inGeneric = 0;

		for (let j = 0; j < line.length; j++) {
			const ch = line[j];
			if (ch === "<") inGeneric++;
			if (ch === ">") inGeneric = Math.max(0, inGeneric - 1);
			if (inGeneric > 0) continue;

			// Skip optional chaining ?.
			if (ch === "?" && j + 1 < line.length && line[j + 1] === ".") continue;
			// Skip nullish coalescing ??
			if (ch === "?" && j + 1 < line.length && line[j + 1] === "?") {
				j++; // skip next ?
				continue;
			}

			if (ch === "?") {
				ternaryDepth++;
				maxTernaryDepth = Math.max(maxTernaryDepth, ternaryDepth);
			}
			if (ch === ":") {
				if (ternaryDepth > 0) ternaryDepth--;
			}
		}

		if (maxTernaryDepth >= 2) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}

	return matches;
}

/**
 * Detect function signatures with 2+ boolean parameters.
 * Definition-side companion to checkBooleanTrap (which catches call sites).
 *
 * When a function has multiple boolean params, callers will always pass
 * unlabeled `true`/`false`. Use an options object instead.
 *
 * Only runs on TypeScript (requires type annotations to detect boolean params).
 * Skips test files.
 */
export function checkFlagArguments(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	// Only TS — need type annotations to detect boolean params reliably
	if (![".ts", ".tsx", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const funcPatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
		/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
	];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = lines[i].trim();

		let funcName: string | null = null;
		for (const pat of funcPatterns) {
			const m = trimmed.match(pat);
			if (m) {
				funcName = m[1];
				break;
			}
		}
		if (!funcName) continue;

		// Collect the full signature
		const sig = collectFunctionSignature(lines, i);
		const paramMatch = sig.match(/\(([^)]*)\)/);
		if (!paramMatch) continue;

		// Count params with `: boolean` type annotation
		const params = paramMatch[1].split(",");
		let boolParamCount = 0;
		for (const p of params) {
			// Match: paramName: boolean or paramName?: boolean
			if (/:\s*boolean\s*(?:[,=)]|$)/.test(p)) {
				boolParamCount++;
			}
		}

		if (boolParamCount >= 2) {
			matches.push({
				line: i + 1,
				text: `[${boolParamCount} boolean params → use options object] ${originalLines[i].trim().slice(0, 100)}`,
			});
		}
	}

	return matches;
}

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

/**
 * Classify a single uncommented line (comment prefix already stripped).
 *
 * Returns:
 *   - "code": an actual executable statement someone disabled — a real
 *     keyword statement, an assignment with a real value, a bare call,
 *     a closing/opening brace of such a statement, a block terminator.
 *   - "doc": prose or illustrative content — words, type unions (`|`),
 *     `<placeholder>` brackets, bare `key: type` annotations, `...`
 *     ellipsis used as prose, parentheticals like `(e.g. ...)`. The
 *     presence of *any* doc line vetoes the whole block.
 *   - "neutral": blank, a divider, or a line that is neither — does not
 *     count toward the code ratio either way.
 *
 * The detector fires only on a strong majority of "code" lines with zero
 * "doc" lines, so it can never flag a documentation comment, an ASCII
 * diagram, or an illustrative type/shape example.
 */
function classifyCommentLine(raw: string, isPython = false): "code" | "doc" | "neutral" {
	const line = raw.trim();
	if (line === "") return "neutral";

	// Divider / ASCII-art lines — pure punctuation runs, no real tokens.
	if (/^[=\-*~_#+.|/\\<>\s]+$/.test(line)) return "neutral";

	// --- Doc markers (any one of these vetoes the block) ---------------

	// Type unions / pipe-separated alternatives (`a | b | c`, `string | null`).
	// Real code rarely puts ` | ` mid-line outside a type position; doc shape
	// examples use it constantly. (Python bitwise-or is rare in commented code
	// and would still need a doc-free majority elsewhere — acceptable veto.)
	if (/\s\|\s/.test(line)) return "doc";
	// Angle-bracket placeholders: `<original native event name>`, `<T>` as prose.
	// A `<...>` span containing a space is a natural-language placeholder, not
	// a generic type argument (those have no spaces: `Array<string>`).
	if (/<[^<>]*\s[^<>]*>/.test(line)) return "doc";
	// Ellipsis used as prose ("...event-specific fields", "etc. ...").
	if (line.includes("...")) return "doc";
	// Prose parentheticals: "(e.g. ...)", "(see ...)", "(per the design ...)".
	if (/\((?:e\.g\.|i\.e\.|see\b|per\b|note\b|or\b|and\b|matches\b|with\b)/i.test(line))
		return "doc";
	// A bare `key: type` annotation — illustrative shape line, no value, no
	// terminator. JS/TS only: in Python `:` ends a compound-statement header
	// (`if x:`, `def f():`) which is real code, so skip this veto there.
	if (
		!isPython &&
		/^[A-Za-z_$][\w$]*\s*\??:\s*[A-Za-z_$]/.test(line) &&
		!/[;,{]\s*$/.test(line)
	) {
		// Object-literal entries end in `,` or `{`; `case Foo:` starts with the
		// `case` keyword (caught as code below). Anything left is a bare type
		// annotation → doc.
		return "doc";
	}

	// --- Real-code markers ---------------------------------------------

	// Statement keywords at the start of the line.
	const jsKeywords =
		/^(const|let|var|function|async\s+function|class|interface|enum|type\s+[A-Za-z]|import|export|return|throw|await|yield|if|else|for|while|do|switch|case\s|default:|try|catch|finally|break|continue|new\s|delete\s)\b/;
	const pyKeywords =
		/^(def|class|import|from\s|return|raise|yield|await|async\s+def|if|elif|else|for|while|with|try|except|finally|break|continue|pass|global|nonlocal|assert|del|lambda\b)\b/;
	if ((isPython ? pyKeywords : jsKeywords).test(line)) return "code";

	if (isPython) {
		// Python: statements are newline-terminated. An assignment with a
		// real right-hand side: `data = request.json()`, `x = 3`.
		if (/^[\w$.[\]]+\s*[-+*/%|&^]?=\s*\S/.test(line) && !/[=<>!]=\s*$/.test(line))
			return "code";
		// A bare call statement: `save(data)`, `obj.run(a, b)`.
		if (/^[\w$]+(?:\.[\w$]+)*\([^)]*\)\s*$/.test(line)) return "code";
		return "neutral";
	}

	// JS/TS: assignment with a real right-hand side ending in a terminator:
	// `x = foo();`  `this.y = 3;`  `obj.k = "v";`
	if (/^[\w$.[\]]+\s*[-+*/|&^]?=\s*\S.*[;,]\s*$/.test(line)) return "code";
	// A bare function/method call statement: `doThing();`  `obj.run(a, b);`
	if (/^[\w$]+(?:\.[\w$]+)*\([^)]*\)\s*;?\s*$/.test(line)) return "code";
	// A line that ends in a semicolon and contains a call or assignment — a
	// disabled statement that didn't match the tighter patterns above.
	if (/;\s*$/.test(line) && /[\w$]\s*[=(]/.test(line)) return "code";
	// A lone block-closer that belongs to disabled code: `}`, `};`, `});`,
	// `} else {`. A lone `{` is too ambiguous (shape examples open with it),
	// so an opening brace only counts when preceded by code on the same line.
	if (/^\}[\s;)]*[,;]?\s*(else\b.*)?$/.test(line)) return "code";

	return "neutral";
}

/**
 * Detect blocks of commented-out code (3+ consecutive lines).
 * Commented-out code rots, confuses grep, and makes the real code harder to scan.
 * Use version control instead of comment-preservation.
 *
 * Fires only when a comment block is a strong majority of real executable
 * statements AND contains zero documentation markers. Documentation comments,
 * ASCII diagrams, illustrative type/shape examples, JSDoc blocks, license
 * headers, and prose with incidental code-like punctuation are never flagged.
 */
export function checkCommentedOutCode(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py"].includes(ext))
		return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// JSDoc/documentation patterns to skip — line never counts, but unlike a
	// "doc" classification it does not by itself veto the block (a stray
	// `// NOTE:` next to real disabled code should not save the block).
	const docPattern =
		/^\s*\/\/\s*(@\w+|@param|@returns|@throws|@example|@see|@todo|TODO|FIXME|NOTE|HACK|XXX)\b/i;
	// License/header patterns — same: skipped, non-vetoing.
	const licensePattern = /^\s*\/\/\s*(copyright|license|MIT|Apache|BSD|GPL|all rights reserved)/i;

	const isPython = ext === ".py";
	const commentPrefix = isPython ? /^\s*#\s?/ : /^\s*\/\/\s?/;

	let blockStart = -1;
	let codeLineCount = 0;
	let totalLineCount = 0;
	let docLineCount = 0;

	const flushBlock = () => {
		// Need 3+ comment lines, a strong code majority, and zero doc lines.
		// A single doc/prose/shape line vetoes the block — bias hard toward
		// not firing, since comments are useful and false positives at
		// edit-time are especially annoying.
		if (blockStart !== -1 && totalLineCount >= 3 && docLineCount === 0) {
			// Require at least 3 lines that are unambiguously real code, not
			// just a >60% ratio of a short block. Two code lines plus a blank
			// is no longer enough to fire.
			const codeRatio = totalLineCount > 0 ? codeLineCount / totalLineCount : 0;
			if (codeLineCount >= 3 && codeRatio > 0.6) {
				matches.push({
					line: blockStart + 1,
					text: `[${totalLineCount} lines of commented-out code → use version control instead]`,
				});
			}
		}
		blockStart = -1;
		codeLineCount = 0;
		totalLineCount = 0;
		docLineCount = 0;
	};

	for (let i = 0; i <= originalLines.length; i++) {
		if (matches.length >= 5) break;

		const line = i < originalLines.length ? originalLines[i] : "";
		const isComment = commentPrefix.test(line);

		if (isComment) {
			if (blockStart === -1) blockStart = i;
			totalLineCount++;
			// JSDoc / license lines are skipped entirely — neither code nor
			// veto. The block continues across them.
			if (docPattern.test(line) || licensePattern.test(line)) continue;
			const uncommented = line.replace(commentPrefix, "");
			const kind = classifyCommentLine(uncommented, isPython);
			if (kind === "code") codeLineCount++;
			else if (kind === "doc") docLineCount++;
		} else {
			flushBlock();
		}
	}

	return matches;
}
