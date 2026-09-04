// Halstead metrics + maintainability index — quality-metric family.
//
// Part of the verification-density program, Track A lane 1
// (docs/design/verification-density-program.md).
//
// Cyclomatic and cognitive complexity both measure CONTROL FLOW. Neither
// notices a function that is flat but dense — thirty distinct operators over
// forty operands in a straight line reads as complexity 1. Halstead measures
// that vocabulary dimension, and the maintainability index folds volume,
// control flow, and length into one number:
//
//   MI = max(0, (171 - 5.2·ln(V) - 0.23·CC - 16.2·ln(LOC)) · 100/171)
//
// Normalized to 0-100 (the SEI/Visual-Studio convention) so the threshold reads
// the same way everywhere: higher is better, and the check fires low.
//
// Advisory by construction: the arithmetic is exact but the threshold is a
// taste judgment, exactly like `cognitive_complexity`. Registered advisory,
// never a gate.

import type * as TS from "typescript";
import {
	functionName,
	isImplementationFunction,
	parseTsSource,
	type TsModule,
} from "./cyclomatic-ast.js";
import { goHalsteadCheck } from "./go-halstead.js";
import {
	HALSTEAD_DIFFICULTY_CEILING,
	HALSTEAD_VOLUME_FLOOR,
	MIN_TEXT_FOR_TALLY,
} from "./halstead-constants.js";
import type { InlineMatch } from "./shared.js";

export { HALSTEAD_DIFFICULTY_CEILING, HALSTEAD_VOLUME_FLOOR, MIN_TEXT_FOR_TALLY };

// HALSTEAD_DIFFICULTY_CEILING / HALSTEAD_VOLUME_FLOOR / MIN_TEXT_FOR_TALLY
// live in ./halstead-constants.ts and are re-exported above so existing
// importers keep working.

/** Halstead measures for one function. */
export interface HalsteadMetrics {
	/** Distinct operators (n1). */
	unique_operators: number;
	/** Distinct operands (n2). */
	unique_operands: number;
	/** Total operators (N1). */
	total_operators: number;
	/** Total operands (N2). */
	total_operands: number;
	/** Program vocabulary, n1 + n2. */
	vocabulary: number;
	/** Program length, N1 + N2. */
	length: number;
	/** Volume, N · log2(n). */
	volume: number;
	/** Difficulty, (n1/2) · (N2/n2). */
	difficulty: number;
	/** Effort, difficulty · volume. */
	effort: number;
}

/** Everything measured for one function. */
export interface FunctionMaintainability {
	name: string;
	/** 1-based line of the function. */
	line: number;
	halstead: HalsteadMetrics;
	cyclomatic: number;
	/** Physical lines spanned. */
	loc: number;
	/** Maintainability index, 0-100 (higher is better). */
	maintainability: number;
}

/** Token kinds that count as OPERANDS; everything else syntactic is an operator. */
function isOperandKind(ts: TsModule, kind: TS.SyntaxKind): boolean {
	return (
		kind === ts.SyntaxKind.Identifier ||
		kind === ts.SyntaxKind.PrivateIdentifier ||
		kind === ts.SyntaxKind.NumericLiteral ||
		kind === ts.SyntaxKind.BigIntLiteral ||
		kind === ts.SyntaxKind.StringLiteral ||
		kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
		kind === ts.SyntaxKind.RegularExpressionLiteral ||
		kind === ts.SyntaxKind.TrueKeyword ||
		kind === ts.SyntaxKind.FalseKeyword ||
		kind === ts.SyntaxKind.NullKeyword ||
		kind === ts.SyntaxKind.UndefinedKeyword
	);
}

/** Tokens that carry no Halstead meaning. */
function isIgnorableKind(ts: TsModule, kind: TS.SyntaxKind): boolean {
	return (
		kind === ts.SyntaxKind.EndOfFileToken ||
		kind === ts.SyntaxKind.SingleLineCommentTrivia ||
		kind === ts.SyntaxKind.MultiLineCommentTrivia ||
		kind === ts.SyntaxKind.NewLineTrivia ||
		kind === ts.SyntaxKind.WhitespaceTrivia
	);
}

/** Tallies collected while walking a function's tokens. */
interface TokenTally {
	operators: Map<string, number>;
	operands: Map<string, number>;
}

function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/** Walk every leaf token under `node`, tallying operators and operands. */
function tallyTokens(ts: TsModule, node: TS.Node, sf: TS.SourceFile, tally: TokenTally): void {
	const children = node.getChildren(sf);
	if (children.length === 0) {
		const kind = node.kind;
		if (isIgnorableKind(ts, kind)) return;
		const text = node.getText(sf);
		if (!text) return;
		if (isOperandKind(ts, kind)) bump(tally.operands, text);
		else bump(tally.operators, text);
		return;
	}
	for (const child of children) tallyTokens(ts, child, sf, tally);
}

