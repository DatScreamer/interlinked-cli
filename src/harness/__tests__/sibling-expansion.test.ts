// Phase D — endpoint-detector sibling rescan transformer tests.
//
// These tests exercise `expandEndpointDetectorSiblings` — the pure
// `findings → findings` transformer that bundles sibling endpoints into a
// lead finding's message. Tests use synthetic `rescan` closures so they're
// fast and detector-independent (per the plan: "Use synthetic `rescan`
// closures in tests, not real detectors").

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { DetectorFinding } from "../checks/endpoint-security.js";
import { expandEndpointDetectorSiblings } from "../sibling-expansion.js";

/** Build a DetectorFinding with sensible defaults — only the fields the
 * transformer actually inspects are required by the test cases. */
function finding(p: Partial<DetectorFinding> & { check_id: string; file: string; line: number }): DetectorFinding {
	return {
		message: `default message for ${p.check_id} at ${p.file}:${p.line}`,
		...p,
	};
}

describe("expandEndpointDetectorSiblings", () => {
	it("returns the input unchanged when there are no findings", () => {
		const out = expandEndpointDetectorSiblings([], {
			rescan: () => [],
			readFile: () => "",
		});
		expect(out).toEqual([]);
	});

	it("single finding, no siblings discovered → message is unchanged", () => {
		const original = [
			finding({ check_id: "endpoint_idor_shape", file: "/abs/routes/users.ts", line: 12 }),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => [
				// Rescan returns just the original hit — no siblings.
				finding({ check_id: "endpoint_idor_shape", file: "/abs/routes/users.ts", line: 12 }),
			],
			readFile: () => "// fake file contents",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe(nonNull(original[0]).message);
		// Input must not have been mutated.
		expect(nonNull(original[0]).message).toBe(`default message for endpoint_idor_shape at /abs/routes/users.ts:12`);
	});

	it("single finding with 2 siblings → first finding's message gets bundle suffix listing sibling lines", () => {
		const original = [
			finding({
				check_id: "endpoint_idor_shape",
				file: "/abs/routes/users.ts",
				line: 12,
				message: "IDOR shape at /users/:id",
			}),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => [
				finding({ check_id: "endpoint_idor_shape", file: "/abs/routes/users.ts", line: 12 }),
				finding({ check_id: "endpoint_idor_shape", file: "/abs/routes/users.ts", line: 47 }),
				finding({ check_id: "endpoint_idor_shape", file: "/abs/routes/users.ts", line: 89 }),
			],
			readFile: () => "// fake file contents",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("IDOR shape at /users/:id");
		expect(nonNull(out[0]).message).toContain("Same shape on 2 sibling endpoints in users.ts: 47, 89");
		// Sibling-line list must be sorted ascending.
		expect(nonNull(out[0]).message.indexOf("47")).toBeLessThan(nonNull(out[0]).message.indexOf("89"));
	});

	it("group with N pre-discovered findings + extra siblings on rescan → bundle counts only the NEW siblings, lists them sorted", () => {
		const original = [
			finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 10 }),
			finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 50 }),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => [
				// Rescan reports the same two PLUS two more endpoints.
				finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 10 }),
				finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 50 }),
				finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 75 }),
				finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 30 }),
			],
			readFile: () => "// fake",
		});
		expect(out).toHaveLength(2);
		// Only the lead (index 0) gets the suffix — the second finding is untouched.
		expect(nonNull(out[0]).message).toContain("Same shape on 2 sibling endpoints in r.ts: 30, 75");
		expect(nonNull(out[1]).message).not.toContain("Same shape on");
	});

	it("single sibling uses singular noun (1 sibling endpoint, not endpoints)", () => {
		const original = [
			finding({ check_id: "endpoint_ssrf_shape", file: "/abs/x.ts", line: 5 }),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => [
				finding({ check_id: "endpoint_ssrf_shape", file: "/abs/x.ts", line: 5 }),
				finding({ check_id: "endpoint_ssrf_shape", file: "/abs/x.ts", line: 42 }),
			],
			readFile: () => "// fake",
		});
		expect(nonNull(out[0]).message).toContain("Same shape on 1 sibling endpoint in x.ts: 42");
		// Make sure we didn't say "endpoints" with the singular count.
		expect(nonNull(out[0]).message).not.toContain("1 sibling endpoints");
	});

	it("two different check_ids in the same file → each group expanded independently, neither bleeds into the other", () => {
		const original = [
			finding({ check_id: "endpoint_idor_shape", file: "/abs/r.ts", line: 12 }),
			finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 12 }),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => [
				finding({ check_id: "endpoint_idor_shape", file: "/abs/r.ts", line: 12 }),
				finding({ check_id: "endpoint_idor_shape", file: "/abs/r.ts", line: 60 }),
				finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 12 }),
				finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 80 }),
			],
			readFile: () => "// fake",
		});
		expect(out).toHaveLength(2);
		// IDOR group bundles only the IDOR sibling.
		const idor = out.find((f) => f.check_id === "endpoint_idor_shape");
		expect(idor?.message).toContain("Same shape on 1 sibling endpoint in r.ts: 60");
		expect(idor?.message).not.toContain("80");
		// Auth group bundles only the auth sibling.
		const auth = out.find((f) => f.check_id === "endpoint_auth_missing");
		expect(auth?.message).toContain("Same shape on 1 sibling endpoint in r.ts: 80");
		expect(auth?.message).not.toContain("60");
	});

	it("two different files → siblings only within the same file, no cross-file bundling", () => {
		const original = [
			finding({ check_id: "endpoint_mass_assignment", file: "/abs/users.ts", line: 12 }),
			finding({ check_id: "endpoint_mass_assignment", file: "/abs/orgs.ts", line: 20 }),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: (file) => {
				if (file === "/abs/users.ts") {
					return [
						finding({ check_id: "endpoint_mass_assignment", file: "/abs/users.ts", line: 12 }),
						finding({ check_id: "endpoint_mass_assignment", file: "/abs/users.ts", line: 99 }),
					];
				}
				if (file === "/abs/orgs.ts") {
					return [
						finding({ check_id: "endpoint_mass_assignment", file: "/abs/orgs.ts", line: 20 }),
					];
				}
				return [];
			},
			readFile: () => "// fake",
		});
		expect(out).toHaveLength(2);
		// Users file: 1 sibling (line 99).
		const users = out.find((f) => f.file === "/abs/users.ts");
		expect(users?.message).toContain("Same shape on 1 sibling endpoint in users.ts: 99");
		expect(users?.message).not.toContain("orgs.ts");
		// Orgs file: no siblings, message unchanged.
		const orgs = out.find((f) => f.file === "/abs/orgs.ts");
		expect(orgs?.message).not.toContain("Same shape on");
	});

	it("rescan throws → original findings returned unchanged (resilience)", () => {
		const original = [
			finding({
				check_id: "endpoint_idor_shape",
				file: "/abs/users.ts",
				line: 12,
				message: "original message",
			}),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => {
				throw new Error("detector blew up");
			},
			readFile: () => "// fake",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe("original message");
	});

	it("readFile throws → original findings returned unchanged, rescan is never called for that file", () => {
		let rescanCalled = false;
		const original = [
			finding({ check_id: "endpoint_idor_shape", file: "/abs/missing.ts", line: 1 }),
		];
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => {
				rescanCalled = true;
				return [];
			},
			readFile: () => {
				throw new Error("ENOENT: /abs/missing.ts");
			},
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe(nonNull(original[0]).message);
		expect(rescanCalled).toBe(false);
	});

	it("does not mutate the input array or its findings", () => {
		const original: DetectorFinding[] = [
			finding({
				check_id: "endpoint_ssrf_shape",
				file: "/abs/r.ts",
				line: 1,
				message: "original",
			}),
		];
		const snapshot = JSON.stringify(original);
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => [
				finding({ check_id: "endpoint_ssrf_shape", file: "/abs/r.ts", line: 1 }),
				finding({ check_id: "endpoint_ssrf_shape", file: "/abs/r.ts", line: 99 }),
			],
			readFile: () => "// fake",
		});
		expect(JSON.stringify(original)).toBe(snapshot);
		expect(out[0]).not.toBe(original[0]);
	});

	it("caches file content and rescan output across groups in the same call (one read, one rescan per file)", () => {
		let readCount = 0;
		let rescanCount = 0;
		const original = [
			finding({ check_id: "endpoint_idor_shape", file: "/abs/r.ts", line: 10 }),
			finding({ check_id: "endpoint_auth_missing", file: "/abs/r.ts", line: 20 }),
			finding({ check_id: "endpoint_ssrf_shape", file: "/abs/r.ts", line: 30 }),
		];
		expandEndpointDetectorSiblings(original, {
			rescan: () => {
				rescanCount += 1;
				return [];
			},
			readFile: () => {
				readCount += 1;
				return "// fake";
			},
		});
		expect(readCount).toBe(1);
		expect(rescanCount).toBe(1);
	});

	it("scales to 100-endpoint inputs without quadratic blow-up — correct output for the bundle (perf budget verified separately)", () => {
		// Build 100 findings in one file. The rescan returns all 100 plus 50
		// additional sibling lines so the bundle path is exercised on a
		// large input. Wall-clock assertions are intentionally avoided here:
		// the plan's <100ms budget is verified in an out-of-band probe;
		// unit tests stay deterministic per the harness's
		// `test_nondeterminism` rule.
		const file = "/abs/big-router.ts";
		const original: DetectorFinding[] = [];
		for (let i = 0; i < 100; i += 1) {
			original.push(finding({ check_id: "endpoint_idor_shape", file, line: i + 1 }));
		}
		const rescanResult: DetectorFinding[] = [];
		for (let i = 0; i < 150; i += 1) {
			rescanResult.push(finding({ check_id: "endpoint_idor_shape", file, line: i + 1 }));
		}
		const out = expandEndpointDetectorSiblings(original, {
			rescan: () => rescanResult,
			readFile: () => "// fake",
		});
		expect(out).toHaveLength(100);
		expect(nonNull(out[0]).message).toContain("Same shape on 50 sibling endpoints");
		// Subsequent findings unchanged — only the lead carries the bundle.
		expect(nonNull(out[1]).message).not.toContain("Same shape on");
		expect(nonNull(out[99]).message).not.toContain("Same shape on");
	});
});
