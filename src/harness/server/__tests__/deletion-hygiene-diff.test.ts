import { describe, expect, it } from "vitest";
import { collectDeletionHygieneDiffFindings } from "../deletion-hygiene-diff.js";

describe("collectDeletionHygieneDiffFindings", () => {
	it("returns empty array when oldString missing", () => {
		const findings = collectDeletionHygieneDiffFindings({
			oldString: undefined,
			newString: "something",
			filePath: "/tmp/test.ts",
		});
		expect(findings).toEqual([]);
	});

	it("returns empty array when newString missing", () => {
		const findings = collectDeletionHygieneDiffFindings({
			oldString: "something",
			newString: undefined,
			filePath: "/tmp/test.ts",
		});
		expect(findings).toEqual([]);
	});

	it("returns empty when both strings are empty", () => {
		const findings = collectDeletionHygieneDiffFindings({
			oldString: "",
			newString: "",
			filePath: "/tmp/test.ts",
		});
		expect(findings).toEqual([]);
	});

	it("returns array with recognized finding shape when both inputs are present", () => {
		const findings = collectDeletionHygieneDiffFindings({
			oldString: "function realImpl() { return doWork(); }",
			newString: "function realImpl() { /* TODO */ return null; }",
			filePath: "/tmp/test.ts",
		});
		// Findings are Finding[] with check/line/message/source
		expect(Array.isArray(findings)).toBe(true);
		for (const f of findings) {
			expect(typeof f.check).toBe("string");
			expect(typeof f.line).toBe("number");
			expect(typeof f.message).toBe("string");
		}
	});
});
