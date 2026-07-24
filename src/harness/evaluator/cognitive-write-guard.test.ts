// Delta-semantics tests for the cognitive write warning: fires only when an
// edit GROWS a function past the cap (or lands a new one over it). Holding or
// shrinking an over-cap function is the refactor-down path and stays silent.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMetricCapsCache } from "../metric-caps.js";
import { cognitiveWriteWarning } from "./cognitive-write-guard.js";

// depth-N nested ifs → cognitive 1+2+…+N (spec §5 oracle shape).
function nested(name: string, depth: number): string {
	let body = "return 1;";
	for (let i = depth; i >= 1; i--) body = `if (a${i}) { ${body} }`;
	const params = Array.from({ length: depth }, (_, i) => `a${i + 1}: boolean`).join(", ");
	return `export function ${name}(${params}): number { ${body} return 0; }\n`;
}

const COG = (depth: number): number => (depth * (depth + 1)) / 2;

describe("cognitiveWriteWarning", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cog-guard-"));
		resetMetricCapsCache();
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		resetMetricCapsCache();
	});

	function withCap(cap: number): void {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "metric-caps.json"),
			JSON.stringify({ version: 1, max_cognitive: cap }),
		);
		resetMetricCapsCache();
	}

	it("warns when an edit grows a function past the cap, naming the delta", () => {
		withCap(10);
		const abs = join(tmp, "a.ts");
		writeFileSync(abs, nested("f", 3)); // 6, under cap
		const warning = cognitiveWriteWarning(abs, nested("f", 5), tmp); // 15 > 10
		expect(warning).toContain("f");
		expect(warning).toContain(`${COG(3)}→${COG(5)}`);
		expect(warning).toContain("cap 10");
	});

	it("warns on a brand-new function landing over the cap", () => {
		withCap(10);
		const abs = join(tmp, "fresh.ts"); // nothing on disk
		const warning = cognitiveWriteWarning(abs, nested("born", 5), tmp);
		expect(warning).toContain("born");
		expect(warning).toContain("new");
	});

	it("stays silent when an over-cap function merely holds its score", () => {
		withCap(10);
		const abs = join(tmp, "b.ts");
		writeFileSync(abs, nested("g", 5)); // 15, already over
		expect(cognitiveWriteWarning(abs, nested("g", 5), tmp)).toBeNull();
	});

	it("stays silent when an over-cap function shrinks (the refactor-down path)", () => {
		withCap(10);
		const abs = join(tmp, "c.ts");
		writeFileSync(abs, nested("h", 6)); // 21
		expect(cognitiveWriteWarning(abs, nested("h", 5), tmp)).toBeNull(); // 15, still over, but shrinking
	});

	it("stays silent for growth that stays under the cap", () => {
		withCap(10);
		const abs = join(tmp, "d.ts");
		writeFileSync(abs, nested("k", 2)); // 3
		expect(cognitiveWriteWarning(abs, nested("k", 3), tmp)).toBeNull(); // 6 ≤ 10
	});

	it("uses the shipped default cap when no override exists", () => {
		const abs = join(tmp, "e.ts");
		writeFileSync(abs, nested("m", 7)); // 28, under default 30
		const warning = cognitiveWriteWarning(abs, nested("m", 8), tmp); // 36 > 30
		expect(warning).toContain("cap 30");
	});

	it("returns null for non-JS/TS files", () => {
		const abs = join(tmp, "x.py");
		expect(cognitiveWriteWarning(abs, "def f():\n    return 1\n", tmp)).toBeNull();
	});
});
