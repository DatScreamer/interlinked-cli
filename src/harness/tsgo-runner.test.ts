import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTsgoRunner, parseTsgoOutput } from "./tsgo-runner.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tsgo-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("parseTsgoOutput — form 1", () => {
	it("parses parenthesized location format", () => {
		const raw = `src/foo.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.`;
		const [diag] = parseTsgoOutput(raw, "src/foo.ts");
		expect(diag.file).toBe("src/foo.ts");
		expect(diag.line).toBe(12);
		expect(diag.column).toBe(3);
		expect(diag.severity).toBe("error");
		expect(diag.code).toBe(2322);
		expect(diag.message.startsWith("Type 'string'")).toBe(true);
	});
});

describe("parseTsgoOutput — form 2", () => {
	it("parses colon-colon-dash format", () => {
		const raw = `src/foo.ts:5:9 - warning TS7006: Parameter 'x' implicitly has an 'any' type.`;
		const [diag] = parseTsgoOutput(raw, "src/foo.ts");
		expect(diag.severity).toBe("warning");
		expect(diag.code).toBe(7006);
		expect(diag.line).toBe(5);
	});
});

describe("parseTsgoOutput — mixed and empty", () => {
	it("returns empty for empty output", () => {
		expect(parseTsgoOutput("", "/a")).toEqual([]);
	});

	it("skips lines that don't match the diagnostic shape", () => {
		const raw = [
			"compiling project...",
			"src/a.ts(1,1): error TS1000: one.",
			"",
			"src/a.ts(2,2): error TS1001: two.",
			"Done.",
		].join("\n");
		const diags = parseTsgoOutput(raw, "/a");
		expect(diags.length).toBe(2);
	});
});

describe("createTsgoRunner — unavailable backend", () => {
	const runner = createTsgoRunner({ executable: "/nonexistent/tsgo-does-not-exist-xyz" });
	// available() returns true because we only verify existence via the
	// INTERLINKED_TSGO env var path. Spawn failures are handled gracefully
	// and return empty diagnostics. The important invariants are: never
	// throw, never hang.
	it("reports cache size from stats()", () => {
		expect(runner.stats().cache_size).toBe(0);
	});

	it("returns empty diagnostics when the file doesn't exist", async () => {
		const out = await runner.checkFile("/nonexistent/file.ts");
		expect(out.diagnostics).toEqual([]);
		expect(out.cached).toBe(false);
	});
});

describe("createTsgoRunner — caching", () => {
	it("caches results for the same file+mtime", async () => {
		// We stub the runner with a custom executable that does not exist,
		// so the check returns empty diagnostics quickly. What we care about
		// here is the caching hit/miss semantics.
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const path = join(tmp, "a.ts");
		writeFileSync(path, "export const x: number = 1;\n");

		const first = await runner.checkFile(path);
		const second = await runner.checkFile(path);
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
	});

	it("invalidate() drops the cache for a path", async () => {
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const path = join(tmp, "b.ts");
		writeFileSync(path, "export const y: number = 1;\n");

		await runner.checkFile(path);
		runner.invalidate(path);
		const again = await runner.checkFile(path);
		expect(again.cached).toBe(false);
	});
});

describe("createTsgoRunner — simulateEdit", () => {
	it("returns empty diagnostics when the file doesn't exist", async () => {
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const out = await runner.simulateEdit("/nonexistent.ts", "x", "y");
		expect(out.new_diagnostics).toEqual([]);
	});

	it("returns empty diagnostics when old_string is absent", async () => {
		mkdirSync(tmp, { recursive: true });
		const path = join(tmp, "sim.ts");
		writeFileSync(path, "export const z = 1;\n");
		const runner = createTsgoRunner({ executable: "/bin/true", timeoutMs: 200 });
		const out = await runner.simulateEdit(path, "absent", "present");
		expect(out.new_diagnostics).toEqual([]);
	});
});
