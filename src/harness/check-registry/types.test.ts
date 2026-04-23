import { describe, expect, it } from "vitest";
import type { CheckPhase, CheckRegistration, InlineMatch } from "./types.js";

// These tests live at the compile-time / shape level: they confirm the
// structural contract every entry file must honor. If someone changes the
// CheckRegistration shape without updating callers, tsc catches it first —
// these tests pin the runtime expectations.

describe("check-registry/types", () => {
	it("CheckPhase is a string union of the three pipeline stages", () => {
		const phases: CheckPhase[] = ["pre_block", "pre_warn", "post"];
		expect(phases).toHaveLength(3);
		expect(new Set(phases).size).toBe(3);
	});

	it("CheckRegistration requires every field a consumer relies on", () => {
		const reg: CheckRegistration = {
			id: "demo",
			name: "Demo",
			description: "placeholder",
			tier: 1,
			determinism: "fully_deterministic",
			severity: "warning",
			pipeline: "agent_safety",
			phase: "pre_warn",
			fix_instruction: "do the thing",
			fn: () => [],
			resultsPropName: "demo",
		};
		expect(reg.id).toBe("demo");
		expect(reg.tier).toBe(1);
		expect(reg.fn("", "x.ts")).toEqual([]);
	});

	it("InlineMatch has the {line, text} shape emitted by every check", () => {
		const m: InlineMatch = { line: 7, text: "x as any" };
		expect(m.line).toBeGreaterThan(0);
		expect(typeof m.text).toBe("string");
	});
});
