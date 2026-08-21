import { describe, expect, it } from "vitest";
import { checkRegexFromInterpolation } from "./regex-interpolation.js";

const file = "src/lib/patterns.ts";
const run = (source: string, path = file) => checkRegexFromInterpolation(source, path);

describe("regex_from_interpolation mutation-kill wave (pass1_w26)", () => {
	// test-contract: public-api — commentEnd must search for the closing "*/"
	// starting past the opening delimiter (i+2), so a stray "*/" positioned
	// just before a real "/*" cannot be mistaken for that comment's own close.
	it("does not let a leading stray */ terminate the comment early", () => {
		const source = "const z = a*/* new RegExp(`${user}`) */;";
		expect(run(source)).toHaveLength(0);
	});

	// test-contract: invariant — a zero-substitution template must stay inert
	// even though an empty subs array's `.every(...)` is vacuously true; the
	// subs.length===0 short-circuit must fire before that check is reached.
	it("does not flag a plain template with no substitutions at all", () => {
		expect(run("const re = new RegExp(`plain no subs`);")).toHaveLength(0);
	});
});
