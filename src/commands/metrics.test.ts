import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrapFinding } from "../harness/checks/crap.js";
import type { FunctionComplexityEntry } from "../harness/checks/cyclomatic.js";
import type { PerFileCoverage } from "../harness/coverage-final-reader.js";
import type { CoverageSummary } from "../harness/coverage-ratchet.js";

// ===========================================
// metricsCommand — behavioral, module-boundary mocks
// ===========================================
// metrics.ts is a pure orchestrator: it composes file discovery, the AST
// complexity pass, the coverage readers, the CRAP scorer, and the companion-
// path helper, then renders. We mock each of those at the import boundary so
// every branch (output modes, coverage present/absent, files over/under
// thresholds, empty, companion exempt/present/missing, the ?? / && / ||
// fall-throughs) is exercised deterministically with no filesystem reliance.

// --- hoisted mock fns ---------------------------------------------------
const m = vi.hoisted(() => ({
	discoverFiles: vi.fn<(root: string) => string[]>(),
	computeCyclomaticAst:
		vi.fn<(content: string, filePath: string) => FunctionComplexityEntry[] | null>(),
	computeCyclomaticComplexity:
		vi.fn<(content: string, filePath: string) => FunctionComplexityEntry[]>(),
	loadCoverageFinal:
		vi.fn<(p: string, root: string) => Map<string, PerFileCoverage> | null>(),
	coverageForFile:
		vi.fn<(c: Map<string, PerFileCoverage>, rel: string) => PerFileCoverage | undefined>(),
	loadCoverageSummary: vi.fn<(p: string) => CoverageSummary | null>(),
	computeCrapForFile: vi.fn<() => CrapFinding[]>(),
	companionTestCandidates: vi.fn<(srcAbs: string) => string[]>(),
	isTddExemptPath: vi.fn<(p: string) => boolean>(),
	readFileSync: vi.fn<(p: unknown, enc?: unknown) => string>(),
	statSync: vi.fn<(p: unknown) => { mtimeMs: number }>(),
	existsSync: vi.fn<(p: unknown) => boolean>(),
}));

vi.mock("node:fs", () => ({
	readFileSync: (p: unknown, enc?: unknown) => m.readFileSync(p, enc),
	statSync: (p: unknown) => m.statSync(p),
	existsSync: (p: unknown) => m.existsSync(p),
}));
vi.mock("./verify/file-discovery.js", () => ({ discoverFiles: m.discoverFiles }));
vi.mock("../harness/checks/cyclomatic-ast.js", () => ({
	computeCyclomaticAst: m.computeCyclomaticAst,
}));
vi.mock("../harness/checks/cyclomatic.js", () => ({
	computeCyclomaticComplexity: m.computeCyclomaticComplexity,
}));
vi.mock("../harness/coverage-final-reader.js", () => ({
	loadCoverageFinal: m.loadCoverageFinal,
	coverageForFile: m.coverageForFile,
}));
vi.mock("../harness/coverage-ratchet.js", () => ({
	loadCoverageSummary: m.loadCoverageSummary,
}));
vi.mock("../harness/checks/crap.js", () => ({ computeCrapForFile: m.computeCrapForFile }));
vi.mock("../harness/evaluator/tdd-new-file-gate.js", () => ({
	companionTestCandidates: m.companionTestCandidates,
	isTddExemptPath: m.isTddExemptPath,
}));
// formatter is real (color-stripped under CI/NO_COLOR — tests assert plain text).

import { metricsCommand } from "./metrics.js";

