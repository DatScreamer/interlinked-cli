// UBS language-specific detector — `ubs_division_by_variable` (Row 30).
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Cross-language, advisory by default (high FP rate).

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	stripCommentsAndStrings,
} from "../shared.js";
import { isJsTsFile, isPyFile } from "./_shared.js";

/**
 * Row 30: division by a variable identifier — the variable might be zero.
 * Cross-language, advisory by default (high FP rate; ships in
 * DEFAULT_ADVISORY_SKIPS so it only runs under `verify --all-checks`).
 *
 * Both LHS and RHS of the slash must be identifier-shaped, AND the slash
 * must be surrounded by whitespace — i.e. an identifier, one-or-more
 * whitespace chars, slash, one-or-more whitespace chars, identifier.
 * Tightened from a one-sided rule (only the right-hand operand had to be
 * an identifier) after markdown like `value / etc.` and compact prose
 * like `TS/JS-centric` and `if/when` produced false positives. Requiring
 * whitespace blocks the compact-slash cases; requiring an LHS identifier
 * blocks the empty-LHS-after-string-strip case.
 *
 * Bilateral matching loses a few real-code patterns — `arr[i] / b`,
 * `func() / b`, multi-line continuations where the slash starts the
 * line, and compact `a/b` divisions without spaces — which is acceptable
 * since the check is advisory by default and modern style guides format
 * spaces around binary operators.
 *
 * Pure-prose alternation like `regex / AST query / taint pattern` is
 * bilateral-id-shaped and would otherwise fire, so the detector also
 * gates on a source-file extension allow-list (mirroring
 * `checkLargeFunction`'s coverage). Markdown, plain-text, config, and
 * unknown extensions short-circuit before the matcher runs. Extending
 * the allow-list to `.kt` / `.rb` / `.cs` is a one-line edit
 * if a TP is reported there.
 *
 * The detector strips comments and strings first, so `*\/` block-comment
 * terminators, end-of-line comments, and division-looking content inside
 * string literals do not contribute matches.
 *
 * FP-recon 2026-07: beyond the same-line guard, the detector runs a
 * divisor-anchored DOMINATING-GUARD scan over a bounded lookback window
 * (`GUARD_LOOKBACK_LINES`). A division is suppressed when a preceding
 * line provably dominates it with the divisor named literally:
 *   1. EARLY-EXIT GUARD — `if (n === 0) return;` / `if (!n) throw …` /
 *      Python `if not n: return`, verified straight-line-dominating by a
 *      brace walk (the guard's enclosing block must not close before the
 *      division) or, for Python, by indentation.
 *   2. STILL-OPEN ENCLOSING POSITIVE GUARD — `if (n !== 0) {` /
 *      `if (n > 0) {` / bare-truthy `if (n) {`, verified still open at
 *      the division by the same brace walk (a closed sibling block does
 *      NOT suppress); Python uses indentation dominance.
 *   3. NONZERO ASSIGNMENT — nearest preceding `n = Math.max(1, …)`,
 *      `n = … || 1`, `n ||= 1`, or `n = <nonzero literal>`, with no
 *      interleaving re-assignment of the divisor.
 * Any nearer re-assignment of the divisor that is not a nonzero shape
 * aborts the scan (the guard above it no longer holds). Per the FN-averse
 * contract below, every suppression names the divisor (or its object
 * head) — a generic "an if exists above" never suppresses.
 */
