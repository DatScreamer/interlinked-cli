import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStatusWriters, writeStatusFile } from "../status-writers.js";

describe("status-writers", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "status-writers-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("writeStatusFile", () => {
		it("writes content verbatim", () => {
			const p = join(dir, "x.status");
			writeStatusFile(p, "ready:42");
			expect(readFileSync(p, "utf-8")).toBe("ready:42");
		});

		it("swallows errors (path is a directory)", () => {
			expect(() => writeStatusFile(dir, "nope")).not.toThrow();
		});
	});

	describe("createStatusWriters", () => {
		it("resolves the three marker paths under the interlinked dir", () => {
			const w = createStatusWriters(dir);
			expect(w.classifierStatusPath).toBe(join(dir, "classifier.status"));
			expect(w.scannerStatusPath).toBe(join(dir, "content-scanner.status"));
			expect(w.scannerReviewPendingPath).toBe(join(dir, "scanner", "review-pending"));
		});

		it("writeClassifierStatus persists the exact line", () => {
			const w = createStatusWriters(dir);
			w.writeClassifierStatus("groq:llama:ready");
			expect(readFileSync(w.classifierStatusPath, "utf-8")).toBe("groq:llama:ready");
		});

		it("writeScannerStatus persists the exact line", () => {
			const w = createStatusWriters(dir);
			w.writeScannerStatus("dormant");
			expect(readFileSync(w.scannerStatusPath, "utf-8")).toBe("dormant");
		});

		it("writeReviewPendingMarker fails soft when the scanner/ dir is absent", () => {
			const w = createStatusWriters(dir);
			// writeStatusFile does not create parent dirs — a missing scanner/
			// dir means the marker write is swallowed, never thrown.
			expect(() => w.writeReviewPendingMarker(3)).not.toThrow();
			expect(existsSync(w.scannerReviewPendingPath)).toBe(false);
		});

		it("writeReviewPendingMarker writes the count with a trailing newline once its dir exists", () => {
			const w = createStatusWriters(dir);
			mkdirSync(join(dir, "scanner"), { recursive: true });
			w.writeReviewPendingMarker(7);
			expect(existsSync(w.scannerReviewPendingPath)).toBe(true);
			expect(readFileSync(w.scannerReviewPendingPath, "utf-8")).toBe("7\n");
		});
	});
});
