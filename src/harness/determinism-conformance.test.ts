// Unit-level coverage for `determinism-conformance.ts` — complements the
// heavier `__tests__/determinism-conformance.integration.test.ts` (which
// drives the pipeline against real detectors and a fresh process). Here the
// inline check pipeline is mocked so specific branches (throwing detector,
// divergence classification, cwd-leak detection, corpus aggregation) can be
// forced deterministically without depending on which real detectors fire.

import { describe, expect, it, vi } from "vitest";

const { mockBuild } = vi.hoisted(() => ({ mockBuild: vi.fn() }));

vi.mock("./check-registry/index.js", () => ({
	buildAgentSafetyChecks: (...args: unknown[]) => mockBuild(...args),
}));

import {
	canonicalizeFindings,
	checkRepeatDeterminism,
	classifyDivergence,
	type ConformanceFinding,
	type CorpusItem,
	runCorpusConformance,
	runInlinePipeline,
} from "./determinism-conformance.js";

describe("runInlinePipeline", () => {
	it("skips a detector whose fn() throws, keeping the ok detector's findings", () => {
		mockBuild.mockReturnValue([
			{
				name: "throws_check",
				severity: "error" as const,
				fn: () => {
					throw new Error("boom");
				},
			},
			{
				name: "ok_check",
				severity: "warning" as const,
				fn: () => [{ line: 3, text: "found it" }],
			},
		]);
		const result = runInlinePipeline("content", "file.ts");
		expect(result).toEqual([{ check_id: "ok_check", severity: "warning", line: 3, text: "found it" }]);
	});
});

describe("canonicalizeFindings / compareFindings ordering", () => {
	it("sorts by check_id, then line, then severity, then text, stably on ties", () => {
		const findings: ConformanceFinding[] = [
			{ check_id: "b", severity: "warning", line: 2, text: "y" },
			{ check_id: "b", severity: "warning", line: 1, text: "z" },
			{ check_id: "a", severity: "error", line: 5, text: "m" },
			{ check_id: "a", severity: "warning", line: 5, text: "m" },
			{ check_id: "a", severity: "warning", line: 5, text: "n" },
			{ check_id: "a", severity: "warning", line: 5, text: "m" },
		];
		const sorted = JSON.parse(canonicalizeFindings(findings));
		expect(sorted).toEqual([
			{ check_id: "a", severity: "error", line: 5, text: "m" },
			{ check_id: "a", severity: "warning", line: 5, text: "m" },
			{ check_id: "a", severity: "warning", line: 5, text: "m" },
			{ check_id: "a", severity: "warning", line: 5, text: "n" },
			{ check_id: "b", severity: "warning", line: 1, text: "z" },
			{ check_id: "b", severity: "warning", line: 2, text: "y" },
		]);
	});

	it("is order-independent", () => {
		const a: ConformanceFinding[] = [
			{ check_id: "b_check", severity: "warning", line: 2, text: "y" },
			{ check_id: "a_check", severity: "error", line: 1, text: "x" },
		];
		const b = [...a].reverse();
		expect(canonicalizeFindings(a)).toEqual(canonicalizeFindings(b));
	});
});

