import { describe, expect, it } from "vitest";
import { hasUnicodeWordGlue, stripEmphasis } from "./emphasis-strip.js";

describe("stripEmphasis (paired-only, round-7 #5)", () => {
	it("strips word-edge pairs", () => {
		expect(stripEmphasis("**bold** and *em* and `code`")).toBe(
			"bold and em and code",
		);
		expect(stripEmphasis("| **B1** | Chronicle |")).toBe("| B1 | Chronicle |");
	});

	it("keeps intraword and lone markers literal", () => {
		expect(stripEmphasis("A*1 through A*9")).toBe("A*1 through A*9");
		expect(stripEmphasis("- A*1")).toBe("- A*1");
		expect(stripEmphasis("lone ` tick")).toBe("lone ` tick");
	});

	it("keeps underscore handling unchanged (sol-max #5/#7)", () => {
		expect(stripEmphasis("B_1 stays")).toBe("B_1 stays");
		expect(stripEmphasis("\\_B1")).toBe("\\_B1");
		expect(stripEmphasis("_em_ goes")).toBe("em goes");
	});
});

describe("emphasis-strip (round-7 review fixes)", () => {
	it("stays linear on many opener-only backtick runs (#1 quadratic)", () => {
		const evil = "`a ".repeat(16_000); // 16k opener runs, none can close
		const start = Date.now();
		stripEmphasis(evil);
		expect(Date.now() - start).toBeLessThan(500);
	});

	it("keeps a lone/boundary underscore literal so it cannot fabricate ids (#4)", () => {
		expect(stripEmphasis("_A1 through A9")).toBe("_A1 through A9");
		expect(stripEmphasis("see _lonely word")).toBe("see _lonely word");
		expect(stripEmphasis("\\_B1")).toBe("\\_B1"); // escaped stays
		// genuine paired emphasis still strips
		expect(stripEmphasis("_em_ goes")).toBe("em goes");
		expect(stripEmphasis("**bold** ok")).toBe("bold ok");
	});
});

describe("hasUnicodeWordGlue (round-7 #2)", () => {
	it("detects glue by whole code point on either side", () => {
		expect(hasUnicodeWordGlue("éREQ-1", 1, 6)).toBe(true);
		expect(hasUnicodeWordGlue("REQ-1é", 0, 5)).toBe(true);
		expect(hasUnicodeWordGlue("(REQ-1)", 1, 6)).toBe(false);
		expect(hasUnicodeWordGlue("𝐀B1", 2, 4)).toBe(true);
	});
});
