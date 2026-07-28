import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	actionToPhase,
	DEFAULT_POLICY,
	defaultActionFor,
	loadCheckPolicy,
	resolveAction,
	summarizePolicy,
} from "./check-policy.js";
import { CHECK_REGISTRY } from "./check-registry/registry.js";
import type { CheckPhase, CheckRegistration } from "./check-registry/types.js";

/** Build a deterministic check registration for phase-mapping tests. */
function mockCheck(phase: CheckPhase, id = "mock_check"): CheckRegistration {
	return {
		id,
		name: "Mock",
		description: "test fixture",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		phase,
		fix_instruction: "",
		fn: () => [],
		resultsPropName: "mockCheck",
	};
}

describe("defaultActionFor", () => {
	it("maps pre_block → ask (preserves today's behavior)", () => {
		expect(defaultActionFor(mockCheck("pre_block"))).toBe("ask");
	});

	it("maps pre_warn → warn_before", () => {
		expect(defaultActionFor(mockCheck("pre_warn"))).toBe("warn_before");
	});

	it("maps post → warn_after", () => {
		expect(defaultActionFor(mockCheck("post"))).toBe("warn_after");
	});
});

describe("actionToPhase", () => {
	it("silent resolves to null (excluded entirely)", () => {
		expect(actionToPhase("silent")).toBeNull();
	});

	it("info and warn_after fire at post phase", () => {
		expect(actionToPhase("info")).toBe("post");
		expect(actionToPhase("warn_after")).toBe("post");
	});

	it("warn_before and ratchet fire at pre_warn phase", () => {
		expect(actionToPhase("warn_before")).toBe("pre_warn");
		expect(actionToPhase("ratchet")).toBe("pre_warn");
	});

	it("ask, block_preview, auto_fix all fire at pre_block phase", () => {
		expect(actionToPhase("ask")).toBe("pre_block");
		expect(actionToPhase("block_preview")).toBe("pre_block");
		expect(actionToPhase("auto_fix")).toBe("pre_block");
	});
});

describe("loadCheckPolicy", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "check-policy-test-"));
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns DEFAULT_POLICY when no files are present", () => {
		const policy = loadCheckPolicy(tmp);
		expect(policy.defaults).toEqual(DEFAULT_POLICY.defaults);
		expect(policy.checks).toEqual({});
	});

	it("reads team policy from check-policy.json", () => {
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({
				version: 1,
				checks: { placeholder_test: { action: "block_preview" } },
			}),
		);
		const policy = loadCheckPolicy(tmp);
		expect(nonNull(policy.checks.placeholder_test).action).toBe("block_preview");
	});

	it("local 'overrides' key wins over team 'checks' key", () => {
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({ checks: { default_export: { action: "warn_after" } } }),
		);
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.local.json"),
			JSON.stringify({ overrides: { default_export: { action: "silent" } } }),
		);
		const policy = loadCheckPolicy(tmp);
		expect(nonNull(policy.checks.default_export).action).toBe("silent");
	});

	it("local overrides merge field-by-field rather than replacing wholesale", () => {
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({
				checks: { sql_injection: { action: "block_preview", scope: "touched_file" } },
			}),
		);
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.local.json"),
			JSON.stringify({ overrides: { sql_injection: { action: "warn_before" } } }),
		);
		const policy = loadCheckPolicy(tmp);
		expect(nonNull(policy.checks.sql_injection).action).toBe("warn_before");
		expect(nonNull(policy.checks.sql_injection).scope).toBe("touched_file");
	});

	it("malformed JSON falls back to defaults without throwing", () => {
		writeFileSync(join(tmp, ".interlinked", "check-policy.json"), "{ not json");
		const policy = loadCheckPolicy(tmp);
		expect(policy.defaults).toEqual(DEFAULT_POLICY.defaults);
	});

	it("coverage_ratchet and mutation_gate config flow through", () => {
		writeFileSync(
			join(tmp, ".interlinked", "check-policy.json"),
			JSON.stringify({
				coverage_ratchet: { enabled: true, allow_decrease_pct: 0 },
				mutation_gate: { enabled: true, min_score: 0.7, schedule: "pre_push" },
			}),
		);
		const policy = loadCheckPolicy(tmp);
		expect(policy.coverage_ratchet.enabled).toBe(true);
		expect(policy.mutation_gate.min_score).toBe(0.7);
		expect(policy.mutation_gate.schedule).toBe("pre_push");
	});
});

describe("resolveAction", () => {
	it("falls back to registration default when no policy entry exists", () => {
		const check = nonNull(CHECK_REGISTRY[0]);
		const policy = { ...DEFAULT_POLICY, checks: {} };
		const resolved = resolveAction(check, policy);
		expect(resolved.source).toBe("default");
		expect(resolved.action).toBe(defaultActionFor(check));
	});

	it("uses policy entry when present and marks source as 'policy'", () => {
		const check = nonNull(CHECK_REGISTRY[0]);
		const policy = {
			...DEFAULT_POLICY,
			checks: { [check.id]: { action: "block_preview" as const } },
		};
		const resolved = resolveAction(check, policy);
		expect(resolved.source).toBe("policy");
		expect(resolved.action).toBe("block_preview");
		expect(resolved.phase).toBe("pre_block");
	});

	it("resolved scope comes from entry when set, else defaults", () => {
		const check = nonNull(CHECK_REGISTRY[0]);
		const policy = {
			...DEFAULT_POLICY,
			defaults: { action: "warn_after" as const, scope: "diff" as const },
			checks: { [check.id]: { scope: "touched_file" as const } },
		};
		const resolved = resolveAction(check, policy);
		expect(resolved.scope).toBe("touched_file");
	});
});

describe("summarizePolicy", () => {
	it("counts every check into exactly one action bucket when walking the live registry", () => {
		const counts = summarizePolicy(DEFAULT_POLICY);
		const total = Object.values(counts).reduce((a, b) => a + b, 0);
		expect(total).toBe(CHECK_REGISTRY.length);
	});

	it("shifts counts from warn_after → block_preview when a post-phase check is overridden", () => {
		const registry = [mockCheck("post", "a"), mockCheck("post", "b")];
		const before = summarizePolicy(DEFAULT_POLICY, registry);
		expect(before.warn_after).toBe(2);
		expect(before.block_preview).toBe(0);

		const policy = {
			...DEFAULT_POLICY,
			checks: { a: { action: "block_preview" as const } },
		};
		const after = summarizePolicy(policy, registry);
		expect(after.block_preview).toBe(1);
		expect(after.warn_after).toBe(1);
	});

	it("silent-action overrides remove the check from every phase bucket", () => {
		const registry = [mockCheck("post", "a")];
		const policy = {
			...DEFAULT_POLICY,
			checks: { a: { action: "silent" as const } },
		};
		const counts = summarizePolicy(policy, registry);
		expect(counts.silent).toBe(1);
		expect(counts.warn_after).toBe(0);
	});
});
