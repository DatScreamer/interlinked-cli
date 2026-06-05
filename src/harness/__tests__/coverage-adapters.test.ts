import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CANONICAL_LCOV_PATH,
	COVERAGE_ADAPTERS,
	coverageAdapterById,
	coverageSetupGuidance,
	detectCoverageAdapter,
	detectCoverageAdapters,
} from "../coverage-adapters.js";
import { canonicalToCoverageSummary, parseLcov } from "../coverage-lcov.js";
import { type CoverageBaseline, compareCoverage } from "../coverage-ratchet.js";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cov-adapters-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Drop a marker file into the temp project root. */
function touch(name: string, body = ""): void {
	writeFileSync(join(tmp, name), body);
}

function ids(cwd: string): string[] {
	return detectCoverageAdapters(cwd).map((a) => a.id);
}

describe("detectCoverageAdapters — positive (≥3 per language)", () => {
	it("detects Python from pyproject.toml", () => {
		touch("pyproject.toml", "[project]\nname='x'\n");
		expect(ids(tmp)).toContain("python");
	});

	it("detects Python from setup.py", () => {
		touch("setup.py", "from setuptools import setup\n");
		expect(ids(tmp)).toContain("python");
	});

	it("detects Python from requirements.txt", () => {
		touch("requirements.txt", "pytest\n");
		expect(ids(tmp)).toContain("python");
	});

	it("detects Python from a coverage-specific marker (.coveragerc)", () => {
		touch(".coveragerc", "[run]\nbranch = True\n");
		expect(ids(tmp)).toContain("python");
	});

	it("detects JavaScript/TypeScript from package.json", () => {
		touch("package.json", "{}");
		expect(ids(tmp)).toContain("javascript");
	});

	it("detects JavaScript/TypeScript from tsconfig.json", () => {
		touch("tsconfig.json", "{}");
		expect(ids(tmp)).toContain("javascript");
	});

	it("detects Rust from Cargo.toml", () => {
		touch("Cargo.toml", "[package]\nname='x'\n");
		expect(ids(tmp)).toContain("rust");
	});
});

describe("detectCoverageAdapters — negative (no false positives across languages)", () => {
	it("returns nothing for an empty directory", () => {
		expect(detectCoverageAdapters(tmp)).toEqual([]);
	});

	it("returns nothing for a directory with only unrelated files", () => {
		touch("README.md", "# hi\n");
		touch("LICENSE", "MIT\n");
		expect(detectCoverageAdapters(tmp)).toEqual([]);
	});

	it("does NOT detect JavaScript in a Python-only project", () => {
		touch("pyproject.toml", "[project]\nname='x'\n");
		expect(ids(tmp)).toEqual(["python"]);
	});

	it("does NOT detect Python in a JS-only project", () => {
		touch("package.json", "{}");
		expect(ids(tmp)).toEqual(["javascript"]);
	});

	it("detects ONLY Rust in a Rust-only project", () => {
		touch("Cargo.toml", "[package]\nname='x'\n");
		expect(ids(tmp)).toEqual(["rust"]);
	});
});

describe("detectCoverageAdapter — single best guess + polyglot", () => {
	it("returns null when nothing is detected", () => {
		expect(detectCoverageAdapter(tmp)).toBeNull();
	});

	it("returns both adapters for a polyglot root, JS first by registry order", () => {
		touch("package.json", "{}");
		touch("pyproject.toml", "[project]\nname='x'\n");
		expect(ids(tmp)).toEqual(["javascript", "python"]);
		expect(detectCoverageAdapter(tmp)?.id).toBe("javascript");
	});

	it("returns all three for a JS+Python+Rust root, in registry order", () => {
		touch("package.json", "{}");
		touch("pyproject.toml", "[project]\nname='x'\n");
		touch("Cargo.toml", "[package]\nname='x'\n");
		expect(ids(tmp)).toEqual(["javascript", "python", "rust"]);
	});
});

