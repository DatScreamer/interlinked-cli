import { describe, expect, it } from "vitest";
import {
	INLINE_LINK_RE,
	LINK_LABEL_SRC,
	MD_LINK_RE,
	REF_LINK_RE,
} from "./extract-refs-link-grammar.js";

// Direct unit coverage for the shared link grammar. These regexes are also
// exercised through renderInline / extractAnchorLinks in extract-refs.test.ts;
// this file pins the module's exports and their ReDoS bounds on their own.

const reset = (re: RegExp) => {
	re.lastIndex = 0;
	return re;
};

describe("LINK_LABEL_SRC", () => {
	it("is the single shared, escape-aware, total-bounded label source (round-7 #15)", () => {
		// One alternation-unrolled loop bounded at 512 units — no per-segment tail.
		expect(LINK_LABEL_SRC).toContain("{0,512}");
		expect(LINK_LABEL_SRC).toContain("\\\\.");
		// Every link regex is built from it, so they cannot drift.
		for (const re of [INLINE_LINK_RE, REF_LINK_RE, MD_LINK_RE]) {
			expect(re.source).toContain(LINK_LABEL_SRC);
		}
	});
});

describe("INLINE_LINK_RE (renderInline reducer)", () => {
	it("captures the text of a link/image so $1 keeps the rendered label", () => {
		expect("[Install](https://x.com)".replace(reset(INLINE_LINK_RE), "$1")).toBe("Install");
		expect("![alt](a.png)".replace(reset(INLINE_LINK_RE), "$1")).toBe("alt");
		expect("[API](docs/a(b).md)".replace(reset(INLINE_LINK_RE), "$1")).toBe("API");
	});

	it("admits an escaped closing bracket in the label", () => {
		expect("[a\\]b](x.md)".replace(reset(INLINE_LINK_RE), "$1")).toBe("a\\]b");
	});
});

describe("REF_LINK_RE (reference-link reducer)", () => {
	it("captures the text of a reference link", () => {
		expect("[text][ref]".replace(reset(REF_LINK_RE), "$1")).toBe("text");
	});
});

describe("MD_LINK_RE (extractor matcher)", () => {
	it("matches a link and exposes the destination as group 1", () => {
		const m = reset(MD_LINK_RE).exec("see [x](docs/plan.md) here");
		expect(m?.[1]).toBe("docs/plan.md");
	});

	it("rejects an escaped-open bracket (backslash parity — round-6 #21)", () => {
		expect(reset(MD_LINK_RE).exec("\\[x](missing.md)")).toBeNull();
	});

	/**
	 * Catastrophic backtracking shows up as SUPERLINEAR growth, so the honest
	 * assertion is about the growth curve, not a wall-clock number.
	 *
	 * The absolute-millisecond version of this test was flaky: it passed alone at
	 * ~350ms and failed at ~580ms whenever the machine was busy, which says
	 * nothing about the regex. Doubling the input and comparing against the SAME
	 * process's own smaller run cancels machine load out of both sides — an
	 * exponential matcher blows past any ratio bound, a linear one stays near 2x.
	 */
	it("stays linear on the round-7 #20 escape-bomb (growth ratio, not wall clock)", () => {
		const bomb = (reps: number) => `${"[".repeat(512)}\\x`.repeat(reps);
		const timeOf = (input: string): number => {
			const start = performance.now();
			reset(MD_LINK_RE).exec(input);
			return performance.now() - start;
		};
		// Warm the JIT so the first call's compile cost is not read as growth.
		timeOf(bomb(50));
		const small = Math.max(timeOf(bomb(200)), 0.05);
		const double = timeOf(bomb(400));
		// `small` is floored at 0.05 above, so this division is non-zero by construction.
		expect(double / small).toBeLessThan(8);
	});
});
