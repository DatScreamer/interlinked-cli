// Companion test for the generic per-function-metric write gate. The two live
// specs (cyclomatic, cognitive) have their own end-to-end suites
// (complexity-write-guard.test.ts / cognitive-write-guard.block.test.ts); this
// file pins the SHARED engine against a synthetic metric so each parameter —
// label, unit wording, slew tolerance, cap resolver, analyzer dispatch, advice
// — is proven to be honored independently of either real metric.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildMetricBlock,
	checkPerFunctionMetricWrite,
	type MetricGateSpec,
	projectContent,
	resolveFilePath,
} from "./per-function-metric-gate.js";

interface FakeEntry {
	name: string;
	score: number;
}

/** Content grammar for the fake analyzer: one `name:score` per line. */
function parseFake(content: string): FakeEntry[] {
	return content
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => {
			const [name = "", raw = "0"] = l.split(":");
			return { name, score: Number(raw) };
		});
}

let unavailable = false;
const unavailableSpy = vi.fn();

function makeSpec(overrides: Partial<MetricGateSpec<FakeEntry>> = {}): MetricGateSpec<FakeEntry> {
	return {
		label: "fake",
		anonName: "(callback)",
		slewTolerance: 3,
		metricOf: (e) => e.score,
		selectAnalyzer: (filePath) =>
			filePath.endsWith(".fake")
				? { compute: (content) => (unavailable ? null : parseFake(content)), language: "fake_lang" }
				: null,
		capFor: () => 10,
		onAnalyzerUnavailable: unavailableSpy,
		limitPhrase: "fake limit",
		unitPlural: "widget(s)",
		unitAdj: "widget",
		advice: "Decompose: split it up.",
		...overrides,
	};
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pfmg-"));
	unavailable = false;
	unavailableSpy.mockClear();
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function seed(rel: string, content: string): string {
	const abs = join(tmp, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf-8");
	return abs;
}

describe("resolveFilePath", () => {
	it("prefers file_path", () => {
		expect(resolveFilePath({ file_path: "a.ts", path: "b.ts" })).toBe("a.ts");
	});

	it("falls back to path", () => {
		expect(resolveFilePath({ path: "b.ts" })).toBe("b.ts");
	});

	it("returns empty string when neither key is a string", () => {
		expect(resolveFilePath({ file_path: 3 })).toBe("");
	});
});

describe("projectContent", () => {
	it("projects a Write as its literal content", () => {
		const abs = seed("w.fake", "f:1\n");
		expect(projectContent({ content: "g:2\n" }, abs)).toEqual({ before: "f:1\n", after: "g:2\n" });
	});

	it("applies a single Edit replacement", () => {
		const abs = seed("e.fake", "f:1\n");
		expect(projectContent({ old_string: "f:1", new_string: "f:9" }, abs)?.after).toBe("f:9\n");
	});

	it("applies every MultiEdit entry in order", () => {
		const abs = seed("m.fake", "f:1\ng:2\n");
		const out = projectContent(
			{
				edits: [
					{ old_string: "f:1", new_string: "f:4" },
					{ old_string: "g:2", new_string: "g:5" },
				],
			},
			abs,
		);
		expect(out?.after).toBe("f:4\ng:5\n");
	});

	it("returns null for an Edit against a missing file", () => {
		expect(projectContent({ old_string: "a", new_string: "b" }, join(tmp, "nope.fake"))).toBeNull();
	});

	it("returns null for an unknown tool-input shape", () => {
		const abs = seed("u.fake", "f:1\n");
		expect(projectContent({ whatever: true }, abs)).toBeNull();
	});
});

describe("checkPerFunctionMetricWrite — over-cap band", () => {
	it("blocks a brand-new over-cap function", () => {
		const abs = seed("a.fake", "keep:1\n");
		const out = checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "big:20\n" }, tmp);
		expect(out?.block).toContain("big (fake 20, new over-cap function)");
	});

	it("blocks raising an existing over-cap function", () => {
		const abs = seed("b.fake", "big:20\n");
		const out = checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "big:30\n" }, tmp);
		expect(out?.block).toContain("big (fake 30, raised from 20)");
	});

	it("allows holding an already-over-cap function", () => {
		const abs = seed("c.fake", "big:20\n");
		expect(
			checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "big:20\n" }, tmp),
		).toBeNull();
	});

	it("allows shrinking an over-cap function", () => {
		const abs = seed("d.fake", "big:20\n");
		expect(
			checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "big:15\n" }, tmp),
		).toBeNull();
	});

	it("blocks relocation into a newly-named over-cap helper (identity comparison)", () => {
		const abs = seed("e.fake", "big:30\n");
		const out = checkPerFunctionMetricWrite(
			makeSpec(),
			{ file_path: abs, content: "big:20\nhelper:19\n" },
			tmp,
		);
		expect(out?.block).toContain("helper (fake 19, new over-cap function)");
	});

	it("blocks a new over-cap anonymous entry via the pooled rank path", () => {
		const abs = seed("f.fake", "keep:1\n");
		const out = checkPerFunctionMetricWrite(
			makeSpec(),
			{ file_path: abs, content: "(callback):40\n" },
			tmp,
		);
		expect(out?.block).toContain("(callback) (fake 40, new anonymous function over cap)");
	});

	it("allows an anonymous entry that holds its pooled rank", () => {
		const abs = seed("g.fake", "(callback):40\n");
		expect(
			checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "(callback):40\n" }, tmp),
		).toBeNull();
	});

	it("treats a colliding name as ambiguous and pools it", () => {
		const abs = seed("h.fake", "dup:40\ndup:1\n");
		const out = checkPerFunctionMetricWrite(
			makeSpec(),
			{ file_path: abs, content: "dup:41\ndup:1\n" },
			tmp,
		);
		expect(out?.block).toContain("dup (fake 41, new over-cap function)");
	});
});

