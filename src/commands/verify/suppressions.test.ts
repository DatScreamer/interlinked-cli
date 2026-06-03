// ===========================================
// suppressions unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { collectSuppressionFindings, findSuppressionMatch } from "./suppressions.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

describe("findSuppressionMatch", () => {
	it("flags bare ts-ignore with no rationale", () => {
		const line = `// ${["@ts", "ignore"].join("-")}`;
		const hit = findSuppressionMatch(line, line);
		expect(hit).not.toBeNull();
		expect(hit?.label).toBe(["@ts", "ignore"].join("-"));
	});

	it("accepts ts-expect-error with a long rationale", () => {
		const directive = ["@ts", "expect", "error"].join("-");
		const line = `// ${directive}: narrowed via isFoo helper above`;
		expect(findSuppressionMatch(line, line)).toBeNull();
	});

	it("rejects ts-expect-error with too-short rationale", () => {
		const directive = ["@ts", "expect", "error"].join("-");
		const line = `// ${directive}: x`;
		expect(findSuppressionMatch(line, line)).not.toBeNull();
	});

	it("returns null for non-suppression lines", () => {
		expect(findSuppressionMatch("const x = 1;", "const x = 1;")).toBeNull();
	});

	it("does not treat // noqa (JS comment) as a directive", () => {
		// noqa is a Python/flake8 convention; a `// noqa` in TS is prose, e.g. a
		// detector commenting on how it scans noqa ranges.
		const line = "// noqa suppression range scan (Python checks)";
		expect(findSuppressionMatch(line, line)).toBeNull();
	});

	it("flags bare # noqa (Python convention)", () => {
		const line = "x = risky()  # noqa";
		expect(findSuppressionMatch(line, line)).not.toBeNull();
	});
});

describe("collectSuppressionFindings", () => {
	it("ignores suppression strings inside string literals", () => {
		const content = [`const s = "// ${["@ts", "ignore"].join("-")}";`, ""].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "fixture.ts", out);
		expect(out.length).toBe(0);
	});

	it("records suppression findings with the file path", () => {
		const content = [`// ${["@ts", "ignore"].join("-")}`, "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "fixture.ts", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].file).toBe("fixture.ts");
		expect(out[0].check).toBe("suppressions");
	});

	it("does not flag # noqa inside a JS/TS string fixture", () => {
		// Python code samples live inside TS template-literal fixtures; `#` is not
		// a comment in TS, so the directive there is data, not a suppression.
		const content = "const code = `value = risky()  # noqa`;";
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/harness/checks/foo.test.ts", out);
		expect(out.length).toBe(0);
	});

	it("flags a bare # noqa in a Python file (real directive there)", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "scripts/foo.py", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("exempts files under a fixtures/ dir (deliberately-crafted bad samples)", () => {
		const content = [`// ${["@ts", "nocheck"].join("-")}`, "const x = 1;"].join("\n");
		const exempt: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/harness/__tests__/fixtures/supermodel/high-risk.ts", exempt);
		expect(exempt.length).toBe(0);
		// Same content in real source is still flagged — the exemption is fixtures-only.
		const real: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/harness/risk.ts", real);
		expect(real.length).toBeGreaterThanOrEqual(1);
	});
});
