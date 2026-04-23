import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCargoCheck, runCargoClippy } from "../rust.js";

describe("Rust runners", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "rs-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const input = () => ({
		scope: { projectRoot: tmp, mode: "project" as const },
		timeoutMs: 5_000,
	});

	it("runCargoCheck is a function + returns [] without Cargo.toml", () => {
		expect(typeof runCargoCheck).toBe("function");
		expect(runCargoCheck(input())).toEqual([]);
	});

	it("runCargoClippy is a function + returns [] without Cargo.toml", () => {
		expect(typeof runCargoClippy).toBe("function");
		expect(runCargoClippy(input())).toEqual([]);
	});
});
