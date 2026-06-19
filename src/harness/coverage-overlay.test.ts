import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoverageOverlay, sweepStaleOverlays } from "./coverage-overlay.js";

let root: string;

beforeEach(() => {
	// realpathSync so the root matches the symlink-resolved overlayRoot the
	// factory returns (macOS tmpdir is /var → /private/var); the production
	// caller likewise passes a resolved cwd.
	root = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-cov-overlay-")));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "a.test.ts"), "// test\n");
	// node_modules should be linked, not copied.
	mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("createCoverageOverlay", () => {
	it("roots the overlay UNDER projectRoot (not os.tmpdir)", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(relative(root, overlay.overlayRoot).startsWith("..")).toBe(false);
		expect(overlay.overlayRoot.startsWith(root)).toBe(true);
		overlay.cleanup();
	});

	it("writes the proposed content for the edited file into the overlay", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const overlaidFile = join(overlay.overlayRoot, "src", "a.ts");
		expect(readFileSync(overlaidFile, "utf-8")).toBe("export const a = 2;\n");
		overlay.cleanup();
	});

	it("mirrors sibling source + test files so the suite sees the whole project", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(join(overlay.overlayRoot, "src", "a.test.ts"))).toBe(true);
		expect(existsSync(join(overlay.overlayRoot, "package.json"))).toBe(true);
		overlay.cleanup();
	});

	it("links node_modules rather than deep-copying it", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const nm = join(overlay.overlayRoot, "node_modules");
		expect(existsSync(nm)).toBe(true);
		// A symlink keeps the mirror cheap; assert it's a link, not a real dir copy.
		expect(lstatSync(nm).isSymbolicLink()).toBe(true);
		overlay.cleanup();
	});

	it("supports a brand-new file not yet on disk (Write of a new module)", () => {
		const overlay = createCoverageOverlay(root, "src/brand-new.ts", "export const z = 9;\n");
		const overlaidFile = join(overlay.overlayRoot, "src", "brand-new.ts");
		expect(readFileSync(overlaidFile, "utf-8")).toBe("export const z = 9;\n");
		overlay.cleanup();
	});

	it("cleanup removes the overlay tree", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const overlayRoot = overlay.overlayRoot;
		expect(existsSync(overlayRoot)).toBe(true);
		overlay.cleanup();
		expect(existsSync(overlayRoot)).toBe(false);
	});

	it("does not recursively copy a previous overlay dir into the new one", () => {
		const first = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const second = createCoverageOverlay(root, "src/a.ts", "export const a = 3;\n");
		// The second overlay must not contain the first overlay nested inside it.
		const firstName = relative(dirname(first.overlayRoot), first.overlayRoot);
		expect(existsSync(join(second.overlayRoot, ".interlinked", firstName))).toBe(false);
		first.cleanup();
		second.cleanup();
	});

	it("honors a delete marker for the PRIMARY path (delete-only plan): the file ends ABSENT", () => {
		// A delete-only plan passes the deletion as the primary (content "") plus
		// its own delete marker in extraFiles — the write-then-remove must leave
		// the file absent, not resurrected as an empty module (finding 2026-06).
		const overlay = createCoverageOverlay(root, "src/a.ts", "", [
			{ relPath: "src/a.ts", content: "", delete: true },
		]);
		expect(existsSync(join(overlay.overlayRoot, "src", "a.ts"))).toBe(false);
		overlay.cleanup();
	});

	it("still skips a NON-delete duplicate of the primary (the primary content wins)", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 7;\n", [
			{ relPath: "src/a.ts", content: "export const a = 999;\n" },
		]);
		expect(readFileSync(join(overlay.overlayRoot, "src", "a.ts"), "utf-8")).toBe(
			"export const a = 7;\n",
		);
		overlay.cleanup();
	});
});

describe("sweepStaleOverlays — leaked-tree reaping (finding 2026-06-11: 7 leaked trees ≈ 24 GB)", () => {
	const HOUR_MS = 60 * 60 * 1000;

	/** Make a fake overlay dir under .interlinked with a controlled age. */
	function plantOverlay(name: string, ageMs: number): string {
		const parent = join(root, ".interlinked");
		const dir = join(parent, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "marker.txt"), "leaked");
		const t = new Date(Date.now() - ageMs);
		utimesSync(dir, t, t);
		return dir;
	}

	it("removes overlay-prefixed siblings older than the max age", () => {
		const stale = plantOverlay(".cov-overlay-stale1", 2 * HOUR_MS);
		sweepStaleOverlays(join(root, ".interlinked"));
		expect(existsSync(stale)).toBe(false);
	});

	it("keeps overlay-prefixed siblings younger than the max age (could be live)", () => {
		const fresh = plantOverlay(".cov-overlay-fresh", 5 * 60 * 1000);
		sweepStaleOverlays(join(root, ".interlinked"));
		expect(existsSync(fresh)).toBe(true);
	});

	it("never touches non-overlay entries, however old", () => {
		const parent = join(root, ".interlinked");
		mkdirSync(parent, { recursive: true });
		const precious = join(parent, "activity.jsonl");
		writeFileSync(precious, "data\n");
		const old = new Date(Date.now() - 30 * 24 * HOUR_MS);
		utimesSync(precious, old, old);
		sweepStaleOverlays(parent);
		expect(existsSync(precious)).toBe(true);
	});

	it("is a no-op when the parent directory does not exist", () => {
		expect(() => sweepStaleOverlays(join(root, "no-such-dir"))).not.toThrow();
	});

	it("createCoverageOverlay reaps stale siblings as a side effect (self-healing)", () => {
		const stale = plantOverlay(".cov-overlay-deadbeef", 2 * HOUR_MS);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(overlay.overlayRoot)).toBe(true);
		overlay.cleanup();
	});

	it("createCoverageOverlay leaves fresh siblings alone (a parallel gate may own them)", () => {
		const fresh = plantOverlay(".cov-overlay-parallel", 60 * 1000);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(fresh)).toBe(true);
		overlay.cleanup();
		rmSync(fresh, { recursive: true, force: true });
	});
});
