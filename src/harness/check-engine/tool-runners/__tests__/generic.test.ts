import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDepAudit, runEslint, runGitleaks, runKnip, runOxlint, runSemgrep } from "../generic.js";

describe("generic tool runners", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "generic-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const input = () => ({
		scope: { projectRoot: tmp, mode: "project" as const },
		timeoutMs: 5_000,
	});

	it("runEslint returns [] when there's no eslint config in the tree", () => {
		expect(runEslint(input())).toEqual([]);
	});

	it("runOxlint returns an array (empty when oxlint is not installed)", () => {
		expect(Array.isArray(runOxlint(input()))).toBe(true);
	});

	it("runKnip returns an array", () => {
		expect(Array.isArray(runKnip(input()))).toBe(true);
	});

	it("runSemgrep returns an array", () => {
		expect(Array.isArray(runSemgrep(input()))).toBe(true);
	});

	it("runGitleaks returns an array", () => {
		expect(Array.isArray(runGitleaks(input()))).toBe(true);
	});

	it("runDepAudit returns null when there's no package.json", () => {
		expect(runDepAudit(input())).toBeNull();
	});
});
