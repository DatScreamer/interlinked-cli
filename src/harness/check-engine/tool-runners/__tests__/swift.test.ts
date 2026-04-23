import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSwiftBuild, runSwiftLint } from "../swift.js";

describe("Swift runners", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "swift-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const input = () => ({
		scope: { projectRoot: tmp, mode: "project" as const },
		timeoutMs: 5_000,
	});

	it("runSwiftLint is a function + returns [] without .swift sources / config", () => {
		expect(typeof runSwiftLint).toBe("function");
		expect(runSwiftLint(input())).toEqual([]);
	});

	it("runSwiftBuild is a function + returns [] without Package.swift", () => {
		expect(typeof runSwiftBuild).toBe("function");
		expect(runSwiftBuild(input())).toEqual([]);
	});
});