describe("checkPerFunctionMetricWrite — sub-cap slew ratchet", () => {
	it("allows a rise within the tolerance", () => {
		const abs = seed("i.fake", "f:1\n");
		expect(
			checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "f:4\n" }, tmp),
		).toBeNull();
	});

	it("blocks a rise over the tolerance", () => {
		const abs = seed("j.fake", "f:1\n");
		const out = checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "f:9\n" }, tmp);
		expect(out?.block).toContain(
			"f (fake 1 -> 9 — rose 8 in one edit, over the +3/edit sub-cap limit)",
		);
	});

	it("honors a different tolerance from the spec", () => {
		const abs = seed("k.fake", "f:1\n");
		const out = checkPerFunctionMetricWrite(
			makeSpec({ slewTolerance: 9 }),
			{ file_path: abs, content: "f:9\n" },
			tmp,
		);
		expect(out).toBeNull();
	});
});

describe("checkPerFunctionMetricWrite — dispatch and fail-open", () => {
	it("skips a path the spec's analyzer selector rejects", () => {
		const abs = seed("l.other", "big:99\n");
		expect(
			checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "big:99\n" }, tmp),
		).toBeNull();
	});

	it("fails open and reports the degrade when the analyzer is unavailable", () => {
		unavailable = true;
		const abs = seed("m.fake", "f:1\n");
		expect(
			checkPerFunctionMetricWrite(makeSpec(), { file_path: abs, content: "big:99\n" }, tmp),
		).toBeNull();
		expect(unavailableSpy).toHaveBeenCalledWith("fake_lang");
	});

	it("hands the parsed before/after entries to the observer", () => {
		const abs = seed("n.fake", "f:1\n");
		const observe = vi.fn();
		const out = checkPerFunctionMetricWrite(
			makeSpec(),
			{ file_path: abs, content: "f:2\n" },
			tmp,
			observe,
		);
		expect(out).toBeNull();
		expect(observe).toHaveBeenCalledWith(abs, [{ name: "f", score: 1 }], [{ name: "f", score: 2 }], "f:2\n");
	});

	it("uses the cap the spec resolves", () => {
		const abs = seed("o.fake", "keep:1\n");
		const out = checkPerFunctionMetricWrite(
			makeSpec({ capFor: () => 50 }),
			{ file_path: abs, content: "big:20\n" },
			tmp,
		);
		expect(out).toBeNull();
	});
});

describe("checkPerFunctionMetricWrite — apply_patch", () => {
	it("blocks an over-cap function introduced by an apply_patch add", () => {
		const patch = "*** Begin Patch\n*** Add File: added.fake\n+big:40\n*** End Patch";
		const out = checkPerFunctionMetricWrite(makeSpec(), { command: patch }, tmp);
		expect(out?.block).toContain("added.fake: big (fake 40, new over-cap function)");
	});

	it("allows an apply_patch that adds only under-cap functions", () => {
		const patch = "*** Begin Patch\n*** Add File: ok.fake\n+small:2\n*** End Patch";
		expect(checkPerFunctionMetricWrite(makeSpec(), { command: patch }, tmp)).toBeNull();
	});

	it("skips apply_patch sections the analyzer selector rejects", () => {
		const patch = "*** Begin Patch\n*** Add File: added.other\n+big:40\n*** End Patch";
		expect(checkPerFunctionMetricWrite(makeSpec(), { command: patch }, tmp)).toBeNull();
	});
});

describe("buildMetricBlock", () => {
	it("renders the spec's label, units, tolerance, advice and caps command", () => {
		const text = buildMetricBlock(makeSpec(), ["x (fake 12, new over-cap function)"], 10);
		expect(text).toBe(
			"[interlinked:fake] BLOCKED: this edit pushes 1 function(s) past a fake limit — a function " +
				"may rise by at most 3 widget(s) per edit, and no function may exceed the 10-widget cap:\n" +
				"  • x (fake 12, new over-cap function)\n" +
				"Decompose: split it up. Holding or reducing an existing function is always allowed; " +
				"there is no suppression.\n" +
				"This 10-widget cap is per-repo configurable: `interlinked caps set fake <n>` " +
				"(run `interlinked caps explain fake` for what fake complexity measures).",
		);
	});
});
