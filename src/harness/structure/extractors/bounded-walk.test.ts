import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	consumeWalkEntry,
	createWalkBudget,
	MAX_WALK_ENTRIES,
	MAX_WALK_MS,
	type WalkBudget,
	warnWalkTruncated,
} from "./bounded-walk.js";
import { runAllExtractors } from "./index.js";
import { extract as moduleExtract } from "./module-extractor.js";

describe("bounded-walk: constants", () => {
	it("exposes a generous entry cap well above any real project tree", () => {
		// interlinked-cli minus skip-dirs is a few thousand entries; the cap
		// is an order of magnitude above that so normal walks never trip it.
		expect(MAX_WALK_ENTRIES).toBeGreaterThanOrEqual(10_000);
	});

	it("exposes a multi-second wall-time backstop", () => {
		expect(MAX_WALK_MS).toBeGreaterThanOrEqual(1_000);
	});
});

describe("bounded-walk: createWalkBudget", () => {
	it("starts with zero entries and not truncated", () => {
		const budget = createWalkBudget();
		expect(budget.entriesVisited).toBe(0);
		expect(budget.truncated).toBe(false);
	});

	it("sets a deadline in the future", () => {
		const budget = createWalkBudget();
		expect(budget.deadline).toBeGreaterThan(performance.now());
	});

	it("gives each call an independent budget", () => {
		const a = createWalkBudget();
		const b = createWalkBudget();
		consumeWalkEntry(a);
		expect(a.entriesVisited).toBe(1);
		expect(b.entriesVisited).toBe(0);
	});
});

describe("bounded-walk: consumeWalkEntry — uncapped (normal small tree)", () => {
	it("returns true and keeps truncated false while well under the cap", () => {
		const budget = createWalkBudget();
		for (let i = 0; i < 2_000; i++) {
			expect(consumeWalkEntry(budget)).toBe(true);
		}
		expect(budget.truncated).toBe(false);
		expect(budget.entriesVisited).toBe(2_000);
	});

	it("counts exactly one entry per call", () => {
		const budget = createWalkBudget();
		consumeWalkEntry(budget);
		consumeWalkEntry(budget);
		consumeWalkEntry(budget);
		expect(budget.entriesVisited).toBe(3);
	});
});

describe("bounded-walk: consumeWalkEntry — capped on entry budget", () => {
	it("stops returning true once the entry cap is exceeded", () => {
		const budget = createWalkBudget();
		// Walk right up to the cap — every call is still allowed.
		for (let i = 0; i < MAX_WALK_ENTRIES; i++) {
			expect(consumeWalkEntry(budget)).toBe(true);
		}
		// The entry past the cap is rejected and flags truncation.
		expect(consumeWalkEntry(budget)).toBe(false);
		expect(budget.truncated).toBe(true);
	});

	it("keeps returning false (and stays truncated) after the cap trips", () => {
		const budget = createWalkBudget();
		for (let i = 0; i < MAX_WALK_ENTRIES + 5; i++) {
			consumeWalkEntry(budget);
		}
		expect(consumeWalkEntry(budget)).toBe(false);
		expect(consumeWalkEntry(budget)).toBe(false);
		expect(budget.truncated).toBe(true);
	});
});

describe("bounded-walk: consumeWalkEntry — capped on wall-time budget", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops walking once the deadline passes, even with entries to spare", () => {
		const budget = createWalkBudget();
		// Far fewer entries than MAX_WALK_ENTRIES — only the clock should trip.
		for (let i = 0; i < 256; i++) {
			expect(consumeWalkEntry(budget)).toBe(true);
		}
		// Jump past the wall-time deadline.
		vi.advanceTimersByTime(MAX_WALK_MS + 1_000);
		// The time check fires on the periodic boundary (every 512 entries),
		// so walk to the next boundary; once past the deadline it stops.
		let stopped = false;
		for (let i = 0; i < 512; i++) {
			if (consumeWalkEntry(budget) === false) {
				stopped = true;
				break;
			}
		}
		expect(stopped).toBe(true);
		expect(budget.truncated).toBe(true);
		// Entry budget was nowhere near exhausted — time was the cause.
		expect(budget.entriesVisited).toBeLessThan(MAX_WALK_ENTRIES);
	});
});

describe("bounded-walk: warnWalkTruncated", () => {
	// afterEach restores console.error so assertions can safely read
	// spy.mock.calls inside the test body (no try/finally needed).
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits a non-blocking stderr warning", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		warnWalkTruncated("module-extractor", "/home/user");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("names the extractor and root in the warning", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		warnWalkTruncated("module-extractor", "/home/user");
		const msg = String(spy.mock.calls[0]?.[0] ?? "");
		expect(msg).toContain("module-extractor");
		expect(msg).toContain("/home/user");
		expect(msg).toContain("hard cap");
	});

	it("type-checks the WalkBudget shape", () => {
		const budget: WalkBudget = {
			entriesVisited: 0,
			deadline: performance.now(),
			truncated: false,
		};
		expect(budget.truncated).toBe(false);
	});
});

// ===========================================
// Integration — the cap wired through the real extractors
// ===========================================
// The blocks above exercise the budget primitives in isolation. These
// exercise the end-to-end wiring: that the extractors and runAllExtractors
// actually honour the shared WalkBudget — stopping at the hard cap on a
// pathological (oversized) tree and signalling truncation, while leaving
// normal small trees byte-identical and unsignalled.
//
// Regression target: a mis-resolved repoRoot (e.g. $HOME) once made the
// extractor walk run away for 11-25s per PostToolUse Edit (see skip-dirs.ts
// and bounded-walk.ts history). The cap is the skip-list-independent backstop.

