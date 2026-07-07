import { describe, expect, it } from "vitest";
import { titleCase } from "../src/format.js";

describe("titleCase", () => {
	it("capitalizes each word", () => {
		expect(titleCase("hello world")).toBe("Hello World");
	});

	it("collapses extra whitespace", () => {
		expect(titleCase("  many   spaces ")).toBe("Many Spaces");
	});
});
