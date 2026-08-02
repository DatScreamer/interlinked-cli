// ===========================================
// Predicate consolidation — pins for plan §11.3 (Audit B)
// ===========================================
// `docs/plans/16-monotonic-quality-enforcement.md` §11.3 measured three
// independent "is this a test file?" implementations
// (`coverage-test-selector.ts::isTestPath`, `large-file-policy.ts::isTestOrSpecPath`,
// `checks/shared.ts::isStrictTestFile`) and found they answered the SAME
// question with three separately-grown convention lists. This file pins:
//
//   1. `isTestSourcePath` (checks/shared.ts) is the union of all three lists,
//      correctly anchored, and its own promised conventions hold.
//   2. `isTestPath` / `isTestOrSpecPath` are now thin re-exports of it — they
//      must never again drift apart (that drift is the exact defect this
//      consolidation fixes).
//   3. `isPatternDataFile` (aka `isTestFile`) answers a DIFFERENT, third
//      question — "does this file hold detection patterns as DATA" — and is
//      DELIBERATELY not the same predicate as `isStrictTestFile` or
//      `isTestSourcePath`. A future drive-by consolidation must not merge it
//      into the union silently; this file locks in the three-way split.

import { afterEach, describe, expect, it } from "vitest";
import {
	__setPackageRootForTesting,
	isPatternDataFile,
	isStrictTestFile,
	isTestFile,
	isTestSourcePath,
} from "../checks/shared.js";
import { isTestPath } from "../coverage-test-selector.js";
import { isTestOrSpecPath } from "../large-file-policy.js";

// ---------------------------------------------------------------------------
// isTestSourcePath — positive (must fire)
// ---------------------------------------------------------------------------

