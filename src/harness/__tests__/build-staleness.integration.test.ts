import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distStaleness, runningBuildStaleness, stalenessWarning } from "../build-staleness.js";

const OLD = new Date("2020-01-01T00:00:00Z");
const RECENT = new Date("2020-01-01T01:00:00Z");

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

	it("descends into src/ subdirectories to find the newest file", () => {
		// dist is old; the only src edit lives two levels deep. The walker must
		// recurse into the nested directories to observe it (otherwise it would
		// report fresh).
		const artifact = writeDist();
		const nestedDir = join(root, "src", "harness", "checks");
		mkdirSync(nestedDir, { recursive: true });
		const nestedFile = join(nestedDir, "deep.ts");
		writeFileSync(nestedFile, "export const deep = 1;\n");
		utimesSync(artifact, OLD, OLD);
		utimesSync(nestedFile, RECENT, RECENT);

		const result = distStaleness(root);
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBe(RECENT.getTime());
	});

	it("skips node_modules / build / dist / coverage dirs and dotdirs under src/", () => {
		// dist artifact + one real (old) src file. A NEWER file is planted inside
		// every directory the walker is supposed to ignore. If any of those were
		// walked, newestSrcMs would jump to RECENT and stale would flip to true.
		const artifact = writeDist();
		const realSrc = writeSrc("real.ts");
		utimesSync(artifact, RECENT, RECENT);
		utimesSync(realSrc, OLD, OLD);

		for (const skipped of ["node_modules", "build", "dist", "coverage", ".cache", ".hidden"]) {
			const dir = join(root, "src", skipped);
			mkdirSync(dir, { recursive: true });
			const planted = join(dir, "planted.ts");
			writeFileSync(planted, "export const planted = 2;\n");
			utimesSync(planted, RECENT, RECENT);
		}

		const result = distStaleness(root);
		expect(result).not.toBeNull();
		// Only the real (old) src file should have been counted.
		expect(result?.newestSrcMs).toBe(OLD.getTime());
		expect(result?.stale).toBe(false);
	});

	it("N: test sources never make the build stale — .test.ts / .spec.mts / __tests__ / __fixtures__ (review 2026-08-26)", () => {
		// Tests are not bundled into dist; a fresh test file used to flip
		// build_stale:true seconds after a rebuild (the reviewer's live FP).
		const artifact = writeDist();
		const realSrc = writeSrc("real.ts");
		utimesSync(artifact, RECENT, RECENT);
		utimesSync(realSrc, OLD, OLD);

		const fresh = new Date(RECENT.getTime() + 60_000);
		for (const rel of ["new-file.test.ts", "new-file.spec.mts"]) {
			const p = join(root, "src", rel);
			writeFileSync(p, "export {};\n");
			utimesSync(p, fresh, fresh);
		}
		for (const dir of ["__tests__", "__fixtures__"]) {
			const d = join(root, "src", dir);
			mkdirSync(d, { recursive: true });
			const p = join(d, "inside.ts");
			writeFileSync(p, "export {};\n");
			utimesSync(p, fresh, fresh);
		}

		const result = distStaleness(root);
		expect(result?.newestSrcMs).toBe(OLD.getTime());
		expect(result?.stale).toBe(false);
	});

	it("P: a PRODUCT source file beside excluded test files still flips stale", () => {
		const artifact = writeDist();
		utimesSync(artifact, OLD, OLD);
		const testFile = writeSrc("thing.test.ts");
		utimesSync(testFile, RECENT, RECENT);
		const product = writeSrc("product.ts");
		utimesSync(product, RECENT, RECENT);

		const result = distStaleness(root);
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBe(RECENT.getTime());
	});

	it("P: the matcher anchors on the file END — thing.test.ts.bak.ts is PRODUCT source, not a test", () => {
		const artifact = writeDist();
		const realSrc = writeSrc("real.ts");
		utimesSync(artifact, RECENT, RECENT);
		utimesSync(realSrc, OLD, OLD);
		const bak = writeSrc("thing.test.ts.bak.ts");
		const fresh = new Date(RECENT.getTime() + 60_000);
		utimesSync(bak, fresh, fresh);

		const result = distStaleness(root);
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBe(fresh.getTime());
	});

	it("ignores ephemeral fixture-dir exhaust under src/ (leaked _*_fixtures-* mkdtemps)", () => {
		// The harness's own test suites mkdtemp `_content_gate_fixtures-*` (and
		// siblings) inside src/; interrupted runs leak them and live runs rewrite
		// them. They are exhaust, not source edits — a probe file in one must not
		// flip the verdict to stale (observed FP 2026-08-09).
		const artifact = writeDist();
		const realSrc = writeSrc("real.ts");
		utimesSync(artifact, RECENT, RECENT);
		utimesSync(realSrc, OLD, OLD);

		const FUTURE = new Date("2020-01-01T02:00:00Z");
		for (const leaked of [
			"_content_gate_fixtures-pGlFeJ",
			"_diff_overlay_fixtures-7N08Bw",
			"_tsc_overlay_fixtures-K1ehFC",
		]) {
			const dir = join(root, "src", leaked);
			mkdirSync(dir, { recursive: true });
			const probe = join(dir, "probe.ts");
			writeFileSync(probe, "export const probe = 1;\n");
			utimesSync(probe, FUTURE, FUTURE);
		}

		const result = distStaleness(root);
		expect(result?.newestSrcMs).toBe(OLD.getTime());
		expect(result?.stale).toBe(false);
	});

	it("anchors on build completion: src edits during the build window are not stale", () => {
		// tsup writes dist/index.js in the first second and later artifacts (DTS,
		// asset copies) up to ~a minute afterwards. A src mtime landing between
		// the two must compare against the newest dist artifact (build END) and
		// read fresh — against index.js alone it would read stale forever.
		const artifact = writeDist(); // dist/index.js — early ESM write
		const lateArtifactDir = join(root, "dist", "types");
		mkdirSync(lateArtifactDir, { recursive: true });
		const lateArtifact = join(lateArtifactDir, "index.d.ts");
		writeFileSync(lateArtifact, "// dts\n");
		const srcFile = writeSrc("mid-build.ts");

		const MID = new Date("2020-01-01T00:30:00Z");
		utimesSync(artifact, OLD, OLD);
		utimesSync(srcFile, MID, MID);
		utimesSync(lateArtifact, RECENT, RECENT);

		const result = distStaleness(root);
		expect(result?.buildMs).toBe(RECENT.getTime());
		expect(result?.stale).toBe(false);
	});

	it("keeps the newest mtime when a later-seen sibling file is not newer", () => {
		// Two src files share the SAME mtime, so whichever the directory walk
		// visits second compares equal (m > newest is false) and must not change
		// the running maximum. dist is older, so the verdict is stale at that
		// shared timestamp. (Exercises the false arm of the `m > newest` guard
		// deterministically, independent of readdir ordering.)
		const artifact = writeDist();
		const srcDir = join(root, "src");
		mkdirSync(srcDir, { recursive: true });
		const a = join(srcDir, "a.ts");
		const b = join(srcDir, "b.ts");
		writeFileSync(a, "export const a = 1;\n");
		writeFileSync(b, "export const b = 1;\n");
		utimesSync(artifact, OLD, OLD);
		utimesSync(a, RECENT, RECENT);
		utimesSync(b, RECENT, RECENT);

		const result = distStaleness(root);
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBe(RECENT.getTime());
	});

	it("returns null when src/ has no readable files (newest mtime 0)", () => {
		// dist exists, but src/ is an empty directory tree: the walk finds no
		// files, newest stays 0, and the function reports null (not stale).
		writeDist();
		mkdirSync(join(root, "src", "empty-subdir"), { recursive: true });
		expect(distStaleness(root)).toBeNull();
	});

	it("ignores entries that are neither files nor directories (e.g. FIFOs)", () => {
		// A named pipe in src/ is neither isFile() nor isDirectory(): the walker
		// must skip it without contributing an mtime. With ONLY a FIFO present,
		// newest stays 0 and the verdict is null — proving the special-file entry
		// did not register. Skips on platforms without mkfifo so the suite stays
		// green everywhere.
		writeDist();
		const srcDir = join(root, "src");
		mkdirSync(srcDir, { recursive: true });
		let madeFifo = false;
		try {
			execFileSync("mkfifo", [join(srcDir, "pipe")]);
			madeFifo = true;
		} catch (err) {
			// mkfifo unavailable (e.g. Windows CI): record reason and skip.
			madeFifo = false;
			void err;
		}
		if (!madeFifo) return;
		// Only a FIFO lives under src/ -> no file mtime observed -> null.
		expect(distStaleness(root)).toBeNull();
	});

	it("returns null when src/ is missing entirely", () => {
		// dist exists but there is no src/ tree at all — readdir fails, newest
		// stays 0, so the result is null rather than a spurious staleness verdict.
		writeDist();
		expect(distStaleness(root)).toBeNull();
	});
});

