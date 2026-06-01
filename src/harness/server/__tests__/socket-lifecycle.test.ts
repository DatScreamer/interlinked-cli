import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupSocket, ensureDirectory, removeFileIfExists } from "../socket-lifecycle.js";

describe("socket-lifecycle helpers", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "socket-lifecycle-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("ensureDirectory", () => {
		it("creates the parent directory of a file path", () => {
			const filePath = join(dir, "nested", "deep", "harness.sock");
			ensureDirectory(filePath);
			expect(existsSync(join(dir, "nested", "deep"))).toBe(true);
		});

		it("is idempotent when the directory already exists", () => {
			const filePath = join(dir, "harness.sock");
			ensureDirectory(filePath);
			expect(() => ensureDirectory(filePath)).not.toThrow();
			expect(existsSync(dir)).toBe(true);
		});
	});

	describe("cleanupSocket", () => {
		it("removes an existing socket file", () => {
			const p = join(dir, "stale.sock");
			writeFileSync(p, "");
			expect(existsSync(p)).toBe(true);
			cleanupSocket(p);
			expect(existsSync(p)).toBe(false);
		});

		it("is a no-op for a missing file", () => {
			const p = join(dir, "absent.sock");
			expect(() => cleanupSocket(p)).not.toThrow();
			expect(existsSync(p)).toBe(false);
		});

		it("swallows errors and does not throw", () => {
			// Passing a directory path: unlink on a dir throws internally; swallowed.
			expect(() => cleanupSocket(dir)).not.toThrow();
		});
	});

	describe("removeFileIfExists", () => {
		it("removes an existing file", () => {
			const p = join(dir, "harness.pid");
			writeFileSync(p, "12345");
			removeFileIfExists(p);
			expect(existsSync(p)).toBe(false);
		});

		it("is idempotent for a missing file", () => {
			const p = join(dir, "never-written.pid");
			expect(() => removeFileIfExists(p)).not.toThrow();
		});

		it("can be called twice in a row safely", () => {
			const p = join(dir, "twice.pid");
			writeFileSync(p, "1");
			removeFileIfExists(p);
			expect(() => removeFileIfExists(p)).not.toThrow();
			expect(existsSync(p)).toBe(false);
		});
	});
});