/** Derive Halstead measures from raw tallies. */
function halsteadFrom(tally: TokenTally): HalsteadMetrics {
	const n1 = tally.operators.size;
	const n2 = tally.operands.size;
	const sum = (m: Map<string, number>): number => {
		let total = 0;
		for (const v of m.values()) total += v;
		return total;
	};
	const N1 = sum(tally.operators);
	const N2 = sum(tally.operands);
	const vocabulary = n1 + n2;
	const length = N1 + N2;
	const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
	const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
	return {
		unique_operators: n1,
		unique_operands: n2,
		total_operators: N1,
		total_operands: N2,
		vocabulary,
		length,
		volume,
		difficulty,
		effort: difficulty * volume,
	};
}

/**
 * Maintainability index, normalized to 0-100.
 *
 * Guards every logarithm: `ln(0)` is -Infinity, which would surface as a
 * spectacular MI for an empty function rather than a sane 100.
 */
export function maintainabilityIndex(volume: number, cyclomatic: number, loc: number): number {
	const lnV = volume > 0 ? Math.log(volume) : 0;
	const lnL = loc > 0 ? Math.log(loc) : 0;
	const raw = 171 - 5.2 * lnV - 0.23 * cyclomatic - 16.2 * lnL;
	return Math.max(0, Math.min(100, (raw * 100) / 171));
}

/** Cyclomatic complexity of one node, counted the same way the gate counts it. */
function cyclomaticOf(ts: TsModule, node: TS.Node): number {
	let count = 1;
	const walk = (n: TS.Node): void => {
		switch (n.kind) {
			case ts.SyntaxKind.IfStatement:
			case ts.SyntaxKind.ConditionalExpression:
			case ts.SyntaxKind.CaseClause:
			case ts.SyntaxKind.ForStatement:
			case ts.SyntaxKind.ForInStatement:
			case ts.SyntaxKind.ForOfStatement:
			case ts.SyntaxKind.WhileStatement:
			case ts.SyntaxKind.DoStatement:
			case ts.SyntaxKind.CatchClause:
				count++;
				break;
			case ts.SyntaxKind.BinaryExpression: {
				// SAFETY: guarded by the enclosing `case` on the node's own kind.
				const op = (n as TS.BinaryExpression).operatorToken.kind;
				if (
					op === ts.SyntaxKind.AmpersandAmpersandToken ||
					op === ts.SyntaxKind.BarBarToken ||
					op === ts.SyntaxKind.QuestionQuestionToken
				) {
					count++;
				}
				break;
			}
			default:
				break;
		}
		ts.forEachChild(n, walk);
	};
	walk(node);
	return count;
}

/**
 * Measure every function in a source file.
 *
 * Returns null when the AST is unavailable (`typescript` is an optional
 * dependency), matching every other AST-backed check in this repo: absent
 * parser means the check silently no-ops rather than guessing.
 */
export function computeMaintainability(
	content: string,
	filePath: string,
	minTextForTally = 0,
): FunctionMaintainability[] | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const out: FunctionMaintainability[] = [];

	const walk = (node: TS.Node): void => {
		if (isImplementationFunction(ts, node)) {
			// Cheap length pre-filter before the expensive token walk. `getChildren`
			// materializes a fresh array per node, so tallying every function in
			// every file is the dominant cost of this check — enough on its own to
			// push the determinism-conformance suite past its 30s timeout when this
			// filter was absent. Volume >= HALSTEAD_VOLUME_FLOOR needs roughly 40+
			// tokens, so anything shorter cannot reach the reporting floor.
			if (node.getEnd() - node.getStart(sf) < minTextForTally) {
				ts.forEachChild(node, walk);
				return;
			}
			const tally: TokenTally = { operators: new Map(), operands: new Map() };
			tallyTokens(ts, node, sf, tally);
			const halstead = halsteadFrom(tally);
			const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
			const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
			const loc = Math.max(1, endLine - startLine + 1);
			const cyclomatic = cyclomaticOf(ts, node);
			out.push({
				name: functionName(ts, node, sf),
				line: startLine,
				halstead,
				cyclomatic,
				loc,
				maintainability: maintainabilityIndex(halstead.volume, cyclomatic, loc),
			});
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	out.sort((a, b) => a.line - b.line);
	return out;
}

/**
 * Detector: functions that are DENSE — high operator variety over few reused
 * operands — regardless of how long or how branchy they are.
 *
 * This is the dimension cyclomatic and cognitive complexity cannot see: the
 * dense fixture in this module's tests has cyclomatic 1.
 */
export function maintainabilityCheck(content: string, filePath: string): InlineMatch[] {
	if (filePath.endsWith(".go")) {
		return goHalsteadCheck(content, filePath);
	}
	const measured = computeMaintainability(content, filePath, MIN_TEXT_FOR_TALLY);
	if (!measured) return [];
	return measured
		.filter(
			(fn) =>
				fn.halstead.volume >= HALSTEAD_VOLUME_FLOOR &&
				fn.halstead.difficulty > HALSTEAD_DIFFICULTY_CEILING,
		)
		.map((fn) => ({
			line: fn.line,
			text: `${fn.name} — Halstead difficulty ${fn.halstead.difficulty.toFixed(1)} > ${HALSTEAD_DIFFICULTY_CEILING} (volume ${fn.halstead.volume.toFixed(0)}, cyclomatic ${fn.cyclomatic}, maintainability ${fn.maintainability.toFixed(0)})`,
		}));
}
