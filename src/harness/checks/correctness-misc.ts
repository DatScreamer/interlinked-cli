// ===========================================================================
// Miscellaneous small correctness detectors
// ===========================================================================
// Three narrow, high-precision bug-class checks:
//
// 1. numeric_sort_without_comparator — `.sort()` with no comparator sorts
//    LEXICOGRAPHICALLY, so `[10, 9, 1].sort()` → [1, 10, 9]. Tier (a)
//    zero-FP only: fires when the receiver is provably numeric from syntax
//    alone — a numeric array literal, or an identifier declared in-file with
//    an explicit `number[]` / `Array<number>` annotation. No type inference.
//
// 2. implicit_switch_fallthrough — a non-empty `case` whose last statement
//    is not break/return/throw/continue while another clause follows. Uses
//    the TS AST (optional `typescript` dep, same degrade contract as
//    cyclomatic-ast.ts: silently skips when the dep is absent). A trailing
//    `// falls through` style comment exempts the clause (eslint convention).
//
// 3. contradictory_nullness_chain — an optional chain immediately non-null
//    asserted on the SAME chain (`a?.b!.c`, `(a?.b)!`): the `!` claims the
//    value cannot be absent while the `?.` claims it may be — a churn
//    artifact from appeasing tsc, and a cold-reader confusion signal.

import { createRequire } from "node:module";
import { extname } from "node:path";
import type * as TS from "typescript";
import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

type TsModule = typeof TS;

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 120;

/** TS-only extensions (non-null assertions are TypeScript syntax). */
const TS_EXTS = [".ts", ".tsx", ".mts", ".cts"];

// ─── Shared line helpers ──────────────────────────────────────────────────────

/** Convert a char offset in the stripped source to a 1-based line number. */
function offsetToLine(stripped: string, offset: number): number {
	return stripped.slice(0, offset).split("\n").length;
}

