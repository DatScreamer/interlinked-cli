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
});
