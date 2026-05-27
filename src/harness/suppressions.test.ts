// Focused tests for `scanInlineDeferrals` — the `interlinked: defer` inline
// marker added in PR2. The rest of `suppressions.ts` (file-level JSON, scoring
// suppression entries, glob matching) is exercised via the verify command and
// its integration tests; this colocated file pins the defer-marker contract.

import { describe, expect, it } from "vitest";

import { scanInlineDeferrals } from "./suppressions.js";

describe("scanInlineDeferrals — above-line marker (// shape)", () => {
	it("attaches the marker to the next non-comment line", () => {
		const code = "// interlinked: defer pickle_load\nobj = something()\n";
		const map = scanInlineDeferrals(code);
		expect(map.get(2)?.has("pickle_load")).toBe(true);
	});

	it("captures the reason after an em-dash", () => {
		const code = "// interlinked: defer eval_usage — sandboxed by callers\neval(x);\n";
		expect(scanInlineDeferrals(code).get(2)?.get("eval_usage")).toBe("sandboxed by callers");
	});

	it("captures the reason after a `--` separator", () => {
		const code = "// interlinked: defer eval_usage -- only fixture data\neval(x);\n";
		expect(scanInlineDeferrals(code).get(2)?.get("eval_usage")).toBe("only fixture data");
	});

	it("skips empty / pure-comment lines when locating the target", () => {
		const code = [
			"// interlinked: defer ubs_marshal_load",
			"",
			"// another comment",
			"obj = marshal.load(f)",
			"",
		].join("\n");
		expect(scanInlineDeferrals(code).get(4)?.has("ubs_marshal_load")).toBe(true);
	});

	it("supports comma-separated multiple check ids on one marker", () => {
		const code = "// interlinked: defer eval_usage, inner_html\nrun()\n";
		const entry = scanInlineDeferrals(code).get(2);
		expect(entry?.has("eval_usage")).toBe(true);
		expect(entry?.has("inner_html")).toBe(true);
	});
});

describe("scanInlineDeferrals — # shape (Python / Ruby / shell)", () => {
	it("recognises a Python defer marker above the offending line", () => {
		const code = "# interlinked: defer ubs_pickle_untrusted_load -- legacy trusted\nobj = pickle.load(f)\n";
		expect(scanInlineDeferrals(code).get(2)?.get("ubs_pickle_untrusted_load")).toBe(
			"legacy trusted",
		);
	});
});

describe("scanInlineDeferrals — trailing-comment marker", () => {
	it("attaches a trailing `// interlinked: defer` to the same line", () => {
		const code = "eval(x); // interlinked: defer eval_usage\n";
		expect(scanInlineDeferrals(code).get(1)?.has("eval_usage")).toBe(true);
	});

	it("attaches a trailing `# interlinked: defer` to the same line", () => {
		const code = "obj = pickle.load(f)  # interlinked: defer ubs_pickle_untrusted_load -- trusted\n";
		expect(scanInlineDeferrals(code).get(1)?.get("ubs_pickle_untrusted_load")).toBe("trusted");
	});

	it("does NOT treat a pure-comment line as a trailing marker (above-form takes over)", () => {
		const code = "// interlinked: defer eval_usage\nrun()\n";
		// Line 1 is a comment — marker applies to line 2 (the run() call), NOT line 1.
		expect(scanInlineDeferrals(code).get(1)).toBeUndefined();
		expect(scanInlineDeferrals(code).get(2)?.has("eval_usage")).toBe(true);
	});
});

describe("scanInlineDeferrals — negative cases", () => {
	it("ignores `interlinked-ignore` (the suppression marker, not defer)", () => {
		const code = "// interlinked-ignore: eval_usage\neval(x);\n";
		expect(scanInlineDeferrals(code).size).toBe(0);
	});

	it("ignores a marker missing the `defer` verb", () => {
		const code = "// interlinked: skip eval_usage\neval(x);\n";
		expect(scanInlineDeferrals(code).size).toBe(0);
	});

	it("returns an empty map for content with no markers", () => {
		expect(scanInlineDeferrals("const x = 1\n").size).toBe(0);
	});

	it("returns null reason when the marker has no `—` / `--` separator", () => {
		const code = "// interlinked: defer eval_usage\nrun()\n";
		expect(scanInlineDeferrals(code).get(2)?.get("eval_usage")).toBeNull();
	});
});