describe("isTestSourcePath — positive (must fire)", () => {
	it("P1: matches the .test./.spec. filename convention (JS/TS)", () => {
		expect(isTestSourcePath("src/m.test.ts")).toBe(true);
		expect(isTestSourcePath("src/m.spec.tsx")).toBe(true);
	});

	it("P2: matches the __tests__/ directory convention", () => {
		expect(isTestSourcePath("src/__tests__/m.ts")).toBe(true);
	});

	it("P3: matches a bare top-level tests/ directory addressed relatively (union widening)", () => {
		// Neither of the pre-consolidation `isTestPath` (only matched
		// __tests__/) nor a non-anchored substring check would catch this;
		// isTestSourcePath's anchored `(?:^|\/)tests?\/` does.
		expect(isTestSourcePath("tests/helper.ts")).toBe(true);
	});

	it("P4: matches a bare top-level SINGULAR test/ directory — the real repo file", () => {
		// test/agent-driven/run-scenario.ts is a real file in this tree. Before
		// this consolidation, isTestPath said false for it (only large-file-
		// policy's isTestOrSpecPath and shared.ts's isStrictTestFile agreed it
		// was a test path) — the exact divergence measured in plan §11.3.
		expect(isTestSourcePath("test/agent-driven/run-scenario.ts")).toBe(true);
	});

	it("P5: matches Python/Go/Java/Swift conventions", () => {
		expect(isTestSourcePath("pkg/m_test.go")).toBe(true);
		expect(isTestSourcePath("src/m_test.py")).toBe(true);
		expect(isTestSourcePath("tests/test_m.py")).toBe(true);
		expect(isTestSourcePath("app/src/test/FooTest.java")).toBe(true);
		expect(isTestSourcePath("src/FooTest.swift")).toBe(true);
		expect(isTestSourcePath("src/test_foo.swift")).toBe(true);
	});

	it("P6: matches a NON-JS extension after .test./.spec. (union widening beyond isTestOrSpecPath)", () => {
		// isTestOrSpecPath's pre-consolidation regex restricted the filename
		// match to the JS/TS extension family; isTestPath's broader
		// any-extension convention wins in the union (safe direction: it only
		// ever excludes more files from mutation/baselining).
		expect(isTestSourcePath("src/a.test.rb")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// isTestSourcePath — negative (must not fire)
// ---------------------------------------------------------------------------

describe("isTestSourcePath — negative (must not fire)", () => {
	it("N1: plain source files with no test convention", () => {
		expect(isTestSourcePath("src/m.ts")).toBe(false);
	});

	it("N2: a 'test' substring inside a filename is not a test file", () => {
		expect(isTestSourcePath("src/testimony.ts")).toBe(false);
		expect(isTestSourcePath("src/contest.py")).toBe(false);
		expect(isTestSourcePath("src/latest.go")).toBe(false);
	});

	it("N3: interlinked-cli's own detector source is NOT a test by this predicate", () => {
		// Contrast with isPatternDataFile below: this same path IS exempted
		// from content scans (question 3) but is NOT a test oracle (question
		// 1) — the two questions must give different answers for this path.
		expect(isTestSourcePath("src/harness/checks/shared.ts")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Delegate parity — isTestPath / isTestOrSpecPath must never drift from
// isTestSourcePath again (the exact class of bug this consolidation fixes).
// ---------------------------------------------------------------------------

describe("isTestPath / isTestOrSpecPath delegate identically to isTestSourcePath", () => {
	const paths = [
		"src/m.test.ts",
		"src/m.spec.tsx",
		"src/__tests__/m.ts",
		"tests/helper.ts",
		"test/agent-driven/run-scenario.ts",
		"pkg/m_test.go",
		"src/m_test.py",
		"tests/test_m.py",
		"app/src/test/FooTest.java",
		"src/FooTest.swift",
		"src/a.test.rb",
		"src/m.ts",
		"src/testimony.ts",
		"src/contest.py",
		"src/latest.go",
		"src/harness/checks/shared.ts",
	];

	it("agree on every path in the battery, matching isTestSourcePath exactly", () => {
		// Explicit per-path assertions (not a single `.every()`) so the check
		// discriminates: a bug in one path's delegation fails that specific
		// case rather than being averaged away.
		expect(paths.length).toBeGreaterThan(0);
		for (const p of paths) {
			const canonical = isTestSourcePath(p);
			expect(isTestPath(p)).toBe(canonical);
			expect(isTestOrSpecPath(p)).toBe(canonical);
		}
	});

	it("both true and false answers actually occur in the battery (the parity check is not vacuous)", () => {
		const answers = paths.map((p) => isTestSourcePath(p));
		expect(answers.some(Boolean)).toBe(true);
		expect(answers.some((a) => !a)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The deliberate three-way split — question 1 (isTestSourcePath / isStrictTestFile
// as an oracle) vs question 3 (isPatternDataFile / isTestFile as a content-scan
// exemption). This is the divergence the task explicitly asks to protect: a
// future consolidation must not fold isPatternDataFile into the isTestSourcePath
// union, because that would make every test-hygiene-style check newly fire on
// interlinked-cli's own detector files (the documented
// duplicate_test_names-on-verification-stop-checks FP shape).
// ---------------------------------------------------------------------------

describe("isPatternDataFile / isTestFile — deliberate divergence from isStrictTestFile and isTestSourcePath", () => {
	afterEach(() => {
		// Reset so the override never leaks into other describe blocks / files
		// — the cache is module-level state shared by every caller in this
		// test module.
		__setPackageRootForTesting(undefined);
	});

	it("D1: a harness detector file is pattern-data-exempt but NOT a genuine test file", () => {
		__setPackageRootForTesting("/pkg/interlinked-cli");
		const detectorFile = "/pkg/interlinked-cli/src/harness/checks/shared.ts";

		// Question 3: content scans should skip this file (it holds detection
		// patterns as DATA).
		expect(isPatternDataFile(detectorFile)).toBe(true);
		// The public alias must agree with the renamed predicate exactly.
		expect(isTestFile(detectorFile)).toBe(true);

		// Question 1: it is NOT an oracle the test runner executes.
		expect(isStrictTestFile(detectorFile)).toBe(false);
		expect(isTestSourcePath(detectorFile)).toBe(false);
	});

	it("D2: a genuine test file is TRUE under every predicate — no divergence for the common case", () => {
		__setPackageRootForTesting("/pkg/interlinked-cli");
		const genuineTest = "/pkg/interlinked-cli/src/foo.test.ts";
		expect(isPatternDataFile(genuineTest)).toBe(true);
		expect(isTestFile(genuineTest)).toBe(true);
		expect(isStrictTestFile(genuineTest)).toBe(true);
		expect(isTestSourcePath(genuineTest)).toBe(true);
	});

	it("D3: a user project's own harness/checks/ directory does NOT inherit the exemption", () => {
		// Package-root scoping: the exemption is interlinked-cli's own, not
		// every repo that happens to name a directory the same way.
		__setPackageRootForTesting("/pkg/interlinked-cli");
		const userFile = "/Users/alice/my-project/src/harness/checks/foo.ts";
		expect(isPatternDataFile(userFile)).toBe(false);
		expect(isTestFile(userFile)).toBe(false);
		expect(isStrictTestFile(userFile)).toBe(false);
		expect(isTestSourcePath(userFile)).toBe(false);
	});

	it("D4: isTestFile and isPatternDataFile never disagree (alias identity) across a mixed battery", () => {
		__setPackageRootForTesting("/pkg/interlinked-cli");
		const battery = [
			"/pkg/interlinked-cli/src/harness/checks/shared.ts",
			"/pkg/interlinked-cli/src/harness/rules/builtin-rules.ts",
			"/pkg/interlinked-cli/src/foo.test.ts",
			"/pkg/interlinked-cli/src/lib/config.ts",
			"/Users/alice/my-project/src/index.ts",
		];
		expect(battery.length).toBeGreaterThan(0);
		for (const p of battery) {
			expect(isTestFile(p)).toBe(isPatternDataFile(p));
		}
	});
});

// ---------------------------------------------------------------------------
// isHarnessInternalDataFile relative-path fix (plan §11.3, latent defect 2):
// the exemption used to depend on the CALLER passing an absolute path. Pin
// that a RELATIVE path — resolved against cwd — now also qualifies, via the
// public isPatternDataFile/isTestFile entry points.
// ---------------------------------------------------------------------------

describe("isPatternDataFile resolves a RELATIVE path before the package-root check", () => {
	afterEach(() => {
		__setPackageRootForTesting(undefined);
	});

	it("R1: a relative path under the real repo root is exempted, matching the absolute form", () => {
		// `resolve()` defaults to process.cwd(); this test suite always runs
		// with cwd at the repo root, so process.cwd() IS the real package
		// root — set the override to match, exactly like a caller who never
		// heard of the relative-path bug would expect it to "just work".
		__setPackageRootForTesting(process.cwd());
		const relative = "src/harness/checks/shared.ts";
		const absolute = `${process.cwd()}/src/harness/checks/shared.ts`;

		expect(isPatternDataFile(absolute)).toBe(true);
		expect(isPatternDataFile(relative)).toBe(true);
		expect(isPatternDataFile(relative)).toBe(isPatternDataFile(absolute));
	});

	it("R2: a relative path that does NOT resolve under the package root is still rejected", () => {
		__setPackageRootForTesting("/some/other/package/root");
		// process.cwd() is the real repo root, which does not start with the
		// fake override above, so resolving "src/harness/checks/shared.ts"
		// against cwd must NOT match this fake pkgRoot.
		expect(isPatternDataFile("src/harness/checks/shared.ts")).toBe(false);
	});
});