describe("adapter command shapes (wrap the native engine, emit canonical LCOV)", () => {
	it("every adapter writes to the one canonical LCOV path", () => {
		for (const adapter of COVERAGE_ADAPTERS) {
			expect(adapter.reportRelPath).toBe(CANONICAL_LCOV_PATH);
			// The producing command must actually target that path.
			expect(adapter.lcovCommand).toContain("coverage");
		}
	});

	it("Python wraps coverage.py via `coverage lcov` and offers a native per-test map", () => {
		const py = coverageAdapterById("python");
		if (!py) throw new Error("python adapter missing");
		expect(py.engine).toBe("coverage.py");
		expect(py.lcovCommand).toContain("coverage lcov");
		expect(py.lcovCommand).toContain(CANONICAL_LCOV_PATH);
		// The per-test keystone: coverage.py's native per-test contexts.
		expect(py.perTestLcovCommand).toContain("--cov-context=test");
	});

	it("JavaScript wraps vitest/v8 and emits an lcov reporter", () => {
		const js = coverageAdapterById("javascript");
		if (!js) throw new Error("javascript adapter missing");
		expect(js.lcovCommand).toContain("vitest");
		expect(js.lcovCommand).toContain("lcov");
		// No single-flag per-test map for V8 → file-level fallback (plan P2).
		expect(js.perTestLcovCommand).toBeNull();
	});

	it("Rust wraps cargo-llvm-cov and exports LCOV to the canonical path", () => {
		const rust = coverageAdapterById("rust");
		if (!rust) throw new Error("rust adapter missing");
		expect(rust.lcovCommand).toContain("cargo llvm-cov");
		expect(rust.lcovCommand).toContain("--lcov");
		expect(rust.lcovCommand).toContain(CANONICAL_LCOV_PATH);
		// LLVM source-based coverage has no single-flag per-test context.
		expect(rust.perTestLcovCommand).toBeNull();
	});

	it("coverageAdapterById returns null for an unknown id", () => {
		expect(coverageAdapterById("haskell")).toBeNull();
	});
});

describe("coverageSetupGuidance", () => {
	it("tailors guidance to the detected language only", () => {
		touch("pyproject.toml", "[project]\nname='x'\n");
		const guidance = coverageSetupGuidance(tmp);
		expect(guidance).toContain("coverage lcov");
		expect(guidance).toContain("--cov-context=test");
		// JS guidance must not leak into a Python-only project.
		expect(guidance).not.toContain("vitest");
	});

	it("lists every adapter when nothing is detected", () => {
		const guidance = coverageSetupGuidance(tmp);
		expect(guidance).toContain("vitest");
		expect(guidance).toContain("coverage lcov");
		expect(guidance).toContain("cargo llvm-cov");
	});

	it("tailors guidance to Rust in a Cargo project", () => {
		touch("Cargo.toml", "[package]\nname='x'\n");
		const guidance = coverageSetupGuidance(tmp);
		expect(guidance).toContain("cargo llvm-cov");
		expect(guidance).not.toContain("vitest");
		expect(guidance).not.toContain("coverage lcov");
	});
});

