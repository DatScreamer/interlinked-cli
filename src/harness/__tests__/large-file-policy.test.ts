import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	countLines,
	DEFAULT_MAX_LINES,
	evaluateLargeFile,
	isCappableFile,
	isTestOrSpecPath,
	type LargeFileBaseline,
	loadLargeFileBaseline,
	maxLinesFor,
	resetLargeFileBaselineCache,
} from "../large-file-policy.js";

describe("DEFAULT_MAX_LINES", () => {
	it("is the canonical 500-line cap", () => {
		expect(DEFAULT_MAX_LINES).toBe(500);
	});

	// Single source of truth: the in-code default and the committed baseline's
	// max_lines MUST be the same number, so the enforced cap is never two values
	// depending on whether a baseline loaded. Ratcheting the cap means changing
	// BOTH together; this test fails the moment they drift apart.
	it("equals the committed baseline's max_lines (no drift)", () => {
		const baselinePath = join(process.cwd(), ".interlinked", "large-files-baseline.json");
		const committed = JSON.parse(readFileSync(baselinePath, "utf-8")) as { max_lines: number };
		expect(committed.max_lines).toBe(DEFAULT_MAX_LINES);
	});
});

describe("countLines", () => {
	it("counts newline-split segments", () => {
		expect(countLines("a\nb\nc")).toBe(3);
		expect(countLines("single")).toBe(1);
		// Trailing newline yields an empty last segment — consistent with the
		// long-standing checkLargeFile definition.
		expect(countLines("a\nb\n")).toBe(3);
	});
});

describe("isTestOrSpecPath", () => {
	it("detects .test/.spec suffixes and __tests__/tests dirs", () => {
		expect(isTestOrSpecPath("src/foo.test.ts")).toBe(true);
		expect(isTestOrSpecPath("src/foo.spec.tsx")).toBe(true);
		expect(isTestOrSpecPath("src/harness/__tests__/evaluator.test.ts")).toBe(true);
		expect(isTestOrSpecPath("pkg/handler_test.go")).toBe(true);
		expect(isTestOrSpecPath("src/main/FooTest.java")).toBe(true);
	});

	// The critical regression: shared.ts::isTestFile treats interlinked-cli's
	// own harness/checks/ and harness/check-registry/ files as "test files"
	// (a content-scan FP exemption). The cap must NOT inherit that — a line
	// count is a real fact regardless of whether the file is a detector.
	it("does NOT exempt harness detector / registry source files", () => {
		expect(isTestOrSpecPath("src/harness/checks/ubs-language-specific.ts")).toBe(false);
		expect(isTestOrSpecPath("src/harness/check-registry/entries-warnings.ts")).toBe(false);
		expect(isTestOrSpecPath("src/harness/server.ts")).toBe(false);
	});
});

