// Mutation-kill companion for src/harness/policy-classifier-policies.ts.
//
// Only `loadPolicies` is exported — parsePolicyRule / parsePolicyRules /
// getDefaultPolicies are internal, so every case here drives them through
// the public loadPolicies(trigger) entry point with node:fs mocked (same
// automock pattern as error-history.mutation-kill.test.ts). loadPolicies
// wraps its whole body in try/catch, which masks several "skip this guard"
// mutants behind an identical default-fallback result on both branches;
// those are left as still_open (see receipts) rather than claimed here.

import * as fs from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyRule } from "./types.js";

vi.mock("node:fs");
const mockFs = vi.mocked(fs);

beforeEach(() => {
	vi.resetAllMocks();
});

const NO_EXFIL: PolicyRule = {
	id: "no_exfil_after_taint",
	name: "No outbound network after reading sensitive files",
	description:
		"Agents must not make network calls to external URLs after reading files classified at Internal sensitivity or above.",
	applies_to_triggers: ["tainted_network_internal", "external_url"],
};
const POST_INJECTION: PolicyRule = {
	id: "post_injection_compliance",
	name: "No destructive operations after injection detection",
	description:
		"After prompt injection content was detected in a file read during this session, the agent must not perform destructive operations (file deletion, force push, dropping data).",
	applies_to_triggers: ["post_injection_action"],
};
const STEP_BUDGET: PolicyRule = {
	id: "step_budget_justification",
	name: "Essential operations only near step budget",
	description:
		"Agents approaching their step budget (>80%) should only perform essential operations, not exploratory reads or refactoring.",
	applies_to_triggers: ["high_step_budget"],
};

async function importFresh() {
	vi.resetModules();
	return import("./policy-classifier-policies.js");
}

function stubPoliciesFile(policies: unknown) {
	mockFs.existsSync.mockReturnValue(true);
	mockFs.readFileSync.mockReturnValue(JSON.stringify({ policies }));
}

describe("loadPolicies — default fallback exact content (kills defaults' string literals)", () => {
	// test-contract: public-api — no policies.json present, returns the built-in defaults verbatim
	it("returns the exact no_exfil_after_taint default for tainted_network_internal", async () => {
		mockFs.existsSync.mockReturnValue(false);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: public-api — no policies.json present, returns the built-in defaults verbatim
	it("returns the exact post_injection_compliance default for post_injection_action", async () => {
		mockFs.existsSync.mockReturnValue(false);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("post_injection_action")).toEqual([POST_INJECTION]);
	});

	// test-contract: public-api — no policies.json present, returns the built-in defaults verbatim
	it("returns the exact step_budget_justification default for high_step_budget", async () => {
		mockFs.existsSync.mockReturnValue(false);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("high_step_budget")).toEqual([STEP_BUDGET]);
	});
});

describe("loadPolicies — file path and read args (kills path/encoding literal mutants)", () => {
	// test-contract: public-api — existsSync/readFileSync are called against .interlinked/policies.json with utf-8
	it("checks/reads the path under .interlinked/policies.json with utf-8 encoding", async () => {
		mockFs.existsSync.mockReturnValue(false);
		const { loadPolicies } = await importFresh();
		const result = loadPolicies("tainted_network_internal");
		const expectedSuffix = join(".interlinked", "policies.json");
		expect(mockFs.existsSync).toHaveBeenCalledWith(expect.stringContaining(expectedSuffix));
		// readFileSync must not run when existsSync says the file is absent
		expect(mockFs.readFileSync).not.toHaveBeenCalled();
		expect(result).toEqual([NO_EXFIL]);
	});

	// test-contract: public-api — when the file exists, readFileSync is called with "utf-8"
	// and the returned custom policy content is what actually reaches loadPolicies' output
	it("reads the policies file with utf-8 encoding when present", async () => {
		const custom = {
			id: "custom",
			name: "Custom",
			description: "desc",
			applies_to_triggers: ["tainted_network_internal"],
		};
		stubPoliciesFile([custom]);
		const { loadPolicies } = await importFresh();
		const result = loadPolicies("tainted_network_internal");
		expect(mockFs.readFileSync).toHaveBeenCalledWith(expect.any(String), "utf-8");
		expect(result).toEqual([custom]);
	});

	// test-contract: boundary — existsSync=false must short-circuit before any read, even if
	// readFileSync would otherwise yield usable custom data (kills the existsSync-check-> false mutant)
	it("returns defaults and never reads the file when existsSync is false", async () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ policies: [{ ...NO_EXFIL, id: "custom_should_not_be_seen" }] }),
		);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
		expect(mockFs.readFileSync).not.toHaveBeenCalled();
	});
});