// ===========================================
// The C4 proof: a SECOND language through the ONE parser.
// ===========================================
// coverage-lcov.test.ts already drives `.ts` SF paths through
// parseLcov → canonical → ratchet. This drives a coverage.py-shaped report
// (`.py` SF paths, coverage.py's FN/FNDA/BRDA/DA records) through the *same*
// functions, unchanged. Two languages, one parser — the language-agnostic
// architecture, demonstrated end to end.
describe("Python coverage flows the same LCOV → canonical → ratchet spine", () => {
	// Realistic `coverage lcov` output (coverage.py ≥ 6.3, branch=True):
	//   app/calc.py — add() covered, divide() not → 2/4 lines, 1/2 fns, 0/2 branches
	//   app/util.py — fully covered → 2/2 lines, 1/1 fns
	const PY_LCOV = [
		"TN:",
		"SF:app/calc.py",
		"FN:1,add",
		"FN:6,divide",
		"FNDA:5,add",
		"FNDA:0,divide",
		"FNF:2",
		"FNH:1",
		"DA:1,5",
		"DA:2,5",
		"DA:6,0",
		"DA:7,0",
		"LF:4",
		"LH:2",
		"BRDA:6,0,0,-",
		"BRDA:6,0,1,-",
		"BRF:2",
		"BRH:0",
		"end_of_record",
		"SF:app/util.py",
		"FN:1,helper",
		"FNDA:3,helper",
		"DA:1,3",
		"DA:2,3",
		"LF:2",
		"LH:2",
		"end_of_record",
		"",
	].join("\n");

	it("parses coverage.py LCOV into canonical per-file metrics", () => {
		const cov = parseLcov(PY_LCOV);
		expect([...cov.files.keys()].sort()).toEqual(["app/calc.py", "app/util.py"]);

		const calc = cov.files.get("app/calc.py");
		if (!calc) throw new Error("missing app/calc.py");
		expect(calc.lines).toEqual({ covered: 2, total: 4, pct: 50 });
		expect(calc.functions).toEqual({ covered: 1, total: 2, pct: 50 });
		expect(calc.branches).toEqual({ covered: 0, total: 2, pct: 0 });

		const util = cov.files.get("app/util.py");
		expect(util?.lines.pct).toBe(100);
	});

	it("flags a per-file regression on a .py file via the unchanged ratchet", () => {
		const summary = canonicalToCoverageSummary(parseLcov(PY_LCOV));
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files: {
				"app/calc.py": { lines_pct: 100, branches_pct: 100 },
				"app/util.py": { lines_pct: 100, branches_pct: 100 },
			},
		};

		const result = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 0 },
			repoRoot: process.cwd(),
		});

		const lineFinding = result.findings.find(
			(f) => f.file === "app/calc.py" && f.metric === "lines",
		);
		expect(lineFinding).toBeDefined();
		expect(lineFinding?.baseline_pct).toBe(100);
		expect(lineFinding?.current_pct).toBe(50);
		// app/util.py held at 100% → no finding for it.
		expect(result.findings.some((f) => f.file === "app/util.py")).toBe(false);
	});
});

// A THIRD language through the one parser — cargo-llvm-cov LCOV (`.rs` SF
// paths). With the `.ts` (C0) and `.py` (Python) cases above, this is three
// distinct engines (v8, coverage.py, LLVM source-based) flowing through the
// identical parseLcov → canonical → compareCoverage spine, untouched.
describe("Rust coverage flows the same LCOV → canonical → ratchet spine", () => {
	// Realistic `cargo llvm-cov --lcov` output:
	//   src/lib.rs — add() covered, divide() not → 2/4 lines, 1/2 fns, 0/2 branches
	//   src/util.rs — fully covered → 1/1 lines
	const RUST_LCOV = [
		"SF:src/lib.rs",
		"FN:1,add",
		"FN:5,divide",
		"FNDA:4,add",
		"FNDA:0,divide",
		"FNF:2",
		"FNH:1",
		"BRDA:5,0,0,-",
		"BRDA:5,0,1,-",
		"BRF:2",
		"BRH:0",
		"DA:1,4",
		"DA:2,4",
		"DA:5,0",
		"DA:6,0",
		"LF:4",
		"LH:2",
		"end_of_record",
		"SF:src/util.rs",
		"FN:1,clamp",
		"FNDA:7,clamp",
		"DA:1,7",
		"LF:1",
		"LH:1",
		"end_of_record",
		"",
	].join("\n");

	it("parses cargo-llvm-cov LCOV into canonical per-file metrics", () => {
		const cov = parseLcov(RUST_LCOV);
		const lib = cov.files.get("src/lib.rs");
		if (!lib) throw new Error("missing src/lib.rs");
		expect(lib.lines).toEqual({ covered: 2, total: 4, pct: 50 });
		expect(lib.functions).toEqual({ covered: 1, total: 2, pct: 50 });
		expect(lib.branches).toEqual({ covered: 0, total: 2, pct: 0 });
		expect(cov.files.get("src/util.rs")?.lines.pct).toBe(100);
	});

	it("flags a per-file regression on a .rs file via the unchanged ratchet", () => {
		const summary = canonicalToCoverageSummary(parseLcov(RUST_LCOV));
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files: {
				"src/lib.rs": { lines_pct: 100, branches_pct: 100 },
				"src/util.rs": { lines_pct: 100, branches_pct: 100 },
			},
		};

		const result = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 0 },
			repoRoot: process.cwd(),
		});

		const lineFinding = result.findings.find(
			(f) => f.file === "src/lib.rs" && f.metric === "lines",
		);
		expect(lineFinding?.current_pct).toBe(50);
		expect(result.findings.some((f) => f.file === "src/util.rs")).toBe(false);
	});
});
