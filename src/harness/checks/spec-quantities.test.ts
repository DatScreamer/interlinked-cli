import { describe, expect, it } from "vitest";
import { checkSpecCapacityClaims, checkSpecTableSums } from "./spec-quantities.js";

const MD = "docs/plan.md";

describe("checkSpecCapacityClaims", () => {
	it("fires on bounded fields with reuse semantics and no wrap story (P0-5)", () => {
		const positives = [
			"The 8-bit generation field is bumped on every slot reuse.",
			"A 16-bit epoch counter tracks ownership.",
			"Sequence numbers use a 12-bit slot with wrap on reuse unstated.",
		];
		for (const line of positives) {
			const out = checkSpecCapacityClaims(`# Doc\n${line}`, MD);
			expect(out, line).toHaveLength(1);
		}
		expect(checkSpecCapacityClaims("# D\nThe 8-bit generation wraps on reuse.", MD)[0]?.text).toContain(
			"256",
		);
	});

	it("flags every bit field on a line, not just the first (round-2 #28)", () => {
		const out = checkSpecCapacityClaims(
			"# D\nA 12-bit slot and an 8-bit generation counter are reused per epoch.",
			MD,
		);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.text).join(" ")).toContain("4096");
		expect(out.map((m) => m.text).join(" ")).toContain("256");
	});

	it("stays silent when addressed, out of range, or without reuse vocabulary", () => {
		const negatives = [
			"The 8-bit generation field wraps at 256 and reuse is prohibited past it.",
			"We widen the 16-bit epoch counter to 64 bits before reuse.",
			"A 64-bit checksum protects the record.", // no reuse vocab? has none of REUSE words
			"The 128-bit ObjectId is content-derived.", // out of bit range
			"An 8-bit color palette is documented here.",
		];
		for (const line of negatives) {
			expect(checkSpecCapacityClaims(`# Doc\n${line}`, MD), line).toEqual([]);
		}
		expect(checkSpecCapacityClaims("8-bit counter reuse", "src/a.ts")).toEqual([]);
	});
});

describe("checkSpecTableSums", () => {
	const badTable = [
		"| Component | Bytes |",
		"|---|---|",
		"| header | 16 |",
		"| body | 48 |",
		"| checksum | 8 |",
		"| **Total** | 80 |",
	].join("\n");

	it("fires when a Total row disagrees with the column sum", () => {
		const out = checkSpecTableSums(badTable, MD);
		expect(out).toEqual([
			expect.objectContaining({
				line: 6,
				text: expect.stringContaining("states 80"),
			}),
		]);
		expect(out[0]?.text).toContain("sum to 72");
	});

	it("stays silent on correct totals, non-numeric columns, and tiny tables", () => {
		const good = badTable.replace("| **Total** | 80 |", "| **Total** | 72 |");
		expect(checkSpecTableSums(good, MD)).toEqual([]);
		const nonNumeric = [
			"| Name | Role |",
			"|---|---|",
			"| a | x |",
			"| total | everything |",
		].join("\n");
		expect(checkSpecTableSums(nonNumeric, MD)).toEqual([]);
		const tiny = ["| A | B |", "|---|---|", "| Total | 5 |"].join("\n");
		expect(checkSpecTableSums(tiny, MD)).toEqual([]);
	});

	it("does not split on escaped pipes inside cells (round-2 #29)", () => {
		const table = [
			"| Field | Note |",
			"|---|---|",
			"| a | uses \\| as delimiter |",
			"| b | plain |",
			"| Total | 5 |",
		].join("\n");
		// The escaped pipe must not create a phantom column; no numeric total
		// mismatch is fabricated.
		expect(checkSpecTableSums(table, MD)).toEqual([]);
	});

	it("handles comma-grouped numbers and multiple numeric columns", () => {
		const table = [
			"| Part | Count | Bytes |",
			"|---|---|---|",
			"| a | 1,000 | 10 |",
			"| b | 2,000 | 20 |",
			"| Total | 3,000 | 31 |",
		].join("\n");
		const out = checkSpecTableSums(table, MD);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("column 3");
	});
});
