import { describe, expect, it } from "vitest";
import { computeObjectPathByLine } from "./software-version-regression-object-path.js";

// Path of the line (1-based) in `content`.
function pathAt(content: string, line: number): string {
	const lines = content.split("\n");
	return computeObjectPathByLine(content, lines.length)[line - 1] ?? "";
}

describe("computeObjectPathByLine", () => {
	it("tracks named JSON keys as parent chains (lockfile shape)", () => {
		const content = [
			"{",
			'  "packages": {',
			'    "node_modules/lodash": {',
			'      "version": "1.0.0"',
			"    }",
			"  }",
			"}",
		].join("\n");
		expect(pathAt(content, 4)).toBe("{}.packages.node_modules/lodash");
	});

	it("names anonymous scopes after the enclosing call and its title argument", () => {
		const content = [
			'it("flags downgrade", () => {',
			'  expect(x).toEqual({ version: "4.17.21" });',
			"});",
			'it("accepts pin", () => {',
			'  expect(x).toEqual({ version: "1.0.0" });',
			"});",
		].join("\n");
		// Sibling it()-blocks at equal depth must NOT collapse to one path.
		expect(pathAt(content, 2)).toBe("it:flags downgrade");
		expect(pathAt(content, 5)).toBe("it:accepts pin");
		expect(pathAt(content, 2)).not.toBe(pathAt(content, 5));
	});

	it("names function bodies after the function (fn: segment)", () => {
		const content = [
			"function seedDemo() {",
			'  return { sdkVersion: "3.0.0" };',
			"}",
			"function seedLegacy() {",
			'  return { sdkVersion: "1.0.0" };',
			"}",
		].join("\n");
		expect(pathAt(content, 2)).toBe("fn:seedDemo");
		expect(pathAt(content, 5)).toBe("fn:seedLegacy");
	});

	it("names assignment object literals after the assigned identifier", () => {
		const content = [
			"const current = {",
			'  sdkVersion: "5.0.0",',
			"};",
			"const legacy = {",
			'  sdkVersion: "2.0.0",',
			"};",
		].join("\n");
		expect(pathAt(content, 2)).toBe("id:current");
		expect(pathAt(content, 5)).toBe("id:legacy");
	});

	it("disambiguates truly anonymous same-name siblings with an occurrence counter", () => {
		const content = [
			"registry.push({",
			'  sdkVersion: "5.0.0",',
			"});",
			"registry.push({",
			'  sdkVersion: "2.0.0",',
			"});",
		].join("\n");
		expect(pathAt(content, 2)).toBe("fn:push");
		expect(pathAt(content, 5)).toBe("fn:push#1");
	});

	it("keeps unquoted object keys as named segments", () => {
		const content = ["const cfg = {", "  engine: {", '    version: "2.0.0",', "  },", "};"].join(
			"\n",
		);
		expect(pathAt(content, 3)).toBe("id:cfg.engine");
	});

	it("sanitizes `#` out of literal segments so the counter grammar stays reserved", () => {
		const content = ['describe("bug #1", () => {', '  const v = { version: "1.0.0" };', "});"].join(
			"\n",
		);
		expect(pathAt(content, 2)).toBe("describe:bug ~1");
		expect(pathAt(content, 2)).not.toMatch(/#\d/);
	});

	it("does not let a string literal from earlier code name a later call scope", () => {
		const content = ['const label = "v9.9.9";', "function build() {", '  return { version: "1.0.0" };', "}"].join(
			"\n",
		);
		// `build(`'s open-paren clears the stale literal — fn:, not build:v9.9.9.
		expect(pathAt(content, 3)).toBe("fn:build");
	});
});