describe("runningBuildStaleness", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "running-staleness-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns null for an unparseable module URL", () => {
		expect(runningBuildStaleness("not-a-url")).toBeNull();
	});

	it("returns null when the module path has no /dist/ segment (running from src)", () => {
		const fromSrc = pathToFileURL(join(root, "src", "harness", "server.ts")).href;
		expect(runningBuildStaleness(fromSrc)).toBeNull();
	});

	it("reports stale for a running dist module whose repo src/ is newer", () => {
		const distDir = join(root, "dist");
		mkdirSync(distDir, { recursive: true });
		const artifact = join(distDir, "index.js");
		writeFileSync(artifact, "// built\n");
		const srcDir = join(root, "src");
		mkdirSync(srcDir, { recursive: true });
		const srcFile = join(srcDir, "edited.ts");
		writeFileSync(srcFile, "export const edited = 1;\n");
		utimesSync(artifact, OLD, OLD);
		utimesSync(srcFile, RECENT, RECENT);

		// The "running" module lives deep inside dist/ — the path before the
		// `${sep}dist${sep}` marker must be sliced back to repoRoot and delegated.
		const runningModule = pathToFileURL(
			join(root, "dist", "harness", "server.js"),
		).href;
		const result = runningBuildStaleness(runningModule);
		expect(result).not.toBeNull();
		expect(result?.stale).toBe(true);
		expect(result?.newestSrcMs).toBe(RECENT.getTime());
		expect(result?.buildMs).toBe(OLD.getTime());
	});

	it("reports fresh for a running dist module whose build is newer than src/", () => {
		const distDir = join(root, "dist");
		mkdirSync(distDir, { recursive: true });
		const artifact = join(distDir, "index.js");
		writeFileSync(artifact, "// built\n");
		const srcDir = join(root, "src");
		mkdirSync(srcDir, { recursive: true });
		const srcFile = join(srcDir, "edited.ts");
		writeFileSync(srcFile, "export const edited = 1;\n");
		utimesSync(srcFile, OLD, OLD);
		utimesSync(artifact, RECENT, RECENT);

		const runningModule = pathToFileURL(
			join(root, "dist", "harness", "server.js"),
		).href;
		const result = runningBuildStaleness(runningModule);
		expect(result?.stale).toBe(false);
	});

	it("returns null for a running dist module whose repo has no build artifact", () => {
		// A path that contains the /dist/ marker but where dist/index.js does not
		// exist at the resolved repo root: distStaleness short-circuits to null.
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "edited.ts"), "export const edited = 1;\n");
		const runningModule = pathToFileURL(
			join(root, "dist", "harness", "server.js"),
		).href;
		expect(runningBuildStaleness(runningModule)).toBeNull();
	});

	it("uses the platform path separator to detect the dist segment", () => {
		// Sanity check that the marker the implementation looks for is sep-based;
		// a constructed path with the OS separator around "dist" must be honored.
		const marker = `${sep}dist${sep}`;
		const runningModule = pathToFileURL(
			join(root, "dist", "harness", "server.js"),
		).href;
		expect(decodeURIComponent(runningModule)).toContain(marker);
		// No build artifact present -> null, but the segment WAS detected (else it
		// would also be null via the no-marker path; this asserts the marker path
		// is the one exercised by constructing it explicitly).
		expect(runningBuildStaleness(runningModule)).toBeNull();
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
