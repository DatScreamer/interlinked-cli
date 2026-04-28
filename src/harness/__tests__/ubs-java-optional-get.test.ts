// Tests for `ubs_java_optional_get` (row 29 of Phase-1 Plan 04 phase matrix).
// Java-only detector that flags `Optional<T> ... .get()` without an
// `isPresent()` / `orElse()` guard nearby.

import { describe, expect, it } from "vitest";
import { checkJavaOptionalGet } from "../checks/ubs-language-specific.js";

describe("checkJavaOptionalGet", () => {
	it("flags Optional<String> followed by .get() without a guard", () => {
		const code = [
			"public String find() {",
			"    Optional<String> name = repo.findName();",
			"    return name.get();",
			"}",
		].join("\n");
		const matches = checkJavaOptionalGet(code, "Service.java");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Optional<Foo> followed by .get() in chained call", () => {
		const code = "Optional<Foo> foo = svc.lookup(); Foo unwrapped = foo.get();";
		const matches = checkJavaOptionalGet(code, "Bar.java");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag if `isPresent()` appears before `.get()` (correct usage)", () => {
		const code = [
			"Optional<String> name = repo.findName();",
			"if (name.isPresent()) {",
			"    return name.get();",
			"}",
		].join("\n");
		expect(checkJavaOptionalGet(code, "Service.java")).toEqual([]);
	});

	it("does NOT flag if `orElse(...)` is used (correct usage)", () => {
		const code = "Optional<String> n = repo.find(); return n.orElse(\"default\");";
		expect(checkJavaOptionalGet(code, "Service.java")).toEqual([]);
	});

	it("returns empty for non-Java files (e.g. .ts)", () => {
		const code = "Optional<string> x = lookup(); return x.get();";
		expect(checkJavaOptionalGet(code, "service.ts")).toEqual([]);
	});

	it("returns empty for files with no Optional usage", () => {
		const code = "public String hi() { return \"hi\"; }";
		expect(checkJavaOptionalGet(code, "Hi.java")).toEqual([]);
	});
});
