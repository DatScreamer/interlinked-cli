// Pins the SandboxJob contract — the load-bearing assertion is that the wire
// shape has no execution channel and the validator rejects any smuggled one.

import { describe, expect, it } from "vitest";
import { isValidSandboxJobRequest, type SandboxJobRequest } from "./types.js";

const base: SandboxJobRequest = {
	schemaVersion: 1,
	kind: "leak",
	sessionId: "s1",
	file: "src/x.ts",
	overlays: [{ path: "src/x.ts", content: "export const a = 1;" }],
	timeoutMs: 25_000,
	riskTier: "lite",
};

describe("isValidSandboxJobRequest", () => {
	it("accepts a well-formed request for every known kind", () => {
		for (const kind of ["mutation", "leak", "flake", "asan", "miri"] as const) {
			expect(isValidSandboxJobRequest({ ...base, kind })).toBe(true);
		}
	});

	it("rejects an unknown kind", () => {
		expect(isValidSandboxJobRequest({ ...base, kind: "arbitrary" })).toBe(false);
	});

	it("rejects any smuggled execution channel (the security invariant)", () => {
		for (const forbidden of ["command", "argv", "script", "cmd", "exec", "shell"]) {
			expect(
				isValidSandboxJobRequest({ ...base, [forbidden]: "rm -rf /" }),
				`must reject a request carrying '${forbidden}'`,
			).toBe(false);
		}
	});

	it("rejects malformed overlays and missing required fields", () => {
		expect(isValidSandboxJobRequest({ ...base, overlays: "nope" })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, overlays: [{ path: "x" }] })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, schemaVersion: 2 })).toBe(false);
		expect(isValidSandboxJobRequest({ ...base, timeoutMs: "soon" })).toBe(false);
		expect(isValidSandboxJobRequest(null)).toBe(false);
		expect(isValidSandboxJobRequest("string")).toBe(false);
	});
});
