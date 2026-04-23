import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTsc } from "../tsc.js";

describe("runTsc", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tsc-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is a function with the ToolRunner signature", () => {
		expect(typeof runTsc).toBe("function");
	});

	it("returns [] when there's no tsconfig.json in the project tree", () => {
		const results = runTsc({
			scope: { projectRoot: tmp, mode: "project" },
			timeoutMs: 5_000,
		});
		expect(results).toEqual([]);
	});
});
