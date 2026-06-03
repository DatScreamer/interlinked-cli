import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distStaleness, stalenessWarning } from "../build-staleness.js";

describe("distStaleness", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "build-staleness-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeDist(): string {
		const distDir = join(root, "dist");
		mkdirSync(distDir, { recursive: true });
		const artifact = join(distDir, "index.js");
		writeFileSync(artifact, "// built\n");
		return artifact;
	}

	function writeSrc(name = "foo.ts"): string {
		const srcDir = join(root, "src");
		mkdirSync(srcDir, { recursive: true });
		const file = join(srcDir, name);
		writeFileSync(file, "export const x = 1;\n");
		return file;
	}

	it("reports stale when a src/ file is newer than dist/index.js", () => {
		const artifact = writeDist();
		const srcFile = writeSrc();
		// Force dist into the past and src into the future so the ordering is
		// unambiguous regardless of filesystem mtime granularity.
		const old = new Date("2020-01-01T00:00:00Z");
		const recent = new Date("2020-01-01T01:00:00Z");
		utimesSync(artifact, old, old);
		utimesSync(srcFile, recent, recent);

		const result = distStaleness(root);
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBeGreaterThan(result?.buildMs ?? 0);
	});

	it("reports fresh when dist/index.js is newer than src/", () => {
		const srcFile = writeSrc();
		const artifact = writeDist();
		const old = new Date("2020-01-01T00:00:00Z");
		const recent = new Date("2020-01-01T01:00:00Z");
		utimesSync(srcFile, old, old);
		utimesSync(artifact, recent, recent);

		const result = distStaleness(root);
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(false);
	});

	it("returns null when there is no dist/index.js", () => {
		writeSrc();
		expect(distStaleness(root)).toBeNull();
	});
});

describe("stalenessWarning", () => {
	it("returns null for null input", () => {
		expect(stalenessWarning(null)).toBeNull();
	});

	it("returns null for a fresh build", () => {
		expect(stalenessWarning({ stale: false, newestSrcMs: 2, buildMs: 1 })).toBeNull();
	});

	it("returns a STALE BUILD message for a stale build", () => {
		const newestSrcMs = Date.now();
		const buildMs = newestSrcMs - 5 * 60_000;
		const msg = stalenessWarning({ stale: true, newestSrcMs, buildMs });
		expect(msg).not.toBeNull();
		expect(msg).toContain("STALE BUILD");
	});
});
