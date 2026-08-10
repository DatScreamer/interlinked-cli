// Smoke tests for the Java / C-family UBS detectors. The exhaustive red/green
// suites live in src/harness/__tests__/ubs-java-optional-get.test.ts and
// ubs-unsafe-format-string.test.ts and exercise these via the
// ubs-language-specific.ts barrel; this colocated file covers the module
// surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkJavaOptionalGet,
	checkUnsafeFormatString,
} from "./java-c-checks.js";

describe("ubs-language-specific/java-c-checks", () => {
	describe("checkJavaOptionalGet", () => {
		it("flags `Optional<T>...get()` without a guard", () => {
			const code = "Optional<String> x = svc.find(); return x.get();";
			expect(checkJavaOptionalGet(code, "Sample.java").length).toBeGreaterThan(0);
		});

		it("does not flag when the same name is guarded earlier", () => {
			const code =
				"Optional<String> x = svc.find();\nif (x.isPresent()) {}\nreturn x.get();";
			expect(checkJavaOptionalGet(code, "Sample.java")).toEqual([]);
		});

		it("returns empty for non-Java files", () => {
			const code = "Optional<string> x = svc.find(); return x.get();";
			expect(checkJavaOptionalGet(code, "sample.ts")).toEqual([]);
		});
	});

	describe("checkUnsafeFormatString", () => {
		it("flags printf with a non-literal format string", () => {
			expect(checkUnsafeFormatString("printf(userFmt);", "a.c").length).toBeGreaterThan(0);
		});

		it("does not flag snprintf with a literal format (size slot skipped)", () => {
			const code = 'snprintf(buf, n, "%s", input);';
			expect(checkUnsafeFormatString(code, "a.c")).toEqual([]);
		});

		it("returns empty for non-C/C++ files", () => {
			expect(checkUnsafeFormatString("printf(fmt);", "a.ts")).toEqual([]);
		});

		// Evidence backfill (Check Evidence Contract) — checkUnsafeFormatString
		// (ubs_unsafe_format_string). Near-misses: a literal format string in
		// the format slot with a variable DATA argument elsewhere — the
		// common, safe shape this detector must not confuse with a
		// non-literal format.
		it("N1: does not fire — literal format with a variable data argument `printf(\"%s\\n\", userName)`", () => {
			const code = 'printf("%s\\n", userName);';
			expect(checkUnsafeFormatString(code, "a.c")).toEqual([]);
		});

		it("N2: does not fire — fprintf with a literal format and a variable data argument", () => {
			const code = 'fprintf(stderr, "error: %d\\n", code);';
			expect(checkUnsafeFormatString(code, "a.c")).toEqual([]);
		});
	});
});