/** Trimmed, truncated raw-line excerpt for the finding text. */
function rawExcerpt(rawLines: string[], lineNo: number): string {
	return (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
}

function pushMatch(
	matches: InlineMatch[],
	seen: Set<number>,
	lineNo: number,
	message: string,
	rawLines: string[],
): void {
	if (matches.length >= MAX_MATCHES_PER_FILE) return;
	if (seen.has(lineNo)) return;
	seen.add(lineNo);
	matches.push({ line: lineNo, text: `${message} — ${rawExcerpt(rawLines, lineNo)}` });
}

// ═══ 1. numeric_sort_without_comparator ═══════════════════════════════════════

const NUM_LIT = String.raw`-?\d+(?:\.\d+)?`;

/**
 * `[10, 9, 1].sort()` — a numeric array literal (≥2 elements, so the missing
 * comparator can actually reorder something) sorted with no comparator.
 */
const NUMERIC_LITERAL_SORT_RE = new RegExp(
	String.raw`\[\s*${NUM_LIT}(?:\s*,\s*${NUM_LIT})+\s*,?\s*\]\s*\.sort\(\s*\)`,
	"g",
);

/**
 * `const xs: number[] = …` / `let xs: Array<number>` — identifiers whose
 * declaration carries an explicit numeric-array annotation.
 */
const NUMBER_ARRAY_DECL_RE = new RegExp(
	String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*(?:number\s*\[\s*\]|Array\s*<\s*number\s*>)`,
	"g",
);

function collectNumberArrayNames(stripped: string): string[] {
	const names: string[] = [];
	const re = new RegExp(NUMBER_ARRAY_DECL_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = re.exec(stripped)) !== null) {
		const name = hit[1];
		if (name !== undefined) names.push(name);
	}
	return names;
}

function detectAnnotatedIdentifierSorts(
	stripped: string,
	rawLines: string[],
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	for (const name of collectNumberArrayNames(stripped)) {
		// Escape the sole regex-special char a JS identifier can contain (the
		// dollar sign) so a name such as data$ is not read as an end-of-input
		// anchor (silent false-negative). The lookbehind keeps the bare local,
		// not a same-named property such as obj.xs.sort().
		const escaped = name.split("$").join("\\$");
		const useRe = new RegExp(String.raw`(?<![.\w$])${escaped}\s*\.sort\(\s*\)`, "g");
		let hit: RegExpExecArray | null;
		while ((hit = useRe.exec(stripped)) !== null) {
			pushMatch(
				matches,
				seen,
				offsetToLine(stripped, hit.index),
				`numeric_sort_without_comparator: "${name}" is number[] but .sort() has no comparator — default sort is lexicographic ([10,9,1] → [1,10,9]); use .sort((a, b) => a - b)`,
				rawLines,
			);
		}
	}
}

/**
 * Detect `.sort()` with no comparator on a provably-numeric receiver.
 *
 * Check id: `numeric_sort_without_comparator`
 *
 * Zero-FP tier only: numeric array literals and identifiers declared in-file
 * with a `number[]` / `Array<number>` annotation. No type inference.
 */
export function detectNumericSortWithoutComparator(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (!content.includes(".sort(")) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	// Shape (i): numeric array literal.
	const litRe = new RegExp(NUMERIC_LITERAL_SORT_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = litRe.exec(stripped)) !== null) {
		pushMatch(
			matches,
			seen,
			offsetToLine(stripped, hit.index),
			"numeric_sort_without_comparator: numeric array sorted with no comparator — default sort is lexicographic ([10,9,1] → [1,10,9]); use .sort((a, b) => a - b)",
			rawLines,
		);
	}

	// Shape (ii): identifier annotated number[] / Array<number> in this file.
	detectAnnotatedIdentifierSorts(stripped, rawLines, matches, seen);

	return matches;
}

// ═══ 2. implicit_switch_fallthrough ═══════════════════════════════════════════

let tsCache: TsModule | null | undefined;

/**
 * Resolve the optional `typescript` dep once, synchronously; absence is a
 * non-error (the check silently skips — that IS the degrade path). Same
 * contract as `cyclomatic-ast.ts::loadTs`.
 */
function loadTs(): TsModule | null {
	if (tsCache !== undefined) return tsCache;
	try {
		tsCache = createRequire(import.meta.url)("typescript") as TsModule;
	} catch {
		tsCache = null;
	}
	return tsCache;
}

function scriptKindFor(ts: TsModule, filePath: string): TS.ScriptKind {
	switch (extname(filePath).toLowerCase()) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

/** The eslint `no-fallthrough` comment convention (fallthrough / falls through / fall-through). */
const FALLTHROUGH_COMMENT_RE = /falls?[-\s]?through/i;

/**
 * A nested switch terminates when it has a default clause and every non-empty
 * clause's last statement terminates (empty clauses group with the next).
 * Added after the 2026-07-06 cross-repo calibration: its one FP was a case
 * ending in a nested switch whose every branch returned, flagged as
 * fallthrough because only the last-statement KIND was checked.
 */
function switchTerminates(ts: TsModule, stmt: TS.SwitchStatement): boolean {
	const clauses = stmt.caseBlock.clauses;
	if (clauses.length === 0 || !clauses.some((c) => ts.isDefaultClause(c))) return false;
	return clauses.every((c) => {
		const last = c.statements[c.statements.length - 1];
		return last === undefined || statementTerminates(ts, last);
	});
}

/**
 * Curated never-returning callees. A call to one of these as a case's last
 * statement leaves the switch just like break/return/throw, so it must NOT be
 * reported as fallthrough. Deliberately narrow (mirrors eslint
 * `no-fallthrough`'s allowance for `never`-returning calls): an arbitrary call
 * is assumed to return, so only these hand-picked exhaustiveness / abort
 * helpers count — widening the set trades a false-positive for a false-negative.
 */
const NEVER_RETURNING_SIMPLE_CALLEES = new Set([
	"assertNever",
	"exit",
	"fail",
	"panic",
	"unreachable",
	"invariant",
]);

/**
 * A call to a curated never-returning function: `assertNever(x)` / `exit(1)` /
 * `fail(…)` / `panic(…)` / `unreachable()` / `invariant(…)` (bare identifier
 * callee), or `process.exit(…)` (the one allowed member expression). Any other
 * call — `foo()`, `obj.method()` — is assumed to return.
 */
function isNeverReturningCall(ts: TsModule, expr: TS.Expression): boolean {
	if (!ts.isCallExpression(expr)) return false;
	const callee = expr.expression;
	if (ts.isIdentifier(callee)) return NEVER_RETURNING_SIMPLE_CALLEES.has(callee.text);
	if (ts.isPropertyAccessExpression(callee)) {
		return (
			ts.isIdentifier(callee.expression) &&
			callee.expression.text === "process" &&
			callee.name.text === "exit"
		);
	}
	return false;
}

/**
 * Does executing `stmt` always leave the switch (or the function)?
 * break/return/throw/continue directly, a curated never-returning call
 * (see isNeverReturningCall), a block ending in one, an if/else where BOTH
 * branches terminate, or a nested exhaustive-and-terminating switch (see
 * switchTerminates).
 */
function statementTerminates(ts: TsModule, stmt: TS.Statement): boolean {
	if (
		ts.isBreakStatement(stmt) ||
		ts.isReturnStatement(stmt) ||
		ts.isThrowStatement(stmt) ||
		ts.isContinueStatement(stmt)
	) {
		return true;
	}
	if (ts.isExpressionStatement(stmt)) {
		return isNeverReturningCall(ts, stmt.expression);
	}
	if (ts.isBlock(stmt)) {
		const last = stmt.statements[stmt.statements.length - 1];
		return last !== undefined && statementTerminates(ts, last);
	}
	if (ts.isIfStatement(stmt)) {
		return (
			stmt.elseStatement !== undefined &&
			statementTerminates(ts, stmt.thenStatement) &&
			statementTerminates(ts, stmt.elseStatement)
		);
	}
	if (ts.isSwitchStatement(stmt)) {
		return switchTerminates(ts, stmt);
	}
	return false;
}

function checkCaseBlock(
	ts: TsModule,
	sf: TS.SourceFile,
	block: TS.CaseBlock,
	matches: InlineMatch[],
): void {
	const clauses = block.clauses;
	// The LAST clause has nothing to fall into — only earlier clauses matter.
	for (let i = 0; i < clauses.length - 1; i++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const clause = clauses[i];
		const next = clauses[i + 1];
		if (clause === undefined || next === undefined) continue;
		// Empty clause = intentional case-grouping (`case A: case B: …`).
		if (clause.statements.length === 0) continue;
		const last = clause.statements[clause.statements.length - 1];
		if (last === undefined || statementTerminates(ts, last)) continue;
		// Trailing fallthrough comment lives in the trivia before the next
		// clause's first token — the [clause.end, next.getStart) gap.
		const gap = sf.text.slice(clause.end, next.getStart(sf));
		if (FALLTHROUGH_COMMENT_RE.test(gap)) continue;
		const lineNo = sf.getLineAndCharacterOfPosition(clause.getStart(sf)).line + 1;
		matches.push({
			line: lineNo,
			text: `implicit_switch_fallthrough: non-empty case falls through to the next clause — end it with break/return/throw, or mark intent with a "// falls through" comment`,
		});
	}
}

/**
 * Detect implicit switch-case fallthrough via the TS AST.
 *
 * Check id: `implicit_switch_fallthrough`
 *
 * Returns [] (silently skips) when the optional `typescript` dep is absent.
 */
export function detectImplicitSwitchFallthrough(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (!content.includes("switch")) return [];

	const ts = loadTs();
	if (ts === null) return [];

	let sf: TS.SourceFile;
	try {
		sf = ts.createSourceFile(
			filePath,
			content,
			ts.ScriptTarget.Latest,
			true,
			scriptKindFor(ts, filePath),
		);
	} catch {
		return [];
	}

	const matches: InlineMatch[] = [];
	const visit = (node: TS.Node): void => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		if (ts.isCaseBlock(node)) checkCaseBlock(ts, sf, node, matches);
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return matches;
}

// ═══ 3. contradictory_nullness_chain ══════════════════════════════════════════

/**
 * `a?.b!` / `a?.b!.c` / `a?.[i]!` — a `!` immediately after an optional
 * access on the same chain. `(?!=)` keeps `!=` / `!==` comparisons out.
 */
const CHAIN_THEN_ASSERT_RE = /\?\.(?:[\w$]+|\[[^\]\n]*\])!(?!=)/g;

/**
 * `(a?.b)!` — a parenthesized optional chain non-null asserted as a whole.
 * `(?<![\w$])` excludes call argument lists (`fn(a?.b)!` asserts fn's result,
 * not the chain).
 */
const PAREN_CHAIN_ASSERT_RE = /(?<![\w$])\([^()\n]*\?\.[^()\n]*\)!(?!=)/g;

/**
 * Detect an optional chain immediately non-null asserted on the same chain.
 *
 * Check id: `contradictory_nullness_chain`
 *
 * TS files only (`!` non-null assertion is TypeScript syntax). Legitimate
 * neighbours that must NOT fire: `a?.b?.c`, `a!.b`, chains and assertions in
 * separate statements.
 */
export function detectContradictoryNullnessChain(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!TS_EXTS.includes(ext)) return [];
	if (!content.includes("?.")) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	for (const source of [CHAIN_THEN_ASSERT_RE.source, PAREN_CHAIN_ASSERT_RE.source]) {
		const re = new RegExp(source, "g");
		let hit: RegExpExecArray | null;
		while ((hit = re.exec(stripped)) !== null) {
			pushMatch(
				matches,
				seen,
				offsetToLine(stripped, hit.index),
				'contradictory_nullness_chain: "?." (may be absent) immediately followed by "!" (cannot be absent) on the same chain — pick one: keep the optional chain, or prove non-null and drop the "?."',
				rawLines,
			);
		}
	}

	return matches;
}
