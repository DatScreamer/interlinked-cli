import { describe, expect, it } from "vitest";
import { isSpecEligibleFile, siteText } from "./types.js";

describe("isSpecEligibleFile", () => {
	it("accepts markdown family extensions", () => {
		expect(isSpecEligibleFile("docs/design/plan.md")).toBe(true);
		expect(isSpecEligibleFile("README.mdx")).toBe(true);
		expect(isSpecEligibleFile("notes.markdown")).toBe(true);
	});

	it("is case-insensitive on the extension", () => {
		expect(isSpecEligibleFile("PLAN.MD")).toBe(true);
	});

	it("rejects code, config, and extensionless paths", () => {
		expect(isSpecEligibleFile("src/index.ts")).toBe(false);
		expect(isSpecEligibleFile("package.json")).toBe(false);
		expect(isSpecEligibleFile("Makefile")).toBe(false);
		expect(isSpecEligibleFile("dir.md/file")).toBe(false);
	});
});

describe("siteText", () => {
	it("trims surrounding whitespace", () => {
		expect(siteText("   | **B5** | row |  ")).toBe("| **B5** | row |");
	});

	it("caps at 150 chars", () => {
		const long = `x${"y".repeat(400)}`;
		expect(siteText(long)).toHaveLength(150);
	});
});
