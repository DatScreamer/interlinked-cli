import { describe, expect, it } from "vitest";
import {
	CODE_FILE_EXT_RE,
	splitCommandSegments,
	splitShellWordsLoose,
	stripOuterQuotes,
} from "./pre-checks-bash-write-shared.js";

describe("shared bash-write parsing primitives", () => {
	it("P1: splitCommandSegments splits on &&, ||, ; and |", () => {
		expect(splitCommandSegments("a b && c d ; e | f")).toEqual(["a b", "c d", "e", "f"]);
	});

	it("P2: splitShellWordsLoose keeps quoted strings as one word", () => {
		expect(splitShellWordsLoose(`sed -i 's/a b/c/' x.ts`)).toEqual(["sed", "-i", "'s/a b/c/'", "x.ts"]);
	});

	it("P3: stripOuterQuotes removes one matched quote pair only", () => {
		expect(stripOuterQuotes("'x y'")).toBe("x y");
		expect(stripOuterQuotes('"x"')).toBe("x");
		expect(stripOuterQuotes("plain")).toBe("plain");
	});

	it("P4: CODE_FILE_EXT_RE matches gated source extensions and not docs", () => {
		expect(CODE_FILE_EXT_RE.test("a.ts")).toBe(true);
		expect(CODE_FILE_EXT_RE.test("a.py")).toBe(true);
		expect(CODE_FILE_EXT_RE.test("a.md")).toBe(false);
	});
});
