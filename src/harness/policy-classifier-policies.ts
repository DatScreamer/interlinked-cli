// interlinked-tdd: exempt
// ===========================================
// Policy Classifier — policy loading
// ===========================================
// Loads applicable PolicyRule entries for a trigger from
// .interlinked/policies.json, falling back to a built-in default set.
// No module-private state — depends only on node:fs/path and the PolicyRule type.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { AgentRole, PolicyRule } from "./types.js";

const AGENT_ROLES: ReadonlySet<string> = new Set<AgentRole>([
	"lead",
	"worker",
	"subagent",
	"unknown",
]);

/**
 * Validate one raw policy entry into a PolicyRule, or null if any required
 * field is the wrong shape. `applies_to_roles` is optional but, if present,
 * must be an array of known AgentRole strings.
 */
function parsePolicyRule(value: unknown): PolicyRule | null {
	if (!isJsonObject(value)) return null;
	const { id, name, description, applies_to_triggers, applies_to_roles } = value;
	if (typeof id !== "string" || typeof name !== "string" || typeof description !== "string") {
		return null;
	}
	if (
		!Array.isArray(applies_to_triggers) ||
		!applies_to_triggers.every((t): t is string => typeof t === "string")
	) {
		return null;
	}
	if (applies_to_roles === undefined) {
		return { id, name, description, applies_to_triggers };
	}
	if (
		!Array.isArray(applies_to_roles) ||
		!applies_to_roles.every((r): r is AgentRole => typeof r === "string" && AGENT_ROLES.has(r))
	) {
		return null;
	}
	return { id, name, description, applies_to_triggers, applies_to_roles };
}

/**
 * Validate a raw policies array. All-or-nothing: one malformed entry means
 * the whole file is treated as unusable (same fallback the file already
 * takes for a missing/unreadable/invalid-JSON policies.json — a partially
 * mixed custom+default policy set would be a worse failure mode than a
 * clean fallback to the known-good built-ins).
 */
function parsePolicyRules(raw: unknown[]): PolicyRule[] | null {
	const out: PolicyRule[] = [];
	for (const entry of raw) {
		const rule = parsePolicyRule(entry);
		if (rule === null) return null;
		out.push(rule);
	}
	return out;
}

/** Load applicable policies from .interlinked/policies.json */
export function loadPolicies(trigger: string): PolicyRule[] {
	try {
		const policiesPath = join(process.cwd(), ".interlinked", "policies.json");
		if (!existsSync(policiesPath)) return getDefaultPolicies(trigger);
		const data: unknown = JSON.parse(readFileSync(policiesPath, "utf-8"));
		if (!isJsonObject(data) || !Array.isArray(data.policies)) return getDefaultPolicies(trigger);
		const rules = parsePolicyRules(data.policies);
		if (rules === null) return getDefaultPolicies(trigger);
		// Filter to policies that apply to this trigger
		return rules.filter(
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
