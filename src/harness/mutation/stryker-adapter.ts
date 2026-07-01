// ===========================================
// Per-edit mutation — Stryker report adapter (build step 5, input bridge)
// ===========================================
// Converts a Stryker / mutation-testing-elements JSON report into RawMutants the
// identity layer can re-anchor. The report carries each file's `source`, so we
// compute the char offset + original lexeme from the mutant's 1-based line:col
// span. Pure + defensive (malformed files/mutants are skipped, not thrown).

import type { MutantStatus, RawMutant, TestRunResult } from "./types.js";

export interface AdaptedMutant {
	raw: RawMutant;
	status: MutantStatus;
}

/**
 * What a {@link MutationRunner} returns for one edited file: the per-mutant
 * results plus an optional overlay test-run signal (spec §7). `testRun` is
 * optional so a mutants-only runner (or an older Worker that does not report the
 * suite) still satisfies the contract — absent ⇒ no red/green or RED-witness gate.
 */
export interface MutationRunOutput {
	mutants: AdaptedMutant[];
	testRun?: TestRunResult;
}

export interface AdaptedFile {
	file: string;
	content: string;
	mutants: AdaptedMutant[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object";
}

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

/** Map a Stryker mutant status onto the mechanical vocabulary (spec §8). */
export function mapStrykerStatus(status: string): MutantStatus {
	switch (status) {
		case "Killed":
			return "killed";
		case "Survived":
			return "survived";
		case "Timeout":
			return "timeout";
		case "NoCoverage":
			return "uncovered";
		default:
			return "indeterminate";
	}
}

/** 1-based line + 1-based column → 0-based char offset; a line past EOF clamps to length. */
export function lineColToOffset(content: string, line: number, column: number): number {
	let offset = 0;
	let currentLine = 1;
	while (currentLine < line) {
		const nl = content.indexOf("\n", offset);
		if (nl === -1) return content.length;
		offset = nl + 1;
		currentLine++;
	}
	return offset + (column - 1);
}

interface Position {
	line: number;
	column: number;
}

function parsePosition(v: unknown): Position | null {
	if (!isRecord(v)) return null;
	const line = num(v.line);
	const column = num(v.column);
	return line !== null && column !== null ? { line, column } : null;
}

function parseMutants(file: string, content: string, raws: unknown[]): AdaptedMutant[] {
	const out: AdaptedMutant[] = [];
	for (const raw of raws) {
		if (!isRecord(raw)) continue;
		const mutator = str(raw.mutatorName);
		const replacement = str(raw.replacement);
		const status = str(raw.status);
		const location = isRecord(raw.location) ? raw.location : null;
		const start = location ? parsePosition(location.start) : null;
		const end = location ? parsePosition(location.end) : null;
		if (mutator === null || replacement === null || status === null || !start || !end) continue;
		const startOffset = lineColToOffset(content, start.line, start.column);
		const endOffset = lineColToOffset(content, end.line, end.column);
		out.push({
			raw: { file, mutator, originalLexeme: content.slice(startOffset, endOffset), replacement, startOffset },
			status: mapStrykerStatus(status),
		});
	}
	return out;
}

/** Parse a Stryker JSON report into per-file adapted mutants, or null if unrecognisable. */
export function strykerToAdapted(report: unknown): AdaptedFile[] | null {
	if (!isRecord(report) || !isRecord(report.files)) return null;
	const out: AdaptedFile[] = [];
	for (const [file, fileResult] of Object.entries(report.files)) {
		if (!isRecord(fileResult)) continue;
		const content = str(fileResult.source);
		if (content === null || !Array.isArray(fileResult.mutants)) continue;
		out.push({ file, content, mutants: parseMutants(file, content, fileResult.mutants) });
	}
	return out;
}
