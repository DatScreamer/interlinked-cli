import { describe, expect, it } from "vitest";
import { renderAggregate, renderFooter, renderRows } from "./render.js";
import type { TailScanStats } from "./reverse-reader.js";

// Built with fromCharCode so this test file never contains a raw control byte
// itself — a raw NUL in a fixture trips binary_content and suppresses every
// other inline check on the file (the exact failure mode render.ts sanitizes).
const NUL = String.fromCharCode(0);

function stats(overrides: Partial<TailScanStats> = {}): TailScanStats {
	return {
		fileBytes: 1024,
		bytesScanned: 512,
		recordsParsed: 42,
		malformedLines: 0,
		truncated: false,
		...overrides,
	};
}

describe("renderRows", () => {
	it("renders one line per record with the requested fields", () => {
		const lines = renderRows(
			[
				{ ts: "2026-07-24T10:00:00Z", tool: "Bash", summary: "rm -rf blocked" },
				{ ts: "2026-07-24T10:01:00Z", tool: "Write", summary: "ok" },
			],
			["tool", "summary"],
			false,
		);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Bash");
		expect(lines[0]).toContain("rm -rf blocked");
		expect(lines[1]).toContain("Write");
	});

	it("marks absent fields with a placeholder dot", () => {
		const lines = renderRows([{ ts: "2026-07-24T10:00:00Z" }], ["missing"], false);
		expect(lines[0]).toContain("·");
	});

	it("flattens newlines and control bytes in cell values", () => {
		const lines = renderRows(
			[{ ts: "2026-07-24T10:00:00Z", text: `line1\nline2${NUL}end` }],
			["text"],
			false,
		);
		expect(lines[0]).toContain("line1 line2 end");
	});

	it("truncates long values unless full mode", () => {
		const long = "x".repeat(300);
		const truncated = renderRows([{ ts: "t", text: long }], ["text"], false);
		expect(truncated[0]).toContain("…");
		expect(truncated[0]?.length).toBeLessThan(200);
		const full = renderRows([{ ts: "t", text: long }], ["text"], true);
		expect(full[0]).toContain(long);
	});
});

describe("renderAggregate", () => {
	it("renders counts right-aligned with keys", () => {
		const lines = renderAggregate([
			{ key: "nan_coercion_guard", count: 12 },
			{ key: "floating_promises", count: 3 },
		]);
		expect(lines[0]).toMatch(/12\s+nan_coercion_guard/);
		expect(lines[1]).toMatch(/\b3\s+floating_promises/);
	});

	it("includes a sum column when present", () => {
		const lines = renderAggregate([{ key: "s1", count: 2, sum: 950 }]);
		expect(lines[0]).toMatch(/950/);
		expect(lines[0]).toMatch(/s1/);
	});
});

describe("renderFooter", () => {
	it("reports a complete scan plainly", () => {
		const footer = renderFooter(stats(), "blocks", {});
		expect(footer).toContain("scanned all 42 records");
		expect(footer).toContain("blocks");
	});

	it("reports budget truncation with the widening flags", () => {
		const footer = renderFooter(stats({ truncated: true, stopReason: "records" }), "events", {});
		expect(footer).toContain("newest 42 records");
		expect(footer).toContain("--last");
	});

	it("reports a limit stop as more-may-match", () => {
		const footer = renderFooter(stats({ truncated: true, stopReason: "caller" }), "blocks", {
			limitStopped: true,
		});
		expect(footer).toContain("--limit");
	});

	it("reports a since stop without alarming truncation language", () => {
		const footer = renderFooter(stats({ truncated: true, stopReason: "caller" }), "blocks", {
			sinceStopped: true,
		});
		expect(footer).toContain("--since");
		expect(footer).not.toContain("widen with");
	});

	it("mentions malformed lines only when present", () => {
		expect(renderFooter(stats({ malformedLines: 2 }), "x", {})).toContain("2 malformed");
		expect(renderFooter(stats(), "x", {})).not.toContain("malformed");
	});
});
