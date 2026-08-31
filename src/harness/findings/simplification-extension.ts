// ===========================================
// Findings corpus — simplification extension
// ===========================================
// The common Finding keeps lifecycle/status/anchor ownership. This optional
// extension carries simplification-specific evidence without creating another
// findings ledger. Unknown sibling extension keys are preserved for forwards
// compatibility.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	parseSimplificationCoverage,
	parseSimplificationFinding,
	parseSimplificationRepository,
	parseSimplificationScope,
} from "../../lib/simplification-schema.js";
import type {
	SimplificationCoverageReceipt,
	SimplificationFinding,
	SimplificationReport,
	SimplificationRepositoryIdentity,
	SimplificationScopeReceipt,
} from "../../lib/simplification-types.js";

export const SIMPLIFICATION_EXTENSION_SCHEMA_VERSION = 1 as const;

export interface SimplificationFindingExtension {
	schema_version: typeof SIMPLIFICATION_EXTENSION_SCHEMA_VERSION;
	run_fingerprint: string;
	recorded_at: string;
	command: SimplificationReport["command"];
	repository: SimplificationRepositoryIdentity;
	scope: SimplificationScopeReceipt;
	coverage: SimplificationCoverageReceipt;
	finding: SimplificationFinding;
}

export interface FindingExtensions extends JsonObject {
	simplification?: SimplificationFindingExtension;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseSimplificationExtension(
	value: unknown,
): SimplificationFindingExtension | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== SIMPLIFICATION_EXTENSION_SCHEMA_VERSION) return null;
	if (value.command !== "scan" && value.command !== "review" && value.command !== "audit") {
		return null;
	}
	const run_fingerprint = nonEmptyString(value.run_fingerprint);
	const recorded_at = nonEmptyString(value.recorded_at);
	const repository = parseSimplificationRepository(value.repository);
	const scope = parseSimplificationScope(value.scope);
	const coverage = parseSimplificationCoverage(value.coverage);
	const finding = parseSimplificationFinding(value.finding);
	if (!run_fingerprint || !recorded_at || !repository || !scope || !coverage || !finding) {
		return null;
	}
	return {
		schema_version: SIMPLIFICATION_EXTENSION_SCHEMA_VERSION,
		run_fingerprint,
		recorded_at,
		command: value.command,
		repository,
		scope,
		coverage,
		finding,
	};
}

export function parseFindingExtensions(value: unknown): FindingExtensions | null | undefined {
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) return null;
	const out: FindingExtensions = { ...value };
	if (value.simplification !== undefined) {
		const simplification = parseSimplificationExtension(value.simplification);
		if (!simplification) return null;
		out.simplification = simplification;
	}
	return out;
}