describe("loadPolicies — required-field validation (id/name/description)", () => {
	// test-contract: invariant — id wrong type invalidates the whole custom set, falling back to defaults
	it("rejects an entry whose id is not a string", async () => {
		stubPoliciesFile([
			{
				id: 123,
				name: "Custom",
				description: "desc",
				applies_to_triggers: ["tainted_network_internal"],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: invariant — name wrong type invalidates the whole custom set, falling back to defaults
	it("rejects an entry whose name is not a string", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: 123,
				description: "desc",
				applies_to_triggers: ["tainted_network_internal"],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: invariant — description wrong type invalidates the whole custom set, falling back to defaults
	it("rejects an entry whose description is not a string", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: "Custom",
				description: 123,
				applies_to_triggers: ["tainted_network_internal"],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});
});

describe("loadPolicies — applies_to_triggers validation", () => {
	// test-contract: invariant — a single non-string trigger element invalidates the entry
	it("rejects when applies_to_triggers contains a non-string element", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: "Custom",
				description: "desc",
				applies_to_triggers: [123],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: invariant — every() must check ALL elements, not just one (kills every->some)
	it("rejects a mixed applies_to_triggers array with one valid and one invalid element", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: "Custom",
				description: "desc",
				applies_to_triggers: ["tainted_network_internal", 123],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});
});

describe("loadPolicies — applies_to_roles validation", () => {
	// test-contract: invariant — applies_to_roles must be an array (kills the array-check->false mutant)
	it("rejects when applies_to_roles is not an array", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: "Custom",
				description: "desc",
				applies_to_triggers: ["tainted_network_internal"],
				applies_to_roles: "lead",
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: invariant — every element of applies_to_roles must be checked (kills every->some
	// and the OR->AND full-condition mutant for the roles guard)
	it("rejects a mixed applies_to_roles array with one valid and one invalid role", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: "Custom",
				description: "desc",
				applies_to_triggers: ["tainted_network_internal"],
				applies_to_roles: ["worker", "not_a_real_role"],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: invariant — a role string not present in AGENT_ROLES must be rejected
	// (kills the roles-predicate->true mutant and the &&->|| predicate mutant)
	it("rejects a role string that is not a known AgentRole", async () => {
		stubPoliciesFile([
			{
				id: "custom",
				name: "Custom",
				description: "desc",
				applies_to_triggers: ["tainted_network_internal"],
				applies_to_roles: ["not_a_real_role"],
			},
		]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});

	// test-contract: invariant — "lead" is a genuine member of AGENT_ROLES (kills "lead"->"" literal mutant)
	it("accepts a valid custom policy whose applies_to_roles is ['lead']", async () => {
		const custom = {
			id: "custom",
			name: "Custom",
			description: "desc",
			applies_to_triggers: ["tainted_network_internal"],
			applies_to_roles: ["lead"],
		};
		stubPoliciesFile([custom]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([custom]);
	});

	// test-contract: invariant — "unknown" is a genuine member of AGENT_ROLES (kills "unknown"->"" literal mutant)
	it("accepts a valid custom policy whose applies_to_roles is ['unknown']", async () => {
		const custom = {
			id: "custom",
			name: "Custom",
			description: "desc",
			applies_to_triggers: ["tainted_network_internal"],
			applies_to_roles: ["unknown"],
		};
		stubPoliciesFile([custom]);
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([custom]);
	});
});

describe("loadPolicies — top-level shape validation (data / data.policies)", () => {
	// test-contract: boundary — data.policies must be an actual array; an empty-string value must
	// not be silently iterated as if it were one (kills the isJsonObject||isArray ->false and ->AND
	// mutants: an empty string iterates to zero characters, producing [] instead of the correct
	// default-fallback, which is observably non-empty for this trigger)
	it("falls back to defaults when policies is a string instead of an array", async () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(JSON.stringify({ policies: "" }));
		const { loadPolicies } = await importFresh();
		expect(loadPolicies("tainted_network_internal")).toEqual([NO_EXFIL]);
	});
});
