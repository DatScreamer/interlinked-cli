// ===========================================
// structure unit tests
// ===========================================

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStructureJsonSection, runStructureVerify } from "./structure.js";

let tempDir: string;
let counter = 0;
let origExitCode: number | string | undefined;

beforeEach(() => {
	tempDir = join(tmpdir(), `structure-test-${process.pid}-${++counter}`);
	mkdirSync(tempDir, { recursive: true });
	origExitCode = process.exitCode;
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	process.exitCode = origExitCode;
});

describe("buildStructureJsonSection", () => {
	it("returns a structure section object for an empty directory", () => {
		const out = buildStructureJsonSection(tempDir, {});
		expect(out).toBeDefined();
		expect(typeof out).toBe("object");
	});
});

describe("runStructureVerify", () => {
	it("writes a structure payload to stdout in JSON mode", async () => {
		const chunks: string[] = [];
		const origOut = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runStructureVerify(tempDir, { json: true });
		} finally {
			process.stdout.write = origOut;
		}
		const combined = chunks.join("");
		expect(combined.length).toBeGreaterThan(0);
		expect(combined).toContain("structure");
	});
});