describe("isCappableFile", () => {
	const content = "export const x = 1;\n";

	it("flags hand-written code modules as cappable", () => {
		expect(isCappableFile({ filePath: "src/harness/server.ts", content })).toBe(true);
		expect(isCappableFile({ filePath: "src/lib/config.ts", content })).toBe(true);
		expect(
			isCappableFile({ filePath: "src/harness/checks/ubs-language-specific.ts", content }),
		).toBe(true);
	});

	it("exempts declaration, test, generated-path, and non-code files", () => {
		expect(isCappableFile({ filePath: "src/api.d.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/foo.test.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/generated/client.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/client.gen.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "docs/guide.md", content })).toBe(false);
		expect(isCappableFile({ filePath: "config/data.json", content })).toBe(false);
	});

	it("exempts files carrying a generated-content marker", () => {
		const generated = "// @generated SignedSource<<abc123>>\nexport const x = 1;\n";
		expect(isCappableFile({ filePath: "src/schema.ts", content: generated })).toBe(false);
	});

	it("exempts files carrying a @codegen-data header marker", () => {
		// Codegen-DATA modules (large template strings emitted verbatim into
		// generated output) are exempt from the line cap — scoped to the cap
		// only, NOT a full @generated exemption (tsc/lint still run).
		const codegenData =
			"// foo-template.ts @codegen-data: template DATA, cap-exempt\nexport const X = `...`;\n";
		expect(
			isCappableFile({ filePath: "src/lib/foo-template.ts", content: codegenData }),
		).toBe(false);
		// Bounded scan: a marker buried past the 20-line header does NOT exempt.
		const buried = `${"// pad\n".repeat(25)}// @codegen-data\nexport const X = 1;\n`;
		expect(isCappableFile({ filePath: "src/lib/bar.ts", content: buried })).toBe(true);
	});

	it("exempts the harness's own .interlinked/ state dir and diff/patch artifacts", () => {
		// .interlinked/ is tool state (logs, trigram index, archives, e2e probes,
		// workflow scratch) — never a product module, so a count there is moot.
		expect(isCappableFile({ filePath: ".interlinked/e2e-stability.mjs", content })).toBe(false);
		expect(isCappableFile({ filePath: "sub/.interlinked/probe.ts", content })).toBe(false);
		expect(
			isCappableFile({ filePath: ".interlinked/merge-patches/item-4.diff", content }),
		).toBe(false);
		expect(isCappableFile({ filePath: "patches/fix.patch", content })).toBe(false);
		// A non-dot "interlinked" directory is ordinary source — still cappable.
		expect(isCappableFile({ filePath: "src/interlinked/feature.ts", content })).toBe(true);
	});
});

describe("evaluateLargeFile", () => {
	const baseline: LargeFileBaseline = {
		version: 1,
		max_lines: 1500,
		files: { "src/harness/server.ts": 3747 },
	};

	it("passes files at or under the cap", () => {
		const verdict = evaluateLargeFile({ relPath: "src/small.ts", lines: 1500, baseline });
		expect(verdict.overCap).toBe(false);
		expect(verdict.grandfathered).toBe(false);
	});

	it("fails a non-baselined file over the cap", () => {
		const verdict = evaluateLargeFile({ relPath: "src/new-big.ts", lines: 1800, baseline });
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});

	it("grandfathers a baselined file within its recorded ceiling", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 3700,
			baseline,
		});
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(true);
		expect(verdict.ceiling).toBe(3747);
	});

	it("fails a baselined file that grew past its recorded ceiling", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 3800,
			baseline,
		});
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(false); // ratchet violated by growth
	});

	it("treats a shrunk-under-cap baselined file as simply passing", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 900,
			baseline,
		});
		expect(verdict.overCap).toBe(false);
		expect(verdict.grandfathered).toBe(false);
	});

	it("falls back to DEFAULT_MAX_LINES when no baseline is loaded", () => {
		const verdict = evaluateLargeFile({ relPath: "src/x.ts", lines: 1501, baseline: null });
		expect(verdict.overCap).toBe(true);
	});

	it("honors an explicit maxLines override below the baseline cap (verify path)", () => {
		// baseline cap is 1500, but a repo that ran `interlinked caps set lines 300`
		// resolves to 300 — a 400-line file is over the EFFECTIVE cap. verify must
		// pass that resolved cap, not the baseline (finding 2026-06, round 8).
		const verdict = evaluateLargeFile({ relPath: "src/x.ts", lines: 400, baseline, maxLines: 300 });
		expect(verdict.overCap).toBe(true);
	});

	it("honors a RAISED maxLines override (a file the baseline would flag passes)", () => {
		const verdict = evaluateLargeFile({ relPath: "src/x.ts", lines: 1600, baseline, maxLines: 2000 });
		expect(verdict.overCap).toBe(false);
	});
});

describe("loadLargeFileBaseline + maxLinesFor", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lfp-"));
		resetLargeFileBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetLargeFileBaselineCache();
	});

	it("returns null + the default cap when no baseline file exists", () => {
		expect(loadLargeFileBaseline(dir)).toBeNull();
		expect(maxLinesFor(dir)).toBe(DEFAULT_MAX_LINES);
	});

	it("loads max_lines and the grandfather map", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ version: 1, max_lines: 1200, files: { "src/big.ts": 2000 } }),
		);
		resetLargeFileBaselineCache();
		const baseline = loadLargeFileBaseline(dir);
		expect(baseline?.max_lines).toBe(1200);
		expect(baseline?.files["src/big.ts"]).toBe(2000);
		expect(maxLinesFor(dir)).toBe(1200);
	});

	it("fails soft to the default cap on malformed JSON", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "large-files-baseline.json"), "{ not json");
		resetLargeFileBaselineCache();
		expect(loadLargeFileBaseline(dir)).toBeNull();
		expect(maxLinesFor(dir)).toBe(DEFAULT_MAX_LINES);
	});

	it("metric-caps.json max_lines override beats the baseline (interlinked caps set lines)", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ version: 1, max_lines: 1200, files: {} }),
		);
		writeFileSync(
			join(dir, ".interlinked", "metric-caps.json"),
			JSON.stringify({ version: 1, max_lines: 222 }),
		);
		resetLargeFileBaselineCache();
		// maxLinesFor layers metric-caps.json (the unified caps surface) OVER the
		// large-files baseline; verify resolves through this, so a lowered cap is no
		// longer silently ignored there (finding 2026-06, round 8).
		expect(maxLinesFor(dir)).toBe(222);
	});
});
