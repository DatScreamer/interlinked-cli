// Tests for the SessionEnd scratchpad archive sweep: content-addressed blob
// copy of the session scratchpad into .interlinked/scratchpad-archive/ with
// bounded work (dir/extension/binary excludes, per-file + total + count caps)
// and manifest-recorded skips (no silent truncation).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	archiveScratchpadDir,
	deriveScratchpadCandidates,
} from "./scratchpad-archive.js";

function makeFixture(): { source: string; destRoot: string } {
	const base = mkdtempSync(join(tmpdir(), "scratch-arch-"));
	const source = join(base, "scratchpad");
	mkdirSync(join(source, "sub"), { recursive: true });
	writeFileSync(join(source, "probe.mts"), "export {};\n");
	writeFileSync(join(source, "sub", "results.json"), '{"ok":true}\n');
	return { source, destRoot: join(base, "archive") };
}

function manifestOf(destRoot: string, sessionId: string): Record<string, unknown> {
	const raw = readFileSync(join(destRoot, `${sessionId}.manifest.json`), "utf8");
	// SAFETY: the manifest is JSON we just wrote — an object at the top level.
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("archiveScratchpadDir", () => {
	it("copies text files into content-addressed blobs and writes a manifest", () => {
		const { source, destRoot } = makeFixture();
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s1" });
		expect(summary).not.toBeNull();
		expect(summary?.fileCount).toBe(2);
		expect(summary?.truncated).toBe(false);
		const manifest = manifestOf(destRoot, "s1");
		// SAFETY: manifest schema under test — `files` is the entry array asserted below.
		const files = manifest.files as Array<{ path: string; sha256: string; size: number }>;
		expect(files.map((f) => f.path).sort()).toEqual(["probe.mts", "sub/results.json"]);
		for (const f of files) {
			const blob = readFileSync(join(destRoot, "blobs", f.sha256), "utf8");
			expect(blob.length).toBe(f.size);
		}
	});

	it("skips excluded dirs, archive extensions, and binary files — with reasons", () => {
		const { source, destRoot } = makeFixture();
		mkdirSync(join(source, "node_modules", "lodash"), { recursive: true });
		writeFileSync(join(source, "node_modules", "lodash", "index.js"), "// dep\n");
		writeFileSync(join(source, "bundle.tgz"), "not-really-a-tarball");
		writeFileSync(join(source, "blob.bin"), Buffer.from([0, 1, 2, 3]));
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s2" });
		expect(summary?.fileCount).toBe(2); // only the two text files
		const reasons = (summary?.skipped ?? []).map((s) => s.reason);
		expect(reasons).toContain("excluded-dir");
		expect(reasons).toContain("excluded-extension");
		expect(reasons).toContain("binary");
	});

	it("deduplicates identical content into a single blob", () => {
		const { source, destRoot } = makeFixture();
		writeFileSync(join(source, "copy-a.txt"), "same-bytes\n");
		writeFileSync(join(source, "copy-b.txt"), "same-bytes\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s3" });
		expect(summary?.fileCount).toBe(4);
		const blobs = readdirSync(join(destRoot, "blobs"));
		expect(blobs.length).toBe(3); // probe.mts + results.json + one shared blob
	});

	it("skips oversized files per max_file_bytes with reason too-large", () => {
		const { source, destRoot } = makeFixture();
		writeFileSync(join(source, "big.log"), "x".repeat(4096));
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "s4",
			config: { max_file_bytes: 1024 },
		});
		expect(summary?.skipped.some((s) => s.path === "big.log" && s.reason === "too-large")).toBe(
			true,
		);
	});

	it("stops at the total budget and marks the archive truncated", () => {
		const { source, destRoot } = makeFixture();
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(source, `chunk-${i}.txt`), "y".repeat(512));
		}
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "s5",
			config: { max_total_bytes: 1024 },
		});
		expect(summary?.truncated).toBe(true);
		expect(summary?.skipped.some((s) => s.reason === "budget-exhausted")).toBe(true);
	});

	it("skips symlinks instead of following them", () => {
		const { source, destRoot } = makeFixture();
		symlinkSync(join(source, "probe.mts"), join(source, "link.mts"));
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s6" });
		expect(summary?.skipped.some((s) => s.path === "link.mts" && s.reason === "symlink")).toBe(
			true,
		);
	});

	it("returns null for a missing source dir", () => {
		const { destRoot } = makeFixture();
		expect(
			archiveScratchpadDir({ sourceDir: "/nonexistent/nowhere", destRoot, sessionId: "s7" }),
		).toBeNull();
	});
});

describe("deriveScratchpadCandidates", () => {
	it("builds the host layout <temp-root>/claude-<uid>/<cwd-slug>/<session>/scratchpad", () => {
		const candidates = deriveScratchpadCandidates({
			cwd: "/Users/x/repo",
			sessionId: "sess-123",
			uid: 501,
		});
		expect(candidates.length).toBeGreaterThan(0);
		for (const c of candidates) {
			expect(c.endsWith(join("claude-501", "-Users-x-repo", "sess-123", "scratchpad"))).toBe(
				true,
			);
		}
	});

	it("returns [] without a uid (non-POSIX host)", () => {
		expect(
			deriveScratchpadCandidates({ cwd: "/Users/x/repo", sessionId: "sess-123", uid: undefined }),
		).toEqual([]);
	});
});