// --- helpers ------------------------------------------------------------
let logged = "";
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logged = "";
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logged += `${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
	});
	// Sensible defaults; individual tests override.
	m.discoverFiles.mockReturnValue([]);
	m.computeCyclomaticAst.mockReturnValue([]);
	m.computeCyclomaticComplexity.mockReturnValue([]);
	m.loadCoverageFinal.mockReturnValue(null);
	m.coverageForFile.mockReturnValue(undefined);
	m.loadCoverageSummary.mockReturnValue(null);
	m.computeCrapForFile.mockReturnValue([]);
	m.companionTestCandidates.mockReturnValue([]);
	m.isTddExemptPath.mockReturnValue(false);
	m.readFileSync.mockReturnValue("// content\n");
	m.statSync.mockReturnValue({ mtimeMs: 1000 });
	m.existsSync.mockReturnValue(false);
});
afterEach(() => {
	logSpy.mockRestore();
});

/** Discover returns absolute paths; metrics.ts relativizes against cwd. */
const CWD = "/repo";
function abs(rel: string): string {
	return `${CWD}/${rel}`;
}
function comp(over: Partial<FunctionComplexityEntry> = {}): FunctionComplexityEntry {
	return { name: "fn", line: 1, endLine: 2, cyclomatic: 5, language: "js_ts", ...over };
}
function crap(over: Partial<CrapFinding> = {}): CrapFinding {
	return {
		file: "src/a.ts",
		function: "fn",
		line: 1,
		complexity: 5,
		coverage_pct: 80,
		crap_score: 10,
		stale: false,
		...over,
	};
}
function perFile(rel: string): PerFileCoverage {
	return { filePath: rel, mtime: 1000, functions: [] };
}

interface JsonReport {
	scope: { files: number; functions: number; coverageAvailable: boolean };
	gates: {
		functionsOverCrap: number;
		functionsCyclomaticReview: number;
		functionsCyclomaticBad: number;
		filesMissingCompanion: number;
		filesNoCoverage: number;
	};
	distributions: { cyclomatic: Record<string, number>; crap: Record<string, number> };
	hotspots: Array<{ file: string; name: string; crap: number | null; cyclomatic: number }>;
	missingCompanion: string[];
	files: Array<{
		file: string;
		functions: number;
		linePct: number | null;
		maxCyclomatic: number;
		maxCrap: number | null;
		companion: boolean | null;
		overGate: number;
	}>;
}
function lastJson(): JsonReport {
	return JSON.parse(logged) as JsonReport;
}

describe("metricsCommand — file selection (isAnalyzableSource)", () => {
	it("keeps only analyzable src/*.ts|tsx and drops every excluded shape", async () => {
		m.discoverFiles.mockReturnValue([
			abs("src/keep.ts"),
			abs("src/keep.tsx"),
			abs("lib/outside.ts"), // not under src/
			abs("src/skip.js"), // not .ts/.tsx
			abs("src/types.d.ts"), // declaration
			abs("src/a.test.ts"), // test
			abs("src/a.spec.tsx"), // spec
			abs("src/__tests__/t.ts"), // tests dir
			abs("src/__fixtures__/f.ts"), // fixtures dir
		]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.files.map((f) => f.file)).toEqual(["src/keep.ts", "src/keep.tsx"]);
		expect(r.scope.files).toBe(2);
	});

	it("reports an empty scope when nothing is analyzable", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.test.ts"), abs("docs/x.md")]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope).toEqual({ files: 0, functions: 0, coverageAvailable: false });
		expect(r.hotspots).toEqual([]);
		expect(r.distributions.cyclomatic).toEqual({
			"≤5": 0,
			"5–10": 0,
			"10–15": 0,
			"15–25": 0,
			">25": 0,
		});
	});
});

describe("metricsCommand — no coverage (fail-open)", () => {
	it("uses AST complexity, marks coverage absent, classifies cyclomatic gates", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/b.ts"), abs("src/c.ts")]);
		// a: review band (16..25), b: bad (>25), c: ok (<=15)
		m.computeCyclomaticAst.mockImplementation((_c, p) => {
			if (p.endsWith("a.ts")) return [comp({ name: "review", cyclomatic: 20 })];
			if (p.endsWith("b.ts")) return [comp({ name: "bad", cyclomatic: 30 })];
			return [comp({ name: "ok", cyclomatic: 4 })];
		});
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope.coverageAvailable).toBe(false);
		expect(r.scope.functions).toBe(3);
		expect(r.gates.functionsCyclomaticReview).toBe(1);
		expect(r.gates.functionsCyclomaticBad).toBe(1);
		// No coverage → CRAP unavailable everywhere.
		expect(r.gates.functionsOverCrap).toBe(0);
		expect(r.hotspots).toEqual([]);
		expect(r.files.every((f) => f.linePct === null && f.maxCrap === null)).toBe(true);
		expect(m.computeCrapForFile).not.toHaveBeenCalled();
		// loadCoverageFinal returned null → coverageForFile never consulted.
		expect(m.coverageForFile).not.toHaveBeenCalled();
	});

	it("falls back to the guarded walker when the AST pass returns null", async () => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.computeCyclomaticAst.mockReturnValue(null); // typescript unavailable path
		m.computeCyclomaticComplexity.mockReturnValue([comp({ name: "walked", cyclomatic: 7 })]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(m.computeCyclomaticComplexity).toHaveBeenCalledOnce();
		expect(r.scope.functions).toBe(1);
		expect(r.distributions.cyclomatic["5–10"]).toBe(1);
	});

	it("skips a file whose content cannot be read", async () => {
		m.discoverFiles.mockReturnValue([abs("src/good.ts"), abs("src/bad.ts")]);
		m.readFileSync.mockImplementation((p: unknown) => {
			if (String(p).endsWith("bad.ts")) throw new Error("EACCES");
			return "ok\n";
		});
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.files.map((f) => f.file)).toEqual(["src/good.ts"]);
		expect(r.scope.functions).toBe(1);
	});
});

describe("metricsCommand — companion presence (TDD gate)", () => {
	it("marks exempt files null, present files true, missing files false", async () => {
		m.discoverFiles.mockReturnValue([
			abs("src/exempt.ts"),
			abs("src/has-test.ts"),
			abs("src/no-test.ts"),
		]);
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.isTddExemptPath.mockImplementation((p) => p === "src/exempt.ts");
		m.companionTestCandidates.mockImplementation((a) => [`${a}.candidate`]);
		// existsSync true only for the has-test candidate.
		m.existsSync.mockImplementation((p: unknown) => String(p).includes("has-test"));
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		const byFile = Object.fromEntries(r.files.map((f) => [f.file, f.companion]));
		expect(byFile["src/exempt.ts"]).toBeNull();
		expect(byFile["src/has-test.ts"]).toBe(true);
		expect(byFile["src/no-test.ts"]).toBe(false);
		expect(r.missingCompanion).toEqual(["src/no-test.ts"]);
		expect(r.gates.filesMissingCompanion).toBe(1);
	});
});

describe("metricsCommand — coverage present (CRAP path)", () => {
	function withCoverage(): void {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.loadCoverageSummary.mockReturnValue({
			total: { lines: { pct: 0 }, branches: { pct: 0 } },
			"/repo/src/a.ts": { lines: { pct: 91.5 }, branches: { pct: 80 } },
		});
		m.computeCyclomaticAst.mockReturnValue([comp({ cyclomatic: 12 })]);
	}

	it("computes CRAP, hotspots, gate counts, per-file linePct, and overGate", async () => {
		withCoverage();
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCrapForFile.mockReturnValue([
			crap({ function: "lo", crap_score: 12, coverage_pct: 90 }),
			crap({ function: "hi", crap_score: 45, coverage_pct: 10, complexity: 12 }),
		]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.scope.coverageAvailable).toBe(true);
		expect(r.gates.functionsOverCrap).toBe(1); // only the 45 is >= 30
		expect(r.gates.filesNoCoverage).toBe(0);
		// hotspots sorted desc by crap.
		expect(r.hotspots.map((h) => h.name)).toEqual(["hi", "lo"]);
		const file = r.files[0];
		expect(file.linePct).toBe(91.5);
		expect(file.maxCrap).toBe(45);
		expect(file.maxCyclomatic).toBe(12);
		expect(file.overGate).toBe(1);
		// CRAP distribution buckets the two scores: 12 ≤30, 45 in 30–60.
		expect(r.distributions.crap["10–30"]).toBe(1);
		expect(r.distributions.crap["30–60"]).toBe(1);
	});

	it("counts files with no per-file coverage entry (filesNoCoverage)", async () => {
		withCoverage();
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/uncovered.ts")]);
		m.coverageForFile.mockImplementation((_c, rel) =>
			rel === "src/a.ts" ? perFile("src/a.ts") : undefined,
		);
		m.computeCrapForFile.mockReturnValue([crap()]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.gates.filesNoCoverage).toBe(1);
		// uncovered.ts falls back to the complexity-only mapping (crap null).
		const uncovered = r.files.find((f) => f.file === "src/uncovered.ts");
		expect(uncovered?.maxCrap).toBeNull();
		expect(uncovered?.overGate).toBe(0);
	});

	it("handles CRAP findings carrying a zero score via the ?? fallbacks", async () => {
		withCoverage();
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCrapForFile.mockReturnValue([crap({ crap_score: 0, coverage_pct: 100 })]);
		await metricsCommand({ cwd: CWD, json: true });
		const r = lastJson();
		expect(r.files[0].maxCrap).toBe(0);
		expect(r.gates.functionsOverCrap).toBe(0);
		// crap !== null so it IS a hotspot, with crap 0.
		expect(r.hotspots).toHaveLength(1);
		expect(r.hotspots[0].crap).toBe(0);
	});
});

describe("metricsCommand — linePctFor branches", () => {
	function singleCoveredFile(): void {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.computeCrapForFile.mockReturnValue([crap()]);
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
	}

	it("matches an exact repo-relative summary key (no leading slash)", async () => {
		singleCoveredFile();
		// Exact-key match (key === rel) plus an undefined entry that is skipped.
		m.loadCoverageSummary.mockReturnValue({
			total: undefined, // entry === undefined → skipped
			"src/a.ts": { lines: { pct: 77 }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().files[0].linePct).toBe(77);
	});

	it("returns null linePct when the matched summary pct is not a number", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue({
			// suffix-matches src/a.ts but pct is non-numeric → null branch.
			"/abs/src/a.ts": { lines: { pct: "x" as unknown as number }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().files[0].linePct).toBeNull();
	});

	it("returns null linePct when no summary key matches the file", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue({
			"src/other.ts": { lines: { pct: 50 }, branches: { pct: 0 } },
		});
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().files[0].linePct).toBeNull();
	});

	it("returns null linePct when the summary itself is absent", async () => {
		singleCoveredFile();
		m.loadCoverageSummary.mockReturnValue(null);
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().files[0].linePct).toBeNull();
	});
});

describe("metricsCommand — output modes", () => {
	beforeEach(() => {
		m.discoverFiles.mockReturnValue([abs("src/a.ts"), abs("src/b.ts")]);
		m.computeCyclomaticAst.mockImplementation((_c, p) =>
			p.endsWith("b.ts") ? [comp({ name: "bad", cyclomatic: 30 })] : [comp({ name: "ok" })],
		);
		m.isTddExemptPath.mockReturnValue(false);
		m.companionTestCandidates.mockReturnValue(["/x"]);
		m.existsSync.mockReturnValue(false); // both missing companions
	});

	it("normal mode renders the header, gates, distribution, and missing list (no coverage)", async () => {
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("Test-Quality Metrics");
		expect(logged).toContain("Source files");
		expect(logged).toContain("absent (CRAP/coverage unavailable");
		expect(logged).toContain("Gates");
		expect(logged).toContain("CRAP ≥ 30");
		expect(logged).toContain("cyclomatic > 25");
		expect(logged).toContain("CRAP distribution");
		// no coverage → "files no coverage" line is suppressed.
		expect(logged).not.toContain("files no coverage");
		// no coverage → empty hotspots placeholder line.
		expect(logged).toContain("(no coverage data — CRAP unavailable)");
		expect(logged).toContain("Files missing a companion test (2)");
		expect(logged).toContain("src/a.ts");
		expect(logged).toContain("src/b.ts");
		// gateStr: nonzero counts rendered; ✗ marker on each missing companion.
		expect(logged).toContain("✗");
	});

	it("normal mode shows the coverage line, hotspots, and files-no-coverage when present", async () => {
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockImplementation((_c, rel) =>
			rel === "src/a.ts" ? perFile("src/a.ts") : undefined,
		);
		m.computeCrapForFile.mockReturnValue([
			crap({ function: "hot", crap_score: 50, coverage_pct: 5 }),
		]);
		m.loadCoverageSummary.mockReturnValue({
			"src/a.ts": { lines: { pct: 40 }, branches: { pct: 0 } },
		});
		m.isTddExemptPath.mockReturnValue(true); // suppress missing-companion section
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("present");
		expect(logged).toContain("files no coverage");
		// hotspot row formatting: rounded crap, cyc, cov%.
		expect(logged).toContain("hot");
		expect(logged).toContain("cov=  5%");
		expect(logged).not.toContain("Files missing a companion test");
	});

	it("short mode emits the one-line summary including (no coverage)", async () => {
		await metricsCommand({ cwd: CWD, short: true });
		expect(logged).toContain("2 files");
		expect(logged).toContain("2 fns");
		expect(logged).toContain("CRAP≥30: 0");
		expect(logged).toContain("cyc>25: 1");
		expect(logged).toContain("no-companion: 2");
		expect(logged).toContain("(no coverage)");
		expect(logged).toMatch(/\n$/);
	});

	it("short mode drops the (no coverage) suffix when coverage is present", async () => {
		m.loadCoverageFinal.mockReturnValue(new Map());
		await metricsCommand({ cwd: CWD, short: true });
		expect(logged).toContain("2 files");
		expect(logged).not.toContain("(no coverage)");
	});

	it("full mode falls back to the normal renderer", async () => {
		await metricsCommand({ cwd: CWD, full: true });
		expect(logged).toContain("Test-Quality Metrics");
	});

	it("json mode emits pretty-printed JSON", async () => {
		await metricsCommand({ cwd: CWD, json: true });
		expect(logged).toContain('"scope"');
		expect(logged).toContain("\n  "); // 2-space indentation from JSON.stringify
		expect(() => lastJson()).not.toThrow();
	});
});

describe("metricsCommand — missing-companion truncation", () => {
	it("lists the first 25 and a '… and N more' line past the cap", async () => {
		const files = Array.from({ length: 30 }, (_, i) => abs(`src/f${i}.ts`));
		m.discoverFiles.mockReturnValue(files);
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.isTddExemptPath.mockReturnValue(false);
		m.companionTestCandidates.mockReturnValue(["/x"]);
		m.existsSync.mockReturnValue(false);
		await metricsCommand({ cwd: CWD });
		expect(logged).toContain("Files missing a companion test (30)");
		expect(logged).toContain("… and 5 more");
	});
});

describe("metricsCommand — topN clamping", () => {
	function manyHot(count: number): void {
		m.discoverFiles.mockReturnValue([abs("src/a.ts")]);
		m.loadCoverageFinal.mockReturnValue(new Map([["src/a.ts", perFile("src/a.ts")]]));
		m.coverageForFile.mockReturnValue(perFile("src/a.ts"));
		m.computeCyclomaticAst.mockReturnValue([comp()]);
		m.computeCrapForFile.mockReturnValue(
			Array.from({ length: count }, (_, i) => crap({ function: `f${i}`, crap_score: i + 1 })),
		);
	}

	it("respects an explicit --top value", async () => {
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true, top: "3" });
		expect(lastJson().hotspots).toHaveLength(3);
	});

	it("defaults to 25 when --top is omitted", async () => {
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true });
		expect(lastJson().hotspots).toHaveLength(10); // all 10, under the 25 default
	});

	it("falls back to 25 when --top is non-numeric", async () => {
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true, top: "abc" });
		expect(lastJson().hotspots).toHaveLength(10);
	});

	it("clamps a negative --top up to 1", async () => {
		// parseInt("-5") is truthy → bypasses the `|| 25` default and exercises
		// the Math.max(1, …) lower clamp.
		manyHot(10);
		await metricsCommand({ cwd: CWD, json: true, top: "-5" });
		expect(lastJson().hotspots).toHaveLength(1);
	});

	it("clamps --top above 200 down to 200", async () => {
		manyHot(250);
		await metricsCommand({ cwd: CWD, json: true, top: "999" });
		expect(lastJson().hotspots).toHaveLength(200);
	});
});

describe("metricsCommand — cwd resolution default", () => {
	it("uses process.cwd() when no cwd is supplied", async () => {
		await metricsCommand({ json: true });
		expect(m.discoverFiles).toHaveBeenCalledWith(process.cwd());
		expect(lastJson().scope.files).toBe(0);
	});
});
