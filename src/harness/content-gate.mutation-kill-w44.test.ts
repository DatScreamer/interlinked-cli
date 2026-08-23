import { describe, expect, it } from "vitest";
import {
	GATE_SEVERITY_ERROR,
	GATE_SEVERITY_WARNING,
	type GateFailure,
	type GateResult,
	formatGateResult,
} from "./content-gate.js";

function mk(overrides: Partial<GateFailure>): GateFailure {
	return {
		path: "x.ts",
		tool: "biome",
		code: "C",
		line: 1,
		message: "m",
		severity: GATE_SEVERITY_ERROR,
		...overrides,
	};
}

describe("formatGateResult — positive (must fire correctly)", () => {
	it("P1: ok=true and zero failures produces the exact clean-path message", () => {
		const result: GateResult = { ok: true, failures: [], elapsedMs: 5 };
		expect(formatGateResult(result)).toBe("interlinked gate: clean (5ms)");
	});

	it("P2: ok=true but non-empty failures must NOT take the clean-path branch", () => {
		const result: GateResult = {
			ok: true,
			failures: [mk({ path: "y.ts", tool: "tsc", code: "TS1", line: 9, message: "oops" })],
			elapsedMs: 1,
		};
		const out = formatGateResult(result);
		expect(out).not.toBe("interlinked gate: clean (1ms)");
		expect(out).toBe(
			"interlinked gate: 1 blocking failure(s), 0 warning(s) across 1 file(s) (1ms)\n\n" +
				"  y.ts\n" +
				"    tsc: TS1 line 9 — oops",
		);
	});

	it("P3: ok=false with zero failures renders the full (empty) report, not the clean text", () => {
		const result: GateResult = { ok: false, failures: [], elapsedMs: 7 };
		expect(formatGateResult(result)).toBe(
			"interlinked gate: 0 blocking failure(s), 0 warning(s) across 0 file(s) (7ms)",
		);
	});

	it("P4: mixed severities/lines across two files render exact counts, markers, locations, and trailing trim", () => {
		const result: GateResult = {
			ok: false,
			failures: [
				mk({ path: "a.ts", tool: "biome", code: "ruleA", line: 5, message: "msg A", severity: GATE_SEVERITY_ERROR }),
				mk({ path: "a.ts", tool: "tsc", code: "TS999", line: 0, message: "msg B", severity: GATE_SEVERITY_WARNING }),
				mk({ path: "b.ts", tool: "pre_block", code: "ruleC", line: 3, message: "msg C", severity: GATE_SEVERITY_ERROR }),
			],
			elapsedMs: 42,
		};
		const out = formatGateResult(result);
		expect(out).toBe(
			"interlinked gate: 2 blocking failure(s), 1 warning(s) across 2 file(s) (42ms)\n\n" +
				"  a.ts\n" +
				"    biome: ruleA line 5 — msg A\n" +
				"    tsc: warn: TS999 global — msg B\n\n" +
				"  b.ts\n" +
				"    pre_block: ruleC line 3 — msg C",
		);
		// No trailing newline — pins trimEnd() over trimStart() and the "\n" join separator.
		expect(out.endsWith("\n")).toBe(false);
		expect(out.split("\n").length).toBeGreaterThan(1);
	});

	it("P5: two failures on the SAME path are both retained in one group (byFile grouping is additive, not reset-per-failure)", () => {
		const result: GateResult = {
			ok: false,
			failures: [
				mk({ path: "x.ts", tool: "biome", code: "C1", line: 1, message: "m1", severity: GATE_SEVERITY_ERROR }),
				mk({ path: "x.ts", tool: "tsc", code: "C2", line: 2, message: "m2", severity: GATE_SEVERITY_WARNING }),
			],
			elapsedMs: 9,
		};
		expect(formatGateResult(result)).toBe(
			"interlinked gate: 1 blocking failure(s), 1 warning(s) across 1 file(s) (9ms)\n\n" +
				"  x.ts\n" +
				"    biome: C1 line 1 — m1\n" +
				"    tsc: warn: C2 line 2 — m2",
		);
	});
});

describe("formatGateResult — negative (must not miscount)", () => {
	it("N1: line===0 renders 'global', not 'line 0'", () => {
		const result: GateResult = {
			ok: false,
			failures: [mk({ path: "z.ts", line: 0, message: "no line" })],
			elapsedMs: 2,
		};
		expect(formatGateResult(result)).toBe(
			"interlinked gate: 1 blocking failure(s), 0 warning(s) across 1 file(s) (2ms)\n\n" +
				"  z.ts\n" +
				"    biome: C global — no line",
		);
	});

	it("N2: a warning-only file never counts toward blocking", () => {
		const result: GateResult = {
			ok: false,
			failures: [mk({ path: "w.ts", severity: GATE_SEVERITY_WARNING })],
			elapsedMs: 3,
		};
		expect(formatGateResult(result)).toBe(
			"interlinked gate: 0 blocking failure(s), 1 warning(s) across 1 file(s) (3ms)\n\n" +
				"  w.ts\n" +
				"    biome: warn: C line 1 — m",
		);
	});
});
