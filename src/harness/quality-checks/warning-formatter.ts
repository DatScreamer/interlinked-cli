// ===========================================
// Warning Formatting
// ===========================================
// Turns the QualityCheckResult records produced by runQualityChecks into the
// stderr warning strings the hook script surfaces to the agent. Each warning
// carries a `[proven]` / `[heuristic]` determinism tag and a per-check fix
// instruction so the agent knows both how authoritative the finding is and
// how to fix it properly (no suppressions, no shortcuts).

import { buildCheckInstructions, buildGenericCheckMeta } from "../check-registry/index.js";
import { PROVEN_TOOL_CHECKS, TOOL_CHECK_INSTRUCTIONS } from "./instructions.js";
import type { QualityCheckResult } from "./result-types.js";

// Merge tool-based instructions with registry-derived inline check instructions.
// Registry entries (from check-registry/) take precedence for any overlapping keys.
const CHECK_INSTRUCTIONS: Record<string, string> = {
	...TOOL_CHECK_INSTRUCTIONS,
	...buildCheckInstructions(),
};

// Registry checks self-classify via their own `determinism` field. Cache the
// id→determinism map at module init so the formatter can look up without
// rebuilding on every warning.
const REGISTRY_DETERMINISM: Record<
	string,
	"fully_deterministic" | "partially_deterministic" | "heuristic"
> = Object.fromEntries(
	Object.entries(buildGenericCheckMeta()).map(([id, meta]) => [id, meta.determinism]),
);

/**
 * Lopopolo's "proven vs heuristic" framing surfaced to the agent. Returns
 * the tag to inline into the warning message, or `null` when we don't know
 * the check's determinism (no tag rather than guess wrong).
 *
 * Resolution order:
 * 1. Registry check (CHECK_REGISTRY) → use the entry's `determinism` field.
 *    `fully_deterministic` → "proven"; everything else → "heuristic".
 * 2. Tool check explicitly listed in PROVEN_TOOL_CHECKS → "proven".
 * 3. Tool check present in TOOL_CHECK_INSTRUCTIONS but not in the proven
 *    set → "heuristic" (default for non-tool checks: pattern-matched, not
 *    behavior-verified).
 * 4. Anything else (id not registered anywhere we know of) → null (no tag).
 */
export function classifyDeterminism(checkId: string): "proven" | "heuristic" | null {
	const registry = REGISTRY_DETERMINISM[checkId];
	if (registry) return registry === "fully_deterministic" ? "proven" : "heuristic";
	if (PROVEN_TOOL_CHECKS.has(checkId)) return "proven";
	if (checkId in TOOL_CHECK_INSTRUCTIONS) return "heuristic";
	return null;
}

/**
 * Format quality check results as stderr warning strings.
 * Includes per-check instructions so agents know how to fix properly
 * (no suppressions, no shortcuts — fix the actual code).
 *
 * Each warning is prefixed with a `[proven]` or `[heuristic]` tag derived
 * from the check's determinism so the agent can tell which findings are
 * authoritative (compiler / linter / scanner / parser said so) versus
 * pattern-matched suggestions (regex/AST shape — could be a false positive).
 * Lopopolo's framing: *"forbid speculative bug reports."* The tag forces
 * us to be explicit about what kind of evidence we're presenting.
 */
export function formatQualityWarnings(results: QualityCheckResult[]): string[] {
	return results.map((r) => {
		const tag = classifyDeterminism(r.name);
		const prefix = tag ? `[interlinked:${r.name}] [${tag}]` : `[interlinked:${r.name}]`;
		let msg = `${prefix} ${r.message}`;
		if (r.detail) {
			msg += `\n${r.detail}`;
		}
		const instruction = CHECK_INSTRUCTIONS[r.name];
		if (instruction) {
			msg += `\n→ ${instruction}`;
		}
		return msg;
	});
}
