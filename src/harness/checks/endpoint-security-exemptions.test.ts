// ===========================================
// Endpoint-security family gate — predicate tests
// ===========================================
// Pins the family-level FP gate: test files, fixture trees, and vendored
// code are not deployable endpoints, so no endpoint_* detector may fire on
// them; real source handler files must stay in scope.
import { describe, expect, it } from "vitest";

import { isEndpointSecurityExemptFile } from "./endpoint-security-exemptions.js";

describe("isEndpointSecurityExemptFile", () => {
	// --- exempt (the ~57-finding dogfood FP shapes) ---
	it("exempts *.test.ts files", () => {
		expect(isEndpointSecurityExemptFile("src/harness/route-map/express.test.ts")).toBe(true);
	});

	it("exempts files under __tests__/ (including fixtures below it)", () => {
		expect(
			isEndpointSecurityExemptFile(
				"src/harness/__tests__/fixtures/route-extraction/mcp/server.ts",
			),
		).toBe(true);
	});

	it("exempts __fixtures__/ trees (not covered by the shared fixtures/ segment)", () => {
		expect(isEndpointSecurityExemptFile("src/routes/__fixtures__/vulnerable-server.ts")).toBe(
			true,
		);
	});

	it("exempts vendored / example trees via the shared predicate", () => {
		expect(isEndpointSecurityExemptFile("vendor/express-app/routes.js")).toBe(true);
		expect(isEndpointSecurityExemptFile("examples/api/users.ts")).toBe(true);
	});

	it("exempts Python test files", () => {
		expect(isEndpointSecurityExemptFile("api/test_routes.py")).toBe(true);
	});

	// --- NOT exempt (real deployable source must stay in scope) ---
	it("keeps ordinary route source files in scope", () => {
		expect(isEndpointSecurityExemptFile("src/routes/users.ts")).toBe(false);
	});

	it("keeps a server.ts outside any fixture tree in scope", () => {
		expect(isEndpointSecurityExemptFile("src/server.ts")).toBe(false);
	});

	it("is not fooled by test-ish substrings that aren't test conventions", () => {
		// "latest" contains "test"; "test-handler.ts" is not *.test.ts.
		expect(isEndpointSecurityExemptFile("src/latest/handler.ts")).toBe(false);
		expect(isEndpointSecurityExemptFile("/tmp/test-handler.ts")).toBe(false);
	});

	it("keeps Python app modules in scope", () => {
		expect(isEndpointSecurityExemptFile("app/main.py")).toBe(false);
	});
});
