// ===========================================
// Sibling smoke test — endpoint-security detectors
// ===========================================
// The full positive/negative suite for the five Phase B detectors lives
// at `src/harness/__tests__/endpoint-security.test.ts` (next to the other
// __tests__ entries for cross-cutting harness modules). This sibling
// file exists so the TDD red/green gate finds a test next to the
// implementation; it pins the module's public surface in case a refactor
// renames an export.
import { describe, expect, it } from "vitest";

import {
	checkEndpointAuthMissing,
	checkEndpointIdorShape,
	checkEndpointMassAssignment,
	checkEndpointMissingTenantFilter,
	checkEndpointSsrfShape,
	runAllEndpointSecurityChecks,
} from "./endpoint-security.js";

describe("endpoint-security public surface", () => {
	it("exports the five detector functions", () => {
		expect(typeof checkEndpointAuthMissing).toBe("function");
		expect(typeof checkEndpointIdorShape).toBe("function");
		expect(typeof checkEndpointMissingTenantFilter).toBe("function");
		expect(typeof checkEndpointSsrfShape).toBe("function");
		expect(typeof checkEndpointMassAssignment).toBe("function");
	});

	it("exports the batch helper", () => {
		expect(typeof runAllEndpointSecurityChecks).toBe("function");
	});
});