describe("classifyDivergence", () => {
	it("returns count when the two finding sets differ in length", () => {
		const one: ConformanceFinding[] = [{ check_id: "c", severity: "warning", line: 1, text: "x" }];
		expect(classifyDivergence([], one)).toEqual({ kind: "count", detail: "0 findings vs 1" });
	});

	it("returns none for element-wise identical sets (also exercises the equal-element continue)", () => {
		const f: ConformanceFinding[] = [{ check_id: "a", severity: "warning", line: 1, text: "x" }];
		expect(classifyDivergence(f, f)).toEqual({ kind: "none", detail: "no element-wise difference" });
	});

	it("returns timestamp when differing text embeds a timestamp, truncating long text", () => {
		const longSuffix = "z".repeat(90);
		const a: ConformanceFinding[] = [
			{ check_id: "c", severity: "warning", line: 2, text: `ran at 2026-06-04T00:00 ${longSuffix}` },
		];
		const b: ConformanceFinding[] = [
			{ check_id: "c", severity: "warning", line: 2, text: `ran at 2026-06-04T11:11 ${longSuffix}` },
		];
		const d = classifyDivergence(a, b);
		expect(d.kind).toBe("timestamp");
		expect(d.detail).toContain("…");
		expect(d.detail.length).toBeLessThan(200);
	});

	it("returns cwd_leak when differing text embeds the working directory", () => {
		const cwd = process.cwd();
		const a: ConformanceFinding[] = [{ check_id: "c", severity: "warning", line: 1, text: "clean text" }];
		const b: ConformanceFinding[] = [{ check_id: "c", severity: "warning", line: 1, text: `leaked ${cwd}/file.ts` }];
		expect(classifyDivergence(a, b)).toEqual({
			kind: "cwd_leak",
			detail: "c: working-directory path in finding text",
		});
	});

	it("returns text for a plain content difference with short (untruncated) text", () => {
		const a: ConformanceFinding[] = [{ check_id: "c", severity: "warning", line: 1, text: "foo" }];
		const b: ConformanceFinding[] = [{ check_id: "c", severity: "warning", line: 1, text: "bar" }];
		expect(classifyDivergence(a, b)).toEqual({ kind: "text", detail: 'c L1: "foo" vs "bar"' });
	});

	it("falls through to text divergence when text is identical but severity differs", () => {
		const a: ConformanceFinding[] = [{ check_id: "c", severity: "warning", line: 1, text: "same" }];
		const b: ConformanceFinding[] = [{ check_id: "c", severity: "error", line: 1, text: "same" }];
		expect(classifyDivergence(a, b)).toEqual({ kind: "text", detail: 'c L1: "same" vs "same"' });
	});
});

describe("checkRepeatDeterminism", () => {
	it("reports stable, no divergence, no cwd leak when repeated runs match", () => {
		mockBuild.mockReturnValue([
			{ name: "chk", severity: "warning" as const, fn: () => [{ line: 1, text: "always same" }] },
		]);
		const r = checkRepeatDeterminism("content", "f.ts", 3);
		expect(r).toEqual({
			stable: true,
			runs: 3,
			findingCount: 1,
			checkIds: ["chk"],
		});
	});

	it("reports divergence and a cwd leak when a run's output changes and embeds cwd", () => {
		const cwd = process.cwd();
		let call = 0;
		mockBuild.mockImplementation(() => [
			{
				name: "flaky",
				severity: "warning" as const,
				fn: () => {
					call++;
					return [{ line: 1, text: call === 1 ? `leaked ${cwd}` : "changed text" }];
				},
			},
		]);
		const r = checkRepeatDeterminism("content", "f.ts", 3);
		expect(r.stable).toBe(false);
		expect(r.divergence).toEqual({
			kind: "cwd_leak",
			detail: "flaky: working-directory path in finding text",
		});
		expect(r.cwdLeak).toBe(`leaked ${cwd}`);
	});
});

describe("runCorpusConformance", () => {
	it("aggregates stable, divergent, and leaking items across a corpus", () => {
		const cwd = process.cwd();
		const counts: Record<string, number> = {};
		mockBuild.mockImplementation((_content: string, filePath: string) => [
			{
				name: `chk_${filePath}`,
				severity: "warning" as const,
				fn: () => {
					counts[filePath] = (counts[filePath] ?? 0) + 1;
					if (filePath === "flaky.ts") {
						return [{ line: 1, text: counts[filePath] === 1 ? "a" : "b" }];
					}
					if (filePath === "leaky.ts") {
						return [{ line: 1, text: `leak ${cwd}` }];
					}
					return [{ line: 1, text: "stable" }];
				},
			},
		]);
		const corpus: CorpusItem[] = [
			{ path: "stable.ts", content: "x" },
			{ path: "flaky.ts", content: "y" },
			{ path: "leaky.ts", content: "z" },
		];
		const report = runCorpusConformance(corpus, 2);
		expect(report.itemCount).toBe(3);
		expect(report.stableItems).toBe(2);
		expect(report.unstable).toEqual([
			{ path: "flaky.ts", divergence: { kind: "text", detail: 'chk_flaky.ts L1: "a" vs "b"' } },
		]);
		expect(report.leaks).toEqual([{ path: "leaky.ts", text: `leak ${cwd}` }]);
	});
});
