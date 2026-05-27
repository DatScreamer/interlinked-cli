// Sanity tests for the endpoint-security registry entries. Detector logic
// is tested in src/harness/__tests__/endpoint-security.test.ts; adapter
// wiring is tested in src/harness/check-registry/endpoint-security-adapters.test.ts.
// This file just pins the contract of the registry entries: ids, phase,
// severity, pipeline, and presence in the combined warning array.

import { describe, expect, it } from "vitest";

import { ENDPOINT_SECURITY_ENTRIES } from "./endpoint-security.js";

const EXPECTED_IDS = [
	"endpoint_auth_missing",
	"endpoint_idor_shape",
	"endpoint_missing_tenant_filter",
	"endpoint_ssrf_shape",
	"endpoint_mass_assignment",
];

describe("ENDPOINT_SECURITY_ENTRIES", () => {
	it("registers exactly the five Phase B detector ids", () => {
		const ids = ENDPOINT_SECURITY_ENTRIES.map((e) => e.id).sort();
		expect(ids).toEqual([...EXPECTED_IDS].sort());
	});

	it("each entry is a PostToolUse warning in the agent_safety pipeline", () => {
		for (const entry of ENDPOINT_SECURITY_ENTRIES) {
			expect(entry.phase).toBe("post");
			expect(entry.severity).toBe("warning");
			expect(entry.pipeline).toBe("agent_safety");
			expect(entry.determinism).toBe("heuristic");
		}
	});

	it("each entry has a callable detector adapter", () => {
		for (const entry of ENDPOINT_SECURITY_ENTRIES) {
			expect(typeof entry.fn).toBe("function");
			// Adapter must return [] on a file with no endpoints — fail-open
			// posture inherited from the registry-call-site shim. The
			// adapter file path is non-existent on purpose; the adapter
			// should fail-open without throwing.
			const result = entry.fn("// no endpoints", "/tmp/interlinked-fixture/blank.ts");
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(0);
		}
	});

	it("each entry declares a unique resultsPropName", () => {
		const names = ENDPOINT_SECURITY_ENTRIES.map((e) => e.resultsPropName);
		const unique = new Set(names);
		expect(unique.size).toBe(names.length);
	});

	it("each entry has a non-empty fix_instruction", () => {
		for (const entry of ENDPOINT_SECURITY_ENTRIES) {
			expect(entry.fix_instruction.length).toBeGreaterThan(20);
		}
	});
});
