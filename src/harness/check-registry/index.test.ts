import { describe, expect, it } from "vitest";
import * as Barrel from "./index.js";

describe("check-registry/index", () => {
	it("re-exports the public surface expected by callers", () => {
		expect(typeof Barrel.buildAgentSafetyChecks).toBe("function");
		expect(typeof Barrel.buildCheckInstructions).toBe("function");
		expect(typeof Barrel.buildGenericCheckMeta).toBe("function");
		expect(Array.isArray(Barrel.CHECK_REGISTRY)).toBe(true);
	});

	it("does not leak internal types at runtime", () => {
		// CheckPhase / CheckRegistration / InlineMatch are type-only exports —
		// they must not materialize as runtime keys on the barrel.
		const runtimeKeys = Object.keys(Barrel);
		expect(runtimeKeys).not.toContain("CheckPhase");
		expect(runtimeKeys).not.toContain("CheckRegistration");
		expect(runtimeKeys).not.toContain("InlineMatch");
	});
});
