// interlinked-tdd: exempt
// ===========================================
// Policy Classifier — policy loading
// ===========================================
// Loads applicable PolicyRule entries for a trigger from
// .interlinked/policies.json, falling back to a built-in default set.
// No module-private state — depends only on node:fs/path and the PolicyRule type.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyRule } from "./types.js";

/** Load applicable policies from .interlinked/policies.json */
export function loadPolicies(trigger: string): PolicyRule[] {
	try {
		const policiesPath = join(process.cwd(), ".interlinked", "policies.json");
		if (!existsSync(policiesPath)) return getDefaultPolicies(trigger);
		const data = JSON.parse(readFileSync(policiesPath, "utf-8"));
		if (!Array.isArray(data.policies)) return getDefaultPolicies(trigger);
		// Filter to policies that apply to this trigger
		return (data.policies as PolicyRule[]).filter(
			(p) => p.applies_to_triggers.includes(trigger) || p.applies_to_triggers.includes("*"),
		);
	} catch {
		return getDefaultPolicies(trigger);
	}
}

/** Default policies when no policies.json exists */
function getDefaultPolicies(trigger: string): PolicyRule[] {
	const ALL_DEFAULTS: PolicyRule[] = [
		{
			id: "no_exfil_after_taint",
			name: "No outbound network after reading sensitive files",
			description:
				"Agents must not make network calls to external URLs after reading files classified at Internal sensitivity or above.",
			applies_to_triggers: ["tainted_network_internal", "external_url"],
		},
		{
			id: "post_injection_compliance",
			name: "No destructive operations after injection detection",
			description:
				"After prompt injection content was detected in a file read during this session, the agent must not perform destructive operations (file deletion, force push, dropping data).",
			applies_to_triggers: ["post_injection_action"],
		},
		{
			id: "step_budget_justification",
			name: "Essential operations only near step budget",
			description:
				"Agents approaching their step budget (>80%) should only perform essential operations, not exploratory reads or refactoring.",
			applies_to_triggers: ["high_step_budget"],
		},
	];
	return ALL_DEFAULTS.filter(
		(p) => p.applies_to_triggers.includes(trigger) || p.applies_to_triggers.includes("*"),
	);
}
