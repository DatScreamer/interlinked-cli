// Strict mutant-census parsing and exact row accounting.
import {
	checkBoundedString,
	checkBoundedText,
	checkPolicyId,
	checkSafeNonNegInt,
	checkSha256Hex,
	firstReason,
	isRecord,
	MAX_MUTANT_ROWS,
	type Reason,
	unknownKeysIn,
} from "./field-checks.js";
import { IDENTITY_ALGORITHM, V3_MUTANT_STATUSES } from "./types.js";

type Raw = Record<string, unknown>;
const MUTANT_STATUSES: readonly string[] = V3_MUTANT_STATUSES;

function validatedNumber(row: Raw, key: string): number {
	const value = row[key];
	if (typeof value !== "number") throw new Error(`internal census parser invariant: ${key} is not a number`);
	return value;
}

function validatedRows(raw: Raw, key: string): Raw[] {
	const value = raw[key];
	if (!Array.isArray(value) || !value.every(isRecord)) {
		throw new Error(`internal census parser invariant: ${key} rows were not validated`);
	}
	return value;
}

function validatedRecord(raw: Raw, key: string): Raw {
	const value = raw[key];
	if (!isRecord(value)) throw new Error(`internal census parser invariant: ${key} was not validated`);
	return value;
}

function validatedMutantId(row: Raw): string {
	const value = row.mutant_id;
	if (typeof value !== "string") throw new Error("internal census parser invariant: mutant_id is not a string");
	return value;
}

const IDENTITY_PROVENANCE_KEYS = [
	"mutant_id",
	"site_id",
	"symbol_id",
	"qualified_name",
	"symbol_context",
	"mutator",
	"original_lexeme",
	"replacement",
	"start_offset",
	"ordinal_within_symbol",
] as const;

function checkCensus(o: Raw, where: string): Reason {
	const counts = firstReason([
		unknownKeysIn(o, ["generated", "executable", "approved_excluded"], where),
		checkSafeNonNegInt(o.generated, `${where}.generated`),
		checkSafeNonNegInt(o.executable, `${where}.executable`),
		checkSafeNonNegInt(o.approved_excluded, `${where}.approved_excluded`),
	]);
	if (counts !== null) return `census arithmetic: ${counts}`;
	if (validatedNumber(o, "generated") !==
		validatedNumber(o, "executable") + validatedNumber(o, "approved_excluded")) {
		return "census arithmetic: generated must equal executable + approved_excluded exactly";
	}
	return null;
}

export function checkCensusBlock(raw: Raw): Reason {
	if (!isRecord(raw.census)) return "census must be an object";
	return checkCensus(raw.census, "census");
}

function checkIdRows(rows: unknown, where: string, rowCheck: (row: Raw, at: string) => Reason): Reason {
	if (!Array.isArray(rows) || rows.length > MAX_MUTANT_ROWS) {
		return `${where} must be an array of at most ${MAX_MUTANT_ROWS} rows`;
	}
	const seen = new Set<string>();
	for (const row of rows) {
		if (!isRecord(row)) return `${where}[] rows must be objects`;
		const bad = rowCheck(row, `${where}[]`);
		if (bad !== null) return bad;
		const id = validatedMutantId(row);
		if (seen.has(id)) return `${where}[] mutant_id values must be unique`;
		seen.add(id);
	}
	return null;
}

function checkIdentityProvenance(row: Raw, at: string): Reason {
	return firstReason([
		checkSha256Hex(row.mutant_id, `${at}.mutant_id`),
		checkSha256Hex(row.site_id, `${at}.site_id`),
		checkSha256Hex(row.symbol_id, `${at}.symbol_id`),
		checkBoundedString(row.qualified_name, `${at}.qualified_name`),
		checkBoundedString(row.symbol_context, `${at}.symbol_context`),
		checkBoundedString(row.mutator, `${at}.mutator`),
		checkBoundedText(row.original_lexeme, `${at}.original_lexeme`),
		checkBoundedText(row.replacement, `${at}.replacement`),
		checkSafeNonNegInt(row.start_offset, `${at}.start_offset`),
		checkSafeNonNegInt(row.ordinal_within_symbol, `${at}.ordinal_within_symbol`),
	]);
}

function checkMutantRow(row: Raw, at: string): Reason {
	const keys = unknownKeysIn(row, [...IDENTITY_PROVENANCE_KEYS, "status"], at);
	if (keys !== null) return keys;
	const provenance = checkIdentityProvenance(row, at);
	if (provenance !== null) return provenance;
	return typeof row.status === "string" && MUTANT_STATUSES.includes(row.status)
		? null
		: `${at} status must be one of ${V3_MUTANT_STATUSES.join("|")}`;
}

function checkExcludedRow(row: Raw, at: string): Reason {
	return firstReason([
		unknownKeysIn(row, [...IDENTITY_PROVENANCE_KEYS, "policy_id"], at),
		checkIdentityProvenance(row, at),
		checkPolicyId(row.policy_id, `${at}.policy_id`),
	]);
}

function checkCensusAccounting(raw: Raw, minimumGenerated: number): Reason {
	const counts = validatedRecord(raw, "census");
	const mutants = validatedRows(raw, "mutants");
	const excluded = validatedRows(raw, "excluded");
	if (validatedNumber(counts, "generated") < minimumGenerated) {
		return "mutation_result requires census.generated >= 1 — zero generated is the not_mutatable kind";
	}
	if (mutants.length !== validatedNumber(counts, "executable")) {
		return "census accounting: exactly one status row per executable mutant";
	}
	if (excluded.length !== validatedNumber(counts, "approved_excluded")) {
		return "census accounting: exactly one excluded row per approved exclusion";
	}
	const mutantIds = new Set(mutants.map(validatedMutantId));
	if (excluded.some((row) => mutantIds.has(validatedMutantId(row)))) {
		return "census accounting: excluded and executable mutant ids must be disjoint";
	}
	return null;
}

/** Census, excluded rows, executable rows, and identity algorithm are one
 * inseparable evidence group with exact accounting. */
function checkCensusGroup(raw: Raw, minimumGenerated: number): Reason {
	if (raw.identity_algorithm !== IDENTITY_ALGORITHM) {
		return `identity_algorithm must be exactly "${IDENTITY_ALGORITHM}" wherever mutant rows appear`;
	}
	const blocks = firstReason([
		checkCensusBlock(raw),
		checkIdRows(raw.excluded, "excluded", checkExcludedRow),
		checkIdRows(raw.mutants, "mutants", checkMutantRow),
	]);
	return blocks ?? checkCensusAccounting(raw, minimumGenerated);
}

export function checkGeneratedCensusGroup(raw: Raw): Reason {
	return checkCensusGroup(raw, 1);
}

export function checkOptionalCensusGroup(raw: Raw): Reason {
	return checkCensusGroup(raw, 0);
}