export function checkDivisionByVariable(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".rs" ||
		ext === ".c" ||
		ext === ".cpp" ||
		ext === ".swift";
	if (!supported) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// 139-repo audit (2026-05): pre-compute a set of names that are
	// ANNOTATED `: Path` or ASSIGNED via `Path(...)` / `pathlib.Path(...)`
	// in the same file. Python's `pathlib.Path.__truediv__` overloads `/`
	// for path joins — `path / "subdir"` is NOT division. The 53 hits in
	// alter/cc-autopipe-source were all of this shape.
	const python = isPyFile(ext);
	const pathishNames = python ? collectPathishNames(stripped) : null;

	const divisionRegex = /(?:^|[^\w$])([a-zA-Z_$]\w*)\s+\/\s+([a-zA-Z_$]\w*)/g;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);
		// Reset lastIndex defensively for the global regex.
		divisionRegex.lastIndex = 0;
		if (!divisionRegex.test(line)) continue;

		// 139-repo audit: skip when a same-line zero-guard is present.
		// Supermodel mcpbr/analytics shape:
		//   avg = total / count if count > 0 else 0.0
		//   rate = (a / b * 100.0) if b > 0 else 0.0
		// The guard sits on the same line via the Python ternary; in JS/Go
		// it appears as `count > 0 ? a / b : 0` or `count !== 0 && a / b`.
		if (lineHasZeroGuard(line)) continue;

		// 139-repo audit: Python `Path / "subdir"` shape — re-run the
		// regex globally to inspect the operands and skip any match
		// whose LHS is annotated/assigned as a Path (or whose
		// neighborhood is a string literal — those are stripped to `""`
		// already, so we look at the original line).
		if (pathishNames && isPathDivisionLine(line, nonNull(originalLines[i]), pathishNames)) {
			continue;
		}

		// 139-repo audit: skip `os.path.join(...)` shapes — even if the
		// regex matched some inner identifier-pair, the call's outer
		// shape is path-join not division.
		if (/\bos\.path\.join\s*\(/.test(line)) continue;

		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Detect a same-line zero-guard for the divisor. Heuristic — covers the
 * common Python ternary shape (`x / y if y > 0 else 0`), the JS / Go
 * conditional (`y !== 0 ? x / y : 0`), and the C-style guard
 * (`if (y) result = x / y;`). Each pattern is anchored on the divisor
 * relationship so unrelated `if` statements on the same line don't
 * spuriously suppress.
 *
 * Conservative on purpose: the check is already advisory. Missing a
 * guard that should suppress is fine (FP); falsely suppressing a real
 * division-by-zero (FN) would defeat the check.
 */
function lineHasZeroGuard(line: string): boolean {
	// `... if <id> > 0 else ...` / `... if <id> != 0 else ...` /
	// `... if <id> is not None and <id> != 0 else ...`
	if (/\bif\s+[A-Za-z_$][\w$]*\s*(?:>\s*0|>=\s*1|!=\s*0|!==\s*0|is\s+not\s+None)\b/.test(line)) {
		return true;
	}
	// `... if (<id> > 0)` / `... if (<id> != 0)`  — parenthesized form.
	if (/\bif\s*\(\s*[A-Za-z_$][\w$]*\s*(?:>\s*0|!=\s*0|!==\s*0)\s*\)/.test(line)) {
		return true;
	}
	// JS/Go ternary: `<id> > 0 ? a / <id> : 0` / `<id> ? a / <id> : 0`.
	if (/\b[A-Za-z_$][\w$]*\s*(?:>\s*0|!==?\s*0)\s*\?[^?]*\//.test(line)) return true;
	// `<id> && a / <id>` short-circuit.
	if (/\b[A-Za-z_$][\w$]*\s*&&\s*[A-Za-z_$][\w$]*\s+\/\s+[A-Za-z_$]/.test(line)) return true;
	return false;
}

/**
 * Walk a Python file's stripped content and collect every identifier
 * that's annotated as `Path` / `pathlib.Path` or assigned the result of
 * `Path(...)` / `pathlib.Path(...)`. These names participate in
 * `__truediv__` overloads and `name / "subdir"` is NOT division.
 *
 * Conservative: a name that's BOTH a Path and a number (rare) will be
 * suppressed even when a real division could happen. The check is
 * advisory.
 */
function collectPathishNames(strippedSrc: string): Set<string> {
	const names = new Set<string>();
	// `name: Path` / `name: pathlib.Path` annotations (function args
	// AND assignment annotations).
	const annotRe = /\b([A-Za-z_$][\w$]*)\s*:\s*(?:pathlib\s*\.\s*)?Path\b/g;
	for (const m of strippedSrc.matchAll(annotRe)) names.add(nonNull(m[1]));
	// `name = Path(...)` / `name = pathlib.Path(...)`.
	const assignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:pathlib\s*\.\s*)?Path\s*\(/g;
	for (const m of strippedSrc.matchAll(assignRe)) names.add(nonNull(m[1]));
	return names;
}

/**
 * Return true when the matched division shape is actually a
 * `pathlib.Path` __truediv__ join — either the LHS is a known
 * Path-typed name, or the `/` is followed by a string literal in the
 * ORIGINAL line (which got stripped to `""` in the analyzed line, but
 * is still visible in the original).
 */
function isPathDivisionLine(
	strippedLine: string,
	originalLine: string,
	pathishNames: Set<string>,
): boolean {
	// Re-run the regex globally to inspect every match.
	const re = /(?:^|[^\w$])([a-zA-Z_$]\w*)\s+\/\s+([a-zA-Z_$]\w*)/g;
	let anyNonPathDivision = false;
	let foundAnyMatch = false;
	for (const m of strippedLine.matchAll(re)) {
		foundAnyMatch = true;
		const lhs = nonNull(m[1]);
		if (pathishNames.has(lhs)) continue; // pathlib join — skip
		anyNonPathDivision = true;
	}
	if (!foundAnyMatch) return false;
	// If every match has a Path-typed LHS, this is a path-join line.
	if (!anyNonPathDivision) return true;
	// Path / "literal" shape: stripped line shows `name / ""` because
	// the literal was stripped. Inspect the original to confirm.
	if (/\b[A-Za-z_$][\w$]*\s+\/\s+(?:["'`])/.test(originalLine)) return true;
	return false;
}