// The oversized fixture tree: OVERSIZED_DIR_COUNT × OVERSIZED_FILES_PER_DIR
// .ts files. The product is deliberately larger than MAX_WALK_ENTRIES, so a
// complete walk would have to visit every file; the cap must stop well short.
const OVERSIZED_FILES_PER_DIR = 1_000;
const OVERSIZED_DIR_COUNT = Math.floor(MAX_WALK_ENTRIES / OVERSIZED_FILES_PER_DIR) + 2;
const OVERSIZED_FILE_COUNT = OVERSIZED_DIR_COUNT * OVERSIZED_FILES_PER_DIR;

/** Builds a tree whose entry count comfortably exceeds MAX_WALK_ENTRIES. */
function buildOversizedTree(root: string): void {
	for (let d = 0; d < OVERSIZED_DIR_COUNT; d++) {
		const dir = join(root, `d${d}`);
		mkdirSync(dir);
		for (let f = 0; f < OVERSIZED_FILES_PER_DIR; f++) {
			writeFileSync(join(dir, `f${f}.ts`), "");
		}
	}
}

describe("bounded-walk integration — capped on a pathological tree", () => {
	// The oversized tree is read-only for the walk, so build it once.
	let tmp: string;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "cap-big-"));
		buildOversizedTree(tmp);
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	beforeEach(() => {
		// The truncation warning goes to stderr; silence it but keep the spy.
		errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		errSpy.mockRestore();
	});

	it("runAllExtractors flags truncated=true on a tree larger than the cap", () => {
		const result = runAllExtractors(tmp);
		expect(result.truncated).toBe(true);
	});

	it("runAllExtractors returns a partial graph (fewer module nodes than files)", () => {
		const result = runAllExtractors(tmp);
		const moduleNodes = result.nodes.filter((n) => n.kind === "module");
		// A complete walk would find every module file; the cap stops well
		// short of that — proving the walk was bounded.
		expect(moduleNodes.length).toBeLessThan(OVERSIZED_FILE_COUNT);
		expect(moduleNodes.length).toBeGreaterThan(0);
	});

	it("emits a stderr warning when the walk is truncated (never silent)", () => {
		runAllExtractors(tmp);
		expect(errSpy).toHaveBeenCalled();
		const messages = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? ""));
		expect(messages.some((m: string) => m.includes("hard cap"))).toBe(true);
	});
});

describe("bounded-walk integration — capped via an injected exhausted budget", () => {
	let tmp: string;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cap-inject-"));
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;");
		writeFileSync(join(tmp, "src", "b.ts"), "export const b = 2;");
		errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		errSpy.mockRestore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("stops immediately when handed an entry-exhausted budget", () => {
		// entriesVisited at the cap → the first consumeWalkEntry call rejects.
		const budget = createWalkBudget();
		budget.entriesVisited = MAX_WALK_ENTRIES;
		const result = moduleExtract(tmp, budget);
		expect(budget.truncated).toBe(true);
		// No file was processed before the budget tripped.
		expect(result.nodes).toHaveLength(0);
		expect(errSpy).toHaveBeenCalled();
	});

	it("stops immediately when handed a budget whose deadline has passed", () => {
		const budget = createWalkBudget();
		// 511 + 1 = 512 → the periodic time check fires on the next entry.
		budget.entriesVisited = 511;
		// performance.now() is monotonic from process start (> 0), so a
		// deadline of 0 is unconditionally in the past — no real-clock read.
		budget.deadline = 0;
		const result = moduleExtract(tmp, budget);
		expect(budget.truncated).toBe(true);
		expect(result.nodes).toHaveLength(0);
		expect(errSpy).toHaveBeenCalled();
	});
});

describe("bounded-walk integration — normal trees are unaffected", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cap-small-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("runAllExtractors reports truncated=false on a small tree", () => {
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;");
		writeFileSync(join(tmp, "package.json"), "{}");
		const result = runAllExtractors(tmp);
		expect(result.truncated).toBe(false);
	});

	it("runAllExtractors finds every module in a small tree (no truncation)", () => {
		mkdirSync(join(tmp, "src", "nested"), { recursive: true });
		writeFileSync(join(tmp, "src", "a.ts"), "");
		writeFileSync(join(tmp, "src", "b.ts"), "");
		writeFileSync(join(tmp, "src", "nested", "c.ts"), "");
		const result = runAllExtractors(tmp);
		const moduleLabels = result.nodes
			.filter((n) => n.kind === "module")
			.map((n) => n.label)
			.sort();
		expect(moduleLabels).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
		expect(result.truncated).toBe(false);
	});

	it("extract output is byte-identical with or without an explicit budget", () => {
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src", "a.ts"), "");
		writeFileSync(join(tmp, "src", "b.ts"), "");
		// Default (implicit fresh budget) vs. an explicit fresh budget.
		const implicit = moduleExtract(tmp);
		const explicit = moduleExtract(tmp, createWalkBudget());
		expect(explicit).toEqual(implicit);
	});

	it("a fresh budget never trips on a small tree", () => {
		mkdirSync(join(tmp, "src"));
		writeFileSync(join(tmp, "src", "a.ts"), "");
		const budget = createWalkBudget();
		moduleExtract(tmp, budget);
		expect(budget.truncated).toBe(false);
		expect(budget.entriesVisited).toBeLessThan(MAX_WALK_ENTRIES);
	});
});
