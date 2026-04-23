// Builder functions that derive legacy data structures (agentSafetyChecks
// array, check instructions map, GENERIC_CHECK_META) from CHECK_REGISTRY.

import type { Determinism } from "../types.js";
import { CHECK_REGISTRY } from "./registry.js";
import type { CheckPhase, InlineMatch } from "./types.js";

/**
 * Build the agentSafetyChecks array for a given phase.
 *
 * @param content file contents to check
 * @param filePath path of the file being checked
 * @param phase optional phase filter — pass "pre_block", "pre_warn", or "post"
 *   to run only checks registered for that phase. Omit to run all phases
 *   (used by `interlinked verify` for full audit).
 */
export function buildAgentSafetyChecks(
	content: string,
	filePath: string,
	phase?: CheckPhase,
): Array<{
	name: string;
	severity: "error" | "warning";
	fn: () => InlineMatch[];
}> {
	return CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety")
		.filter((c) => !phase || c.phase === phase)
		.map((c) => ({
			name: c.id,
			severity: c.severity,
			fn: () => c.fn(content, filePath),
		}));
}

/** Build check instructions map (id → fix_instruction) */
export function buildCheckInstructions(): Record<string, string> {
	const instructions: Record<string, string> = {};
	for (const c of CHECK_REGISTRY) {
		instructions[c.id] = c.fix_instruction;
	}
	return instructions;
}

/** Build GENERIC_CHECK_META from registry (id → name/description/tier/determinism) */
export function buildGenericCheckMeta(): Record<
	string,
	{
		name: string;
		description: string;
		tier: 1 | 2 | 3;
		determinism: Determinism;
	}
> {
	const meta: Record<
		string,
		{
			name: string;
			description: string;
			tier: 1 | 2 | 3;
			determinism: Determinism;
		}
	> = {};
	for (const c of CHECK_REGISTRY) {
		meta[c.id] = {
			name: c.name,
			description: c.description,
			tier: c.tier,
			determinism: c.determinism,
		};
	}
	return meta;
}
