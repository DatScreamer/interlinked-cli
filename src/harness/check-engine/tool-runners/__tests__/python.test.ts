import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMypy, runRuff } from "../python.js";

describe("Python runners", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "py-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const input = () => ({
		scope: { projectRoot: tmp, mode: "project" as const },
		timeoutMs: 5_000,
	});

	it("runMypy is a function + returns an array", () => {
		expect(typeof runMypy).toBe("function");
		expect(Array.isArray(runMypy(input()))).toBe(true);
	});

	it("runRuff is a function + returns an array", () => {
		expect(typeof runRuff).toBe("function");
		expect(Array.isArray(runRuff(input()))).toBe(true);
	});
});
