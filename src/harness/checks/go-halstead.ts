// ===========================================
// Go Halstead difficulty — luisantonioig/halstead-metrics
// ===========================================
// Port of github.com/luisantonioig/halstead-metrics counting policy
// (go/ast Inspect: call/index/if/:=/func as operators; package/import omitted;
// operands classified pkg:/func:/var:/field:/builtin:). Same arithmetic and
// reporting floors as the TS check (difficulty > 80 and volume >= 200).

import { HALSTEAD_DIFFICULTY_CEILING, HALSTEAD_VOLUME_FLOOR } from "./halstead-constants.js";
import type { HalsteadMetrics } from "./maintainability.js";
import { analyzeGoHalstead, type GoHalsteadCounts } from "./go-halstead-walk.js";
import type { InlineMatch } from "./shared.js";

export interface GoFunctionHalsteadMetrics {
	name: string;
	kind: "func_decl" | "func_lit";
	line: number;
	halstead: HalsteadMetrics;
}

function metricsFromCounts(counts: GoHalsteadCounts): HalsteadMetrics {
	const n1 = counts.operators.size;
	const n2 = counts.operands.size;
	let N1 = 0;
	let N2 = 0;
	for (const v of counts.operators.values()) N1 += v;
	for (const v of counts.operands.values()) N2 += v;
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

/** Per-function Halstead metrics for a Go file. Empty when not a Go unit. */
export function computeGoHalstead(content: string): GoFunctionHalsteadMetrics[] {
	const report = analyzeGoHalstead(content);
	if (!report) return [];
	return report.functions.map((fn) => ({
		name: fn.name,
		kind: fn.kind,
		line: fn.line,
		halstead: metricsFromCounts(fn.counts),
	}));
}

/** File-level counts — used by tests that pin the upstream AST policy. */
export function computeGoHalsteadFile(content: string): HalsteadMetrics | null {
	const report = analyzeGoHalstead(content);
	if (!report) return null;
	return metricsFromCounts(report.file);
}

export function goHalsteadFileOperators(content: string): Map<string, number> | null {
	return analyzeGoHalstead(content)?.file.operators ?? null;
}

export function goHalsteadFileOperands(content: string): Map<string, number> | null {
	return analyzeGoHalstead(content)?.file.operands ?? null;
}

/**
 * Detector: Go functions whose Halstead difficulty exceeds the shared ceiling
 * with enough volume to ignore one-liners.
 */
export function goHalsteadCheck(content: string, _filePath: string): InlineMatch[] {
	return computeGoHalstead(content)
		.filter(
			(fn) =>
				fn.halstead.volume >= HALSTEAD_VOLUME_FLOOR &&
				fn.halstead.difficulty > HALSTEAD_DIFFICULTY_CEILING,
		)
		.map((fn) => ({
			line: fn.line,
			text: `${fn.name} — Halstead difficulty ${fn.halstead.difficulty.toFixed(1)} > ${HALSTEAD_DIFFICULTY_CEILING} (volume ${fn.halstead.volume.toFixed(0)}; go-ast policy from luisantonioig/halstead-metrics)`,
		}));
}
