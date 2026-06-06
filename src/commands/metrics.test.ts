import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metricsCommand } from "./metrics.js";

// metricsCommand walks `cwd` for src files. discoverFiles uses `git ls-files`
// when available and falls back to a manual directory walk otherwise — a
// non-git temp dir exercises the fallback, so no fixture git repo is needed.

let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let logged = "";

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "metrics-"));
	mkdirSync(join(tmp, "src"), { recursive: true });
	logged = "";
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logged += `${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
	});
});
afterEach(() => {
	logSpy.mockRestore();
	rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const p = join(tmp, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
}

describe("metricsCommand", () => {
	it("reports scope, companion gaps, and complexity (no coverage present)", async () => {
		// simple.ts has a companion test; complex.ts does not and is branchy.
		write("src/simple.ts", "export function simple(x: number): number {\n\treturn x + 1;\n}\n");
		write("src/simple.test.ts", "import { simple } from './simple.js';\nsimple(1);\n");
		let body = "export function tangle(a: number, b: number): number {\n\tlet r = 0;\n";
		for (let i = 0; i < 20; i++) body += `\tif (a > ${i} && b < ${i}) r += ${i};\n`;
		body += "\treturn r;\n}\n";
		write("src/complex.ts", body);

		await metricsCommand({ cwd: tmp, json: true });
		const report = JSON.parse(logged);

		// Only the two non-test src files are scanned.
		expect(report.scope.files).toBe(2);
		expect(report.scope.coverageAvailable).toBe(false);

		// complex.ts lacks a companion and is over the cyclomatic "bad" line.
		expect(report.missingCompanion).toContain("src/complex.ts");
		expect(report.missingCompanion).not.toContain("src/simple.ts");
		expect(report.gates.functionsCyclomaticBad).toBeGreaterThanOrEqual(1);

		// No coverage → CRAP unavailable → no hotspots / CRAP gate.
		expect(report.hotspots).toEqual([]);
		expect(report.gates.functionsOverCrap).toBe(0);
	});

	it("excludes test, spec, and .d.ts files from the scan", async () => {
		write("src/a.ts", "export const a = 1;\n");
		write("src/a.test.ts", "test stub\n");
		write("src/a.spec.ts", "spec stub\n");
		write("src/a.d.ts", "export declare const a: number;\n");

		await metricsCommand({ cwd: tmp, json: true });
		const report = JSON.parse(logged);
		expect(report.scope.files).toBe(1);
		expect(report.files[0].file).toBe("src/a.ts");
	});

	it("emits a one-line summary in --short mode", async () => {
		write("src/x.ts", "export const x = 1;\n");
		await metricsCommand({ cwd: tmp, short: true });
		expect(logged).toContain("1 files");
		expect(logged).toContain("no-companion");
	});
});
