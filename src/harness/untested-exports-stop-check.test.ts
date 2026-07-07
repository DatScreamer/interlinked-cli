// Tests for the 3D Stop nudge (docs/design/stop-event-checks.md): a source
// file written this session whose exported symbols no test file references.
// The detector is pure given its injected graph view + file reader; the
// formatter is a pure string builder. No fs, no timers.

import { describe, expect, it, vi } from "vitest";
import {
	detectUntestedExports,
	type ExportGraphView,
	formatUntestedExportsWarning,
	type UntestedExportHit,
} from "./untested-exports-stop-check.js";

// ─── fixtures ───────────────────────────────────────────────────────────────

interface FakeFileSpec {
	exports: string[];
	dependents?: string[];
}

/** Build an ExportGraphView from a path → {exports, dependents} record. */
function graphOf(files: Record<string, FakeFileSpec>): ExportGraphView {
	return {
		hasFile: (p) => p in files,
		getDependents: (p) => files[p]?.dependents ?? [],
		getExports: (p) =>
			(files[p]?.exports ?? []).map((name) => ({ name, kind: "function", line: 1 })),
	};
}

/** In-memory readFile: returns null (unreadable) for unknown paths. */
function readerOf(contents: Record<string, string>): (p: string) => string | null {
	return (p) => contents[p] ?? null;
}

const SRC = "/repo/src/thing.ts";
const TEST = "/repo/src/thing.test.ts";

function detect(opts: {
	filesWritten: Iterable<string>;
	graph: ExportGraphView;
	contents?: Record<string, string>;
}): UntestedExportHit[] {
	return detectUntestedExports({
		filesWritten: new Set(opts.filesWritten),
		cwd: "/repo",
		getGraph: () => opts.graph,
		readFile: readerOf(opts.contents ?? {}),
	});
}

// ─── detector: positive cases ───────────────────────────────────────────────

describe("detectUntestedExports — fires", () => {
	it("reports every exported symbol when no test file depends on the module", () => {
		const graph = graphOf({
			[SRC]: { exports: ["doThing", "helper"], dependents: ["/repo/src/app.ts"] },
		});
		const hits = detect({ filesWritten: [SRC], graph });
		expect(hits).toEqual([{ sourcePath: SRC, symbols: ["doThing", "helper"] }]);
	});

	it("reports only the symbols the test dependents never reference", () => {
		const graph = graphOf({
			[SRC]: { exports: ["doThing", "helper"], dependents: [TEST] },
		});
		const hits = detect({
			filesWritten: [SRC],
			graph,
			contents: { [TEST]: 'import { doThing } from "./thing.js";\ndoThing();\n' },
		});
		expect(hits).toEqual([{ sourcePath: SRC, symbols: ["helper"] }]);
	});

	it("matches symbols on word boundaries (\"run\" is not covered by \"running\")", () => {
		const graph = graphOf({ [SRC]: { exports: ["run"], dependents: [TEST] } });
		const hits = detect({
			filesWritten: [SRC],
			graph,
			contents: { [TEST]: "const running = true;\n" },
		});
		expect(hits).toEqual([{ sourcePath: SRC, symbols: ["run"] }]);
	});

	it("dedupes the raw and resolved forms of the same written file", () => {
		const graph = graphOf({ [SRC]: { exports: ["doThing"] } });
		const hits = detect({ filesWritten: [SRC, "src/thing.ts"], graph });
		expect(hits).toHaveLength(1);
	});
});

// ─── detector: negative cases (must stay silent) ────────────────────────────

describe("detectUntestedExports — stays silent", () => {
	it("when a test dependent references every exported symbol", () => {
		const graph = graphOf({ [SRC]: { exports: ["doThing"], dependents: [TEST] } });
		const hits = detect({
			filesWritten: [SRC],
			graph,
			contents: { [TEST]: 'import { doThing } from "./thing.js";\n' },
		});
		expect(hits).toEqual([]);
	});

	it("when the written file is not in the graph (stale/unknown → can't tell)", () => {
		const hits = detect({ filesWritten: [SRC], graph: graphOf({}) });
		expect(hits).toEqual([]);
	});

	it("when the module has no named exports (default-only files are skipped)", () => {
		const graph = graphOf({ [SRC]: { exports: ["default"] } });
		expect(detect({ filesWritten: [SRC], graph })).toEqual([]);
	});

	it("for written test files, .d.ts files, and non-code files", () => {
		const graph = graphOf({
			[TEST]: { exports: ["helper"] },
			"/repo/src/__tests__/x.ts": { exports: ["a"] },
			"/repo/src/types.d.ts": { exports: ["T"] },
			"/repo/README.md": { exports: ["x"] },
		});
		const hits = detect({
			filesWritten: [TEST, "/repo/src/__tests__/x.ts", "/repo/src/types.d.ts", "/repo/README.md"],
			graph,
		});
		expect(hits).toEqual([]);
	});

	it("when a test dependent is unreadable (fail-open: can't tell → no finding)", () => {
		const graph = graphOf({ [SRC]: { exports: ["doThing"], dependents: [TEST] } });
		// No contents entry for TEST → readFile returns null.
		expect(detect({ filesWritten: [SRC], graph })).toEqual([]);
	});

	it("never builds the graph when the session wrote no eligible code files", () => {
		const getGraph = vi.fn<() => ExportGraphView>();
		const hits = detectUntestedExports({
			filesWritten: new Set(["/repo/README.md", TEST]),
			cwd: "/repo",
			getGraph,
			readFile: readerOf({}),
		});
		expect(hits).toEqual([]);
		expect(getGraph).not.toHaveBeenCalled();
	});

	it("fails open (returns []) when the graph provider throws", () => {
		const hits = detectUntestedExports({
			filesWritten: new Set([SRC]),
			cwd: "/repo",
			getGraph: () => {
				throw new Error("graph init failed");
			},
			readFile: readerOf({}),
		});
		expect(hits).toEqual([]);
	});
});

// ─── formatter ───────────────────────────────────────────────────────────────

describe("formatUntestedExportsWarning", () => {
	it("returns null when there are no hits", () => {
		expect(formatUntestedExportsWarning([], "/repo")).toBeNull();
	});

	it("lists each file (cwd-relative) with its untested symbols", () => {
		const warning = formatUntestedExportsWarning(
			[{ sourcePath: SRC, symbols: ["doThing", "helper"] }],
			"/repo",
		);
		expect(warning).toContain("[interlinked:verify-before-stop]");
		expect(warning).toContain("src/thing.ts");
		expect(warning).toContain("doThing");
		expect(warning).toContain("helper");
		// Reflective, never a block — the TDD carve-out is stated explicitly.
		expect(warning).toContain("reminder, not a block");
	});

	it("caps the file list and appends an \"...and N more\" suffix", () => {
		const hits: UntestedExportHit[] = [];
		for (let i = 0; i < 7; i++) {
			hits.push({ sourcePath: `/repo/src/f${i}.ts`, symbols: ["x"] });
		}
		const warning = formatUntestedExportsWarning(hits, "/repo");
		expect(warning).toContain("...and 2 more");
	});
});
